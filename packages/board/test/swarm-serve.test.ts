import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AttentionDraft, AttentionView, MessageView } from '../src/api/routes.ts'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { swarmOptions } from '../src/cli/swarm.ts'
import { VERSION } from '../src/version.ts'
import { bearer, board, BOARD_URL, caller, localUserToken, PROJECT_ID, TEAM_ID, testLocal } from './harness.ts'

const OWNER = 'local:user:ada'
const CHANNEL = 'fresh/work'
const COMMIT = 'a'.repeat(40)
const ANSWER = { option: 'go', commit: COMMIT }
const BASE = {
  version: VERSION, url: BOARD_URL, audience: BOARD_URL, team_id: TEAM_ID,
  project_id: PROJECT_ID, sync: [], task_authority: true,
}
const SWARM = {
  politburo: 1, task_authority: true, task_attention: true, agent_ops: true, agent_intents: true,
}

function draft({ id, revision }: MessageView): AttentionDraft {
  return {
    kind: 'awaiting_approval', question: 'Ship it?', context: '',
    evidence: [{ message: id, revision }], revision, commit: COMMIT,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    options: [
      { id: 'go', label: 'Ship', consequence: 'Release the build', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Keep the build', next: 'fail' },
    ],
  }
}

async function setup(cleanup: (close: () => Promise<void>) => void, options: Parameters<typeof swarmOptions>[0]) {
  const backend = local({ memory: true, ...swarmOptions(options, OWNER) })
  cleanup(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const token = await localUserToken('ada')
  const send: typeof fetch = async (input, init) => team.fetch(new Request(input, init))
  const via = (transport: typeof fetch) => board({ backend: http(BOARD_URL, { fetch: transport }) }).as(null)
  const owner = via(bearer(send, token))
  return { team, token, owner, send, via }
}

it('lets only the verified local owner with post access answer in a new channel', async ({ onTestFinished }) => {
  const { team, token, owner, send, via } = await setup(onTestFinished, { swarm: true })
  const { task } = await owner.tasks.create(CHANNEL, 'Release the build')
  const { attention } = await owner.tasks.ask(task.id, draft(task))
  expect(attention.status).toBe('pending')

  const { secret } = await owner.createInvite({ name: 'sam', can: { [CHANNEL]: ['read', 'post'] } })
  const joined = await via(send).join(secret)
  const member = via(bearer(send, joined.token))
  expect((await member.tasks.attention(task.id)).attention?.id).toBe(attention.id)
  expect((await member.post(CHANNEL, 'I can post here')).by.principal).toBe(joined.principal)
  await expect(member.tasks.answer(task.id, attention.id, ANSWER))
    .rejects.toMatchObject({ status: 403, code: 'forbidden' })

  const path = `/tasks/${task.id}/attention/${attention.id}/answer`
  const readOnly = caller(team.fetch, token, { 'x-board-can': `${CHANNEL}=read` })
  expect(await readOnly('POST', path, ANSWER))
    .toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
  await expect(owner.as('worker').tasks.answer(task.id, attention.id, ANSWER))
    .rejects.toMatchObject({ status: 403, code: 'forbidden' })

  expect(await owner.tasks.answer(task.id, attention.id, ANSWER)).toMatchObject({
    task: { task: { state: 'ready' } },
    attention: { status: 'answered', receipt: { by: { principal: OWNER }, option: 'go' } },
  })
})

it('advertises the swarm version and serves agent registry writes and reads', async ({ onTestFinished }) => {
  const { team, owner } = await setup(onTestFinished, { swarm: true })
  const discovery = await team.fetch(new Request(BOARD_URL))
  expect.soft(await discovery.json()).toEqual({ ...BASE, ...SWARM })
  const config = { channel: CHANNEL, role: 'implementation-worker', harness: 'shell' } as const
  const registered = await owner.agents.register(config)
  expect(await owner.agents.list(CHANNEL)).toMatchObject({ agents: [config] })
  expect(registered).toMatchObject({ binding: { principal: OWNER } })
})

it('keeps default discovery bytes and refuses attention and agent ops without the flag', async ({ onTestFinished }) => {
  const { team, token, owner } = await setup(onTestFinished, {})
  const discovery = await team.fetch(new Request(BOARD_URL))
  expect.soft(await discovery.text()).toBe(JSON.stringify(BASE))
  const { task } = await owner.tasks.create(CHANNEL, 'Release the build')
  const call = caller(team.fetch, token)
  expect.soft(await call('POST', `/tasks/${task.id}/attention/${task.id}/answer`, ANSWER))
    .toMatchObject({ status: 501, body: { error: { code: 'no_task_attention' } } })
  expect.soft(await call('GET', `/ops/agents?channel=${CHANNEL}`))
    .toMatchObject({ status: 501, body: { error: { code: 'no_agent_ops' } } })
})

it('keeps standalone agent ops independent of swarm mode', async ({ onTestFinished }) => {
  const { team, owner } = await setup(onTestFinished, { agentOps: true })
  const discovery = await team.fetch(new Request(BOARD_URL))
  expect(await discovery.json()).toEqual({ ...BASE, agent_ops: true, agent_intents: true })
  expect(await owner.agents.list(CHANNEL)).toEqual({ agents: [] })
})

const CLI = join(import.meta.dirname, '../src/cli/bin.ts')

async function cliHome(cleanup: (close: () => Promise<void>) => void) {
  const home = await mkdtemp(join(tmpdir(), 'swarm-serve-'))
  cleanup(() => rm(home, { recursive: true, force: true }))
  const options = { cwd: home, env: { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home } }
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { ...options, timeout: 12_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else reject(new Error('vb did not exit normally'))
    })
  })
  return { home, options, run }
}

async function cliServe(cleanup: (close: () => Promise<void>) => void, ...flags: string[]) {
  const { home, options, run } = await cliHome(cleanup)
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--no-inspect', '--dir', join(home, 'data'), ...flags], {
    ...options, stdio: ['ignore', 'pipe', 'ignore'], timeout: 35_000, killSignal: 'SIGKILL',
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.on('error', () => {})
  cleanup(async () => {
    child.kill('SIGTERM')
    await closed
  })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  const [, url, principal] = await vi.waitFor(() => {
    const line = /^serving a local board at (http:\/\/127\.0\.0\.1:\d+\/api\/board) as (local:user:[\w.-]+),/m.exec(stdout)
    if (!line) throw new Error('vb serve did not announce its URL and principal')
    return line
  }, { timeout: 12_000 })
  const cli = (...args: string[]) => run(...args, '--url', url!, '--json')
  return { home, url: url!, principal, cli }
}

it('serves swarm discovery and answers attention as the identity printed by vb serve', async ({ onTestFinished }) => {
  const { home, url, principal, cli } = await cliServe(onTestFinished, '--swarm')
  const discovery = await fetch(url)
  expect.soft(await discovery.json()).toMatchObject(SWARM)

  const created = await cli('tasks', 'create', CHANNEL, 'Release the build')
  expect(created.code).toBe(0)
  const { task } = JSON.parse(created.stdout) as { task: MessageView }
  const file = join(home, 'attention.json')
  await writeFile(file, JSON.stringify(draft(task)))
  const asked = await cli('tasks', 'ask', task.id, '--file', file)
  expect(asked.code).toBe(0)
  const { attention } = JSON.parse(asked.stdout) as { attention: AttentionView }
  const answered = await cli('tasks', 'answer', task.id, attention.id, 'go', '--commit', COMMIT)
  expect(answered.code).toBe(0)
  expect(JSON.parse(answered.stdout)).toMatchObject({
    attention: { status: 'answered', receipt: { by: { principal }, option: 'go' } },
  })
}, 30_000)

it('keeps swarm off when vb serve omits --swarm', async ({ onTestFinished }) => {
  const { url, cli } = await cliServe(onTestFinished)
  const discovery = await fetch(url)
  expect(discovery.status).toBe(200)
  const capabilities = await discovery.json()
  for (const key of ['politburo', 'agent_ops', 'task_attention']) {
    expect.soft(capabilities).not.toHaveProperty(key)
  }

  const created = await cli('tasks', 'create', CHANNEL, 'Release the build')
  expect(created.code).toBe(0)
  const { task } = JSON.parse(created.stdout) as { task: MessageView }
  const answered = await cli('tasks', 'answer', task.id, task.id, 'go', '--commit', COMMIT)
  expect(answered.code).toBe(1)
  expect(JSON.parse(answered.stderr)).toMatchObject({ data: { error: { status: 501, code: 'no_task_attention' } } })
}, 30_000)

it('lists --swarm in vb serve help', async ({ onTestFinished }) => {
  const { run } = await cliHome(onTestFinished)
  const help = await run('serve', '--help')
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('--swarm')
}, 15_000)

it('refuses --swarm with --team-tokens before reading the token file', async ({ onTestFinished }) => {
  const { home, run } = await cliHome(onTestFinished)
  const result = await run('serve', '--swarm', '--team-tokens', join(home, 'absent.json'), '--json')
  expect(result).toMatchObject({ code: 2, stdout: '' })
  expect(JSON.parse(result.stderr)).toEqual({
    status: 'error', reason: 'invalid_arguments', message: "--swarm can't be used with --team-tokens.",
  })
}, 15_000)
