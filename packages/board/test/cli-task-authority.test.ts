import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localBoard, personToken } from './harness.ts'
import { serve } from './http.ts'

const CLI = join(import.meta.dirname, '../src/cli/bin.ts')
const ADA = 'vercel:user:u_ada'
const commit = 'a'.repeat(40)
const path = 'handoffs/review.md'
const hash = 'b'.repeat(64)
const binding = {
  owner: { principal: ADA, actor: `${ADA}+worker` },
  controller: { principal: ADA, actor: ADA },
  provider: 'fixture-provider', model: 'fixture-model', session: 'session-1', branch: 'topic/review', worktree: '/fixture/review', baseCommit: commit,
}

type Result = { code: number; stdout: string; stderr: string }
function json(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('expected exactly one JSON document from vb')
  }
}

async function authority(run: (vb: (args: string[]) => Promise<Result>, proofs: Set<string>) => Promise<void>) {
  const tmp = await mkdtemp(join(tmpdir(), 'board-cli-authority-'))
  const board = localBoard({ url: undefined })
  // Observe the proof that subsequent CLI processes send. Neither requests nor responses are changed.
  const proofs = new Set<string>()
  const server = await serve(async (request) => {
    if (request.method === 'POST' && /\/tasks\/[^/]+\/handoff$/.test(new URL(request.url).pathname)) {
      const body = await request.clone().json()
      if (typeof body.token === 'string') proofs.add(body.token)
    }
    return board.fetch(request)
  })
  try {
    const url = `${server.origin}/api/board`
    const jwt = await personToken('u_ada', url)
    const env = { BOARD_URL: url, BOARD_TOKEN: jwt, HOME: tmp, XDG_CONFIG_HOME: tmp }
    const vb = (args: string[]) => new Promise<Result>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        // Do not let a regression put a JWT in assertion diagnostics.
        if (stdout.includes(jwt) || stderr.includes(jwt)) reject(new Error('vb printed the board credential'))
        else resolve({ code: code ?? -1, stdout, stderr })
      })
    })
    await run(vb, proofs)
  } finally {
    await server.close()
    await board.close()
    await rm(tmp, { recursive: true, force: true })
  }
}

function success(result: Result) {
  expect(result.code).toBe(0)
  expect(result.stderr === '', 'successful command should not write stderr').toBe(true)
  return json(result.stdout)
}

function failure(result: Result, code: number, reason: string) {
  expect(result.code).toBe(code)
  expect(result.stdout === '', 'failed command should not write stdout').toBe(true)
  expect(json(result.stderr).reason).toBe(reason)
}

it('uses a saved assignment claim across CLI processes, refuses a profile operator, and reports a revoked proof without printing it', async () => {
  await authority(async (vb, proofs) => {
    const run = (...args: string[]) => vb(['tasks', ...args, '--json'])
    const id = success(await run('create', 'work', 'review a release')).task.id as string
    failure(await run('claim', id, '--as', 'worker', '--binding', '{'), 2, 'invalid_binding')
    const claimed = await run('claim', '--ready', 'work', '--as', 'worker', '--binding', JSON.stringify(binding))
    const shown = success(claimed)
    expect(shown.task.id).toBe(id)
    expect(shown.task.task.claim.binding).toEqual(binding)
    expect(Object.keys(shown.claim).sort()).toEqual(['epoch', 'until'])

    failure(await run('handoff', id, commit, path, hash, '--as', 'other'), 1, 'claim_not_held')
    const published = await run('handoff', id, commit, path, hash, '--as', 'worker')
    const first = success(published)
    expect(first.outcome).toBe('handed_off')
    const handoff = first.task.task.handoff
    expect(handoff).toMatchObject({ commit, packetPath: path, sha256: hash, generation: shown.claim.epoch, by: { actor: `${ADA}+worker` } })
    const superseded = await run('handoff', id, 'c'.repeat(40), path, hash, '--as', 'worker', '--supersedes', handoff.id)
    const latest = success(superseded).task.task.handoff
    expect(latest.supersedes).toBe(handoff.id)
    expect(latest.id).not.toBe(handoff.id)

    const reason = 'wait for the deployment window'
    const parked = await run('park', id, reason)
    const park = success(parked)
    expect(park.outcome).toBe('parked')
    expect(park.task.task.parked).toMatchObject({ reason, by: { actor: ADA, profile: null }, previous: 'claimed' })
    failure(await run('unpark', id, 'resume', '--as', 'worker'), 1, 'permission_denied')
    const unparked = await vb(['tasks', 'unpark', id, 'deployment window is open'])
    expect(unparked.code).toBe(0)
    expect(unparked.stdout.trim() === `unparked ${id}`, 'text output should confirm which task was unparked').toBe(true)
    const stale = await run('handoff', id, commit, path, hash, '--as', 'worker', '--supersedes', latest.id)
    failure(stale, 1, 'claim_lost')
    const read = await vb(['read', id, '--json'])
    expect(success(read).message.task.state).toBe('ready')
    expect(proofs.size, 'the CLI should send the one saved proof only for the claimant').toBe(1)
    const [proof] = proofs
    for (const result of [claimed, published, superseded, parked, unparked, stale, read]) {
      expect(result.stdout.includes(proof!) || result.stderr.includes(proof!), 'vb printed a claim token').toBe(false)
    }
  })
}, 45_000)
