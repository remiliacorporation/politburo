import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { beforeEach, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { local } from '../src/backend-local/index.ts'
import { claimsDir, fileClaims, type HeldClaim } from '../src/cli/claims.ts'
import { vb } from './cli-harness.ts'
import { create, ok } from './cli-tasks-harness.ts'
import { board, BOARD_URL, personToken, testAuth } from './harness.ts'
import { serve } from './http.ts'

// Use the real filesystem, pausing its calls to interleave readers and writers.
vi.mock(import('node:fs/promises'), async (original) => ({ ...(await original()) }))

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'board-claims-'))
  vi.stubEnv('XDG_CONFIG_HOME', home)
  return async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(home, { recursive: true, force: true })
  }
})

const heldClaim = (epoch: number): HeldClaim => ({
  epoch, token: `claim-${epoch}`, until: new Date(Date.now() + 60_000).toISOString(),
})

it('saves the first claim in a fresh config directory with private permissions', async () => {
  const store = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const claim = heldClaim(1)

  await store.put(id, claim)
  expect(await store.get(id)).toEqual(claim)
  expect((await fs.stat(claimsDir())).mode & 0o777).toBe(0o700)
  const [name] = await fs.readdir(claimsDir())
  expect((await fs.stat(join(claimsDir(), name!))).mode & 0o777).toBe(0o600)
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
    let put: Promise<void> | undefined
    const readFile = fs.readFile
    const paused = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
      // Start the replacement during the drop without waiting inside its lock.
      const data = await readFile(...args)
      put = other.put(id, replacement)
      return data
    })
    try {
      await store.drop(id, first)
      await put
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

it.each([false, true])('keeps the claim visible until removal (proof matches: %s)', async (matches) => {
  const store = fileClaims(async () => BOARD_URL, null)
  const reader = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const claim = heldClaim(2)
  await store.put(id, claim)
  const [name] = await fs.readdir(claimsDir())
  const file = join(claimsDir(), name!)

  const seen: { step: string; claim: HeldClaim | null; removed: boolean }[] = []
  let reading = false
  let readProof = false
  let removed = false
  const sample = async (step: string) => {
    reading = true
    try {
      if (matches && readProof) removed ||= !(await fs.stat(file).catch(() => null))
      seen.push({ step, claim: await reader.get(id), removed })
    } finally {
      reading = false
    }
  }
  const observe = <Args extends unknown[], T>(name: string, call: (...args: Args) => Promise<T>) => async (...args: Args) => {
    if (reading) return call(...args)
    await sample(`before ${name}`)
    const result = await call(...args)
    await sample(`after ${name}`)
    // Until these bytes reach drop, it can't know whether the proof matched.
    if (name === 'readFile') readProof = true
    return result
  }
  const { mkdir, rename, readFile, link, rmdir, unlink } = fs
  vi.spyOn(fs, 'mkdir').mockImplementation(observe('mkdir', mkdir))
  vi.spyOn(fs, 'rename').mockImplementation(observe('rename', rename))
  vi.spyOn(fs, 'readFile').mockImplementation(observe('readFile', readFile))
  vi.spyOn(fs, 'link').mockImplementation(observe('link', link))
  vi.spyOn(fs, 'rmdir').mockImplementation(observe('rmdir', rmdir))
  vi.spyOn(fs, 'unlink').mockImplementation(observe('unlink', unlink))

  await store.drop(id, matches ? claim : heldClaim(1))
  vi.restoreAllMocks()
  for (const point of seen) {
    expect(point.claim, point.step).toEqual(matches && point.removed ? null : claim)
  }
  expect(await reader.get(id)).toEqual(matches ? null : claim)
})

it('keeps a concurrent replacement when a matching drop has read the old claim', async () => {
  const store = fileClaims(async () => BOARD_URL, null)
  const other = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const first = heldClaim(1)
  const replacement = heldClaim(2)
  await store.put(id, first)

  const readFile = fs.readFile
  const rename = fs.rename
  let put: Promise<void> | undefined
  let visible: HeldClaim | null | undefined
  vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
    const bytes = await readFile(...args)
    const proceed = Promise.withResolvers<void>()
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...paths) => {
      await proceed.promise
      await rename(...paths)
    })
    put = other.put(id, replacement)
    try {
      visible = await other.get(id)
    } finally {
      proceed.resolve()
    }
    // Let the writer try to publish before the drop acts on its read. Do not
    // wait indefinitely for a writer that has to wait for the drop in turn.
    await Promise.race([put, delay(100)])
    return bytes
  })

  await store.drop(id, first)
  await put
  expect(await other.get(id)).toEqual(replacement)
  expect(visible).toEqual(first)
})

it('keeps a replacement put while a matching drop is about to unlink', async () => {
  const store = fileClaims(async () => BOARD_URL, null)
  const other = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const first = heldClaim(1)
  const replacement = heldClaim(2)
  // Set up the directory independently so this test only exercises the race.
  await fs.mkdir(claimsDir(), { recursive: true, mode: 0o700 })
  await store.put(id, first)

  const unlink = fs.unlink
  let put: Promise<void> | undefined
  vi.spyOn(fs, 'unlink').mockImplementationOnce(async (path) => {
    put = other.put(id, replacement)
    // An unlocked put can finish before the unlink; a locked one waits for it.
    await Promise.race([put, delay(200)])
    await unlink(path)
  })

  await store.drop(id, first)
  await put
  expect(await other.get(id)).toEqual(replacement)
})

it('keeps a replacement saved while pruning an expired claim', async () => {
  const store = fileClaims(async () => BOARD_URL, null)
  const other = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 2 * 24 * 60 * 60_000)
  await store.put(id, heldClaim(1))
  clock.mockRestore()
  const [name] = await fs.readdir(claimsDir())
  const file = join(claimsDir(), name!)
  const replacement = heldClaim(2)

  const readFile = fs.readFile
  let replace = true
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    const bytes = await readFile(...args)
    if (replace && args[0] === file) {
      replace = false
      await other.put(id, replacement)
    }
    return bytes
  })
  await store.put('813', heldClaim(1))
  expect(await store.get(id)).toEqual(replacement)
})

it.each(['put', 'drop'] as const)('waits on a fresh live-PID marker but recovers once it is old (%s)', async (mutation) => {
  const store = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const first = heldClaim(1)
  const next = heldClaim(2)
  await store.put(id, first)

  // Simulate a leftover lock whose PID has been reused, without crashing a writer.
  const [name] = await fs.readdir(claimsDir())
  const marker = join(claimsDir(), `${name}.lock`, `${process.pid}.${randomUUID()}`)
  await fs.mkdir(marker, { recursive: true })
  const update = mutation === 'put' ? store.put(id, next) : store.drop(id, first)
  try {
    expect(await Promise.race([update.then(() => 'updated'), delay(100, 'waiting')])).toBe('waiting')
    expect(await store.get(id)).toEqual(first)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(marker, old, old)
    await update
    expect(await store.get(id)).toEqual(mutation === 'put' ? next : null)
  } finally {
    await fs.rm(marker, { recursive: true, force: true })
    await update.catch(() => {})
  }
}, 8_000)

it.each([false, true])('recovers after a drop process is killed (proof matches: %s)', async (matches) => {
  const store = fileClaims(async () => BOARD_URL, null)
  const id = '812'
  const newer = heldClaim(2)
  await store.put(id, newer)

  const module = new URL('../src/cli/claims.ts', import.meta.url).href
  const script = `
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const kill = () => process.kill(process.pid, 'SIGKILL')
    if (${matches}) {
      fs.unlink = kill // after the comparison, before removal
    } else {
      const readFile = fs.readFile
      fs.readFile = async (...args) => {
        await readFile(...args)
        kill() // the newer proof was read, but drop has not acted on it
      }
    }
    syncBuiltinESMExports()
    const { fileClaims } = await import(${JSON.stringify(module)})
    const claims = fileClaims(async () => ${JSON.stringify(BOARD_URL)}, null)
    await claims.drop(${JSON.stringify(id)}, ${JSON.stringify(matches ? newer : heldClaim(1))})
  `
  await expect(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { XDG_CONFIG_HOME: home }, timeout: 5_000,
  })).rejects.toMatchObject({ signal: 'SIGKILL' })

  expect.soft(await store.get(id)).toEqual(newer)
  await store.drop(id, newer)
  expect(await store.get(id)).toBeNull()
  expect(await fs.readdir(claimsDir())).toEqual([])
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
