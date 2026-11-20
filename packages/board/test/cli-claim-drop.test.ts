import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { local } from '../src/backend-local/index.ts'
import { claimsDir, fileClaims, type HeldClaim } from '../src/cli/claims.ts'
import { vb } from './cli-harness.ts'
import { create, ok } from './cli-tasks-harness.ts'
import { board, BOARD_URL, personToken, testAuth } from './harness.ts'
import { serve } from './http.ts'

// Use the real filesystem, with a read we can pause to put another claim.
vi.mock(import('node:fs/promises'), async (original) => ({ ...(await original()) }))

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'board-claims-'))
  vi.stubEnv('XDG_CONFIG_HOME', home)
  return async () => {
    vi.unstubAllEnvs()
    await fs.rm(home, { recursive: true, force: true })
  }
})

it('drops only a matching claim and keeps a replacement put during drop', async () => {
  const store = fileClaims(async () => BOARD_URL, null)
  const other = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const first = { epoch: 1, token: 'first-claim', until: new Date(Date.now() + 60_000).toISOString() }
  const second = { ...first, epoch: 2, token: 'second-claim' }
  const third = { ...first, epoch: 3, token: 'third-claim' }
  await store.put(id, first)
  const [file] = await fs.readdir(claimsDir())

  if (false) {
    // @ts-expect-error drop requires the epoch and token of the claim to forget
    await store.drop(id)
  }

  const raceDrop = async (replacement: HeldClaim) => {
    const readFile = fs.readFile
    const paused = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
      // The drop reads the old bytes, but the other writer finishes before it can act on them.
      const data = await readFile(...args)
      await other.put(id, replacement)
      return data
    })
    try {
      await store.drop(id, first)
    } finally {
      paused.mockRestore()
    }
  }

  await raceDrop(second)
  expect(await other.get(id)).toEqual(second)
  // A mismatch must not write the claim it found back over a concurrent replacement either.
  await raceDrop(third)
  expect(await other.get(id)).toEqual(third)

  await store.drop(id, { epoch: second.epoch, token: third.token })
  expect(await other.get(id)).toEqual(third)
  await store.drop(id, { epoch: third.epoch, token: second.token })
  expect(await other.get(id)).toEqual(third)
  await store.drop(id, third)
  expect(await other.get(id)).toBeNull()
  expect(await fs.readdir(claimsDir())).not.toContain(file)
})

it('releases staged work on command failure without deleting a replacement claim', async ({ onTestFinished }) => {
  const backend = local({ memory: true, workLifecycle: { scopers: ['vercel:user:u_julian'] } })
  const server = await serve((request) => team.fetch(request))
  const url = `${server.origin}/api/board`
  const team = board({ backend, url, authenticate: oidcTokens(testAuth) })
  onTestFinished(async () => {
    await server.close()
    await backend.close()
  })
  const env = { BOARD_URL: url, BOARD_TOKEN: await personToken('u_julian', url), HOME: home, XDG_CONFIG_HOME: home }
  const id = await create('work', 'try the job', [], env)
  await ok(['tasks', 'scope', id, 'ready to start'], env)
  const store = fileClaims(async () => url, null)
  const run = async (script: string) => {
    const failed = await vb(['tasks', 'run', id, '--json', '--', process.execPath, '--input-type=module', '-e', script], env)
    expect(failed).toMatchObject({ code: 7, stderr: '' })
    expect(JSON.parse(failed.stdout)).toMatchObject({
      outcome: 'released', code: 7, task: { id, task: { state: 'ready', claim: null, work: { stage: 'scoped' } } },
    })
  }

  await run('process.exitCode = 7')
  expect(await store.get(id)).toBeNull()

  // The child starts after vb has saved its proof and replaces the file before vb settles.
  const replacement = { epoch: 3, token: 'replacement-claim', until: new Date(Date.now() + 60_000).toISOString() }
  await run(`
    import { fileClaims } from ${JSON.stringify(new URL('../src/cli/claims.ts', import.meta.url).href)}
    const other = fileClaims(async () => process.env.BOARD_URL, null)
    await other.put(process.env.BOARD_TASK, ${JSON.stringify(replacement)})
    process.exitCode = 7
  `)
  expect(await store.get(id)).toEqual(replacement)
})
