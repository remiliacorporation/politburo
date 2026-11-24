import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import * as fixtureFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aroundEach, expect, it, vi } from 'vitest'
import { fileClaims } from '../../src/cli/claims.ts'
import { START } from './clock.ts'
import { checkSavedClaim } from './oracles.ts'
import { checkSeeds } from './seeds.ts'
import { Sim } from './sim.ts'

const task = '1'
const open = () => fileClaims(async () => 'http://board.test/api/board', 'worker')
const proofA = { epoch: 1, token: 'fixture-a', until: new Date(START + 30_000).toISOString() }
const proofB = { ...proofA, epoch: 2, token: 'fixture-b' }
// Main ignores the second argument; the held PRs compare its proof.
const drop = (claims: ReturnType<typeof open>) => (claims.drop as (id: string, proof: typeof proofA) => Promise<void>)(task, proofA)

let killNext = false
let lockOwner: number | undefined
let lockReleased = Promise.withResolvers<void>()
const TEARDOWN_MS = 2_000
type InFlight = { label: string; pending: Promise<unknown> }
const claimsFixture = new AsyncLocalStorage<{ closed: boolean; inFlight: Set<InFlight> }>()
const testSignal = new AsyncLocalStorage<AbortSignal>()
aroundEach((run, { signal }) => testSignal.run(signal, run))

async function fsStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  // The actor retains its scheduler even after the fixture starts tearing down.
  const sim = Sim.current
  if (sim) {
    await sim.gate(`fs:${label}`)
    if (killNext) return sim.kill()
  }
  const fixture = claimsFixture.getStore()
  if (!fixture) return run()
  if (fixture.closed) throw new Error('DST claims fixture is closed')
  const call = { label, pending: run() }
  fixture.inFlight.add(call)
  try { return await call.pending } finally { fixture.inFlight.delete(call) }
}

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const wrap = <A extends unknown[], R>(label: string, call: (...args: A) => Promise<R>) =>
    (...args: A) => fsStep(label, () => call(...args))
  return {
    ...fs,
    mkdir: wrap('mkdir', fs.mkdir),
    readFile: wrap('readFile', fs.readFile),
    readdir: (dir: string) => fsStep('readdir', async () => (await fs.readdir(dir)).sort()),
    stat: (path: string) => fsStep('stat', async () => {
      const info = await fs.stat(path)
      const now = Date.now()
      return Object.assign(info, { mtimeMs: now, ctimeMs: now })
    }),
    writeFile: wrap('writeFile', fs.writeFile),
    unlink: wrap('unlink', fs.unlink),
    link: wrap('link', fs.link),
    rename: (from: string, to: string) => {
      const kind = to.endsWith('.lock') ? 'lock' : to.endsWith('.drop') ? 'tombstone' : 'claim'
      return fsStep(`rename:${kind}`, async () => {
        await fs.rename(from, to)
        if (kind === 'lock') lockOwner = Sim.current?.op
      })
    },
    rmdir: (dir: string) => fsStep('rmdir', async () => {
      await fs.rmdir(dir)
      if (dir.endsWith('.lock')) {
        lockOwner = undefined
        lockReleased.resolve()
        lockReleased = Promise.withResolvers<void>()
      }
    }),
  }
})

vi.mock('node:timers/promises', async (original) => {
  const timers = await original<typeof import('node:timers/promises')>()
  return {
    ...timers,
    async setTimeout(ms: number) {
      const sim = Sim.current
      if (!sim) return timers.setTimeout(ms)
      // The lock's retry timer cannot make progress until the other actor removes
      // the lock. Wait for that change instead of racing a real polling interval.
      sim.trace.push(`${sim.op} waiting for claim lock`)
      if (lockOwner === undefined) return
      sim.block()
      try { await lockReleased.promise } finally { sim.unblock() }
    },
  }
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function installClaimClock() {
  const clock = globalThis.performance
  const previous = Object.getOwnPropertyDescriptor(clock, 'now')
  const hostNow = clock.now.bind(clock)
  Object.defineProperty(clock, 'now', {
    configurable: true,
    value: () => Sim.current?.elapsedMs ?? hostNow(),
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  return () => {
    vi.useRealTimers()
    if (previous) Object.defineProperty(clock, 'now', previous)
    else Reflect.deleteProperty(clock, 'now')
  }
}

async function beforeDeadline(pending: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function withClaims<T>(run: (dir: string) => Promise<T>, { drainMs = TEARDOWN_MS, removeMs = TEARDOWN_MS, signal = testSignal.getStore()! } = {}) {
  const dir = await fixtureFs.mkdtemp(join(tmpdir(), 'board-dst-claims-'))
  const fixture = { closed: false, inFlight: new Set<InFlight>() }
  let restore = () => {}
  let originalFailure: ErrorOptions | undefined
  try {
    signal.throwIfAborted()
    const configHome = process.env.XDG_CONFIG_HOME
    const restoreClock = installClaimClock()
    process.env.XDG_CONFIG_HOME = dir
    lockReleased = Promise.withResolvers<void>()
    restore = () => {
      if (fixture.closed) return
      fixture.closed = true
      killNext = false
      lockOwner = undefined
      restoreClock()
      restoreEnv('XDG_CONFIG_HOME', configHome)
    }
    // Vitest aborts on timeout even if the test's promise never settles.
    signal.addEventListener('abort', restore, { once: true })
    return await claimsFixture.run(fixture, async () => {
      await open().put(task, proofA)
      signal.throwIfAborted()
      return run(dir)
    })
  } catch (error) {
    originalFailure = { cause: error }
    throw error
  } finally {
    signal.removeEventListener('abort', restore)
    restore()
    if (fixture.inFlight.size) {
      await beforeDeadline(Promise.allSettled(Array.from(fixture.inFlight, ({ pending }) => pending)), drainMs)
    }
    const stuck = [...fixture.inFlight]

    const remove = () => fixtureFs.rm(dir, { recursive: true, force: true })
    // An already-started call can recreate the directory after the first rm.
    for (const { pending } of stuck) void pending.then(remove, remove).catch(() => {})
    const timedOut = stuck.map(({ label }) => label)
    try {
      if (!await beforeDeadline(remove(), removeMs)) timedOut.push('rm')
    } finally {
      if (timedOut.length) throw new Error(`DST claims teardown timed out waiting for: ${timedOut.join(', ')}`, originalFailure)
    }
  }
}

it('restores claims globals on abort before the fixture I/O finishes', async ({ signal }) => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const configHome = process.env.XDG_CONFIG_HOME
  const hostNow = performance.now
  const pending = withClaims(async (dir) => {
    expect(process.env.XDG_CONFIG_HOME === dir).toBe(true)
    expect(performance.now).not.toBe(hostNow)
    await fsStep('blocked write', async () => {
      started.resolve()
      await release.promise
    })
  }, { signal: AbortSignal.any([signal, controller.signal]) })
  try {
    await Promise.race([started.promise, pending])
    controller.abort()
    expect(performance.now === hostNow, 'performance.now was not restored').toBe(true)
    expect(process.env.XDG_CONFIG_HOME === configHome, 'XDG_CONFIG_HOME was not restored').toBe(true)
  } finally {
    release.resolve()
    await pending
  }
})

it('bounds claims teardown for a stuck fs call and restores the fixture', async ({ onTestFinished }) => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const configHome = process.env.XDG_CONFIG_HOME
  const operationError = new Error('fixture operation failed')
  let dir!: string
  // Keep even a timing-out regression isolated from subsequent tests.
  onTestFinished(async () => {
    restoreEnv('XDG_CONFIG_HOME', configHome)
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  await expect(withClaims(async (path) => {
    dir = path
    void fsStep('never-settling write', () => new Promise<never>(() => {}))
    throw operationError
  }, { drainMs: 20 })).rejects.toMatchObject({
    message: expect.stringContaining('never-settling write'),
    cause: operationError,
  })
  expect(process.env.XDG_CONFIG_HOME === configHome).toBe(true)
  await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
}, 750)

it('removes the claims directory again after a write outlives teardown', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const configHome = process.env.XDG_CONFIG_HOME
  const releaseWrite = Promise.withResolvers<void>()
  let dir: string | undefined
  let write: Promise<void> | undefined
  try {
    await expect(withClaims(async (path) => {
      dir = path
      write = fsStep('resumed write', async () => {
        await releaseWrite.promise
        await fs.mkdir(path, { recursive: true })
        await fs.writeFile(join(path, 'resumed'), 'probe')
      })
    }, { drainMs: 20 })).rejects.toThrow('timed out waiting for: resumed write')
    await expect(fs.stat(dir!)).rejects.toMatchObject({ code: 'ENOENT' })

    releaseWrite.resolve()
    await write
    await vi.waitFor(() => expect(fs.stat(dir!)).rejects.toMatchObject({ code: 'ENOENT' }), { timeout: 500 })
    expect(process.env.XDG_CONFIG_HOME === configHome).toBe(true)
  } finally {
    releaseWrite.resolve()
    await write?.catch(() => {})
    restoreEnv('XDG_CONFIG_HOME', configHome)
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

it('bounds claims teardown when removing the directory stalls', async ({ onTestFinished }) => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const releaseRemove = Promise.withResolvers<void>()
  const remove = vi.spyOn(fixtureFs, 'rm').mockImplementation(async (path, options) => {
    await releaseRemove.promise
    await fs.rm(path, options)
  })
  onTestFinished(async () => {
    releaseRemove.resolve()
    await Promise.allSettled(remove.mock.results.map(({ value }) => value))
    remove.mockRestore()
  })
  await expect(withClaims(async () => {}, { removeMs: 20 })).rejects.toThrow('timed out waiting for: rm')
}, 750)

it('preserves the caller environment across claims teardown', async () => {
  const otherKey = 'BOARD_DST_ENV_PROBE'
  const configHome = process.env.XDG_CONFIG_HOME
  const otherValue = process.env[otherKey]
  try {
    vi.stubEnv('XDG_CONFIG_HOME', 'caller-config')
    vi.stubEnv(otherKey, 'caller-probe')
    await withClaims(async (path) => {
      expect(process.env.XDG_CONFIG_HOME === path).toBe(true)
    })
    expect(process.env.XDG_CONFIG_HOME === 'caller-config').toBe(true)
    expect(process.env[otherKey] === 'caller-probe').toBe(true)

    vi.stubEnv('XDG_CONFIG_HOME', undefined)
    await withClaims(async () => {})
    expect(Object.hasOwn(process.env, 'XDG_CONFIG_HOME')).toBe(false)
    expect(process.env[otherKey] === 'caller-probe').toBe(true)
  } finally {
    restoreEnv('XDG_CONFIG_HOME', configHome)
    restoreEnv(otherKey, otherValue)
  }
})

it('drains a released write on abort and prevents writes after claims teardown', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const writeStarted = Promise.withResolvers<void>()
  const releaseWrite = Promise.withResolvers<void>()
  const afterTeardown = Promise.withResolvers<void>()
  const operationError = new Error('fixture operation failed')
  let dir: string | undefined
  let lateWrite: Promise<unknown> | undefined
  let writeFinished = false
  let writeFinishedOnAbort = false
  try {
    await expect(withClaims(async (path) => {
      dir = path
      const write = async (name: string) => {
        await fs.mkdir(path, { recursive: true })
        await fs.writeFile(join(path, name), 'probe')
      }
      // An out-of-actor continuation has no Sim gate to protect it.
      lateWrite = afterTeardown.promise.then(() => fsStep('late write', () => write('late'))).catch((error: unknown) => error)
      const sim = new Sim(0)
      try {
        await sim.run([
          { name: 'fail', run: async () => {
            // Seed 0 starts this actor first. Let the writer reach real I/O.
            sim.block()
            await writeStarted.promise
            sim.unblock()
            // Fail while the writer is still in flight.
            setImmediate(() => releaseWrite.resolve())
            throw operationError
          } },
          { name: 'write', run: async () => {
            await fsStep('slow write', async () => {
              writeStarted.resolve()
              await releaseWrite.promise
              await write('released')
              writeFinished = true
            })
            return 'written'
          } },
        ])
      } finally {
        writeFinishedOnAbort = writeFinished
      }
    })).rejects.toMatchObject({ message: expect.stringContaining('DST seed 0 operation failed'), cause: operationError })
    afterTeardown.resolve()
    await lateWrite
    await expect(fs.stat(dir!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(writeFinishedOnAbort).toBe(true)
  } finally {
    afterTeardown.resolve()
    await lateWrite
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

// Detect the lock in source so a regression to the unlocked path cannot skip the test.
const claimsSource = readFileSync(new URL('../../src/cli/claims.ts', import.meta.url), 'utf8')
const hasClaimLock = /\.lock`/.test(claimsSource)

function claimRace(seed: number, sampleTime?: (now: number) => void) {
  return withClaims(async () => {
    const scheduler = new Sim(seed)
    let putCompleted = false
    await scheduler.run([
      { name: 'put B', run: async () => {
        if (sampleTime) sampleTime(performance.now())
        await open().put(task, proofB)
        if (sampleTime) sampleTime(performance.now())
        putCompleted = true
        return 'saved'
      } },
      { name: 'drop A', run: async () => {
        await drop(open())
        return 'returned'
      } },
    ], ({ op, label }, random) => {
      // Leave crash recovery under a held PID lock to its own pending case:
      // both logical CLI processes in this test have this worker's actual PID.
      killNext = label.startsWith('fs:') && op !== lockOwner && random() < 0.12
      if (killNext) return 'crash before call'
    })
    const recovered = await open().get(task)
    scheduler.trace.push(`fresh get: ${recovered === null ? 'missing' : `epoch ${recovered.epoch}`}`)
    return { violations: checkSavedClaim(putCompleted, proofB, recovered), trace: scheduler.trace }
  })
}

it('replays a claims seed despite jumps in the host clock', async () => {
  const replay = async () => {
    const times: number[] = []
    const result = await claimRace(46, (now) => times.push(now))
    return { ...result, times }
  }
  const baseline = await replay()
  expect(baseline.times[1]).toBeGreaterThan(baseline.times[0]!)
  if (hasClaimLock) expect(baseline.trace).toContain('0 waiting for claim lock')

  // Cross the lock's five-second deadline without sleeping. Sampling inside the
  // put also exercises the substitution on checkouts without the lock.
  const hostNow = performance.now.bind(performance)
  let skew = 0
  const slowHost = vi.spyOn(performance, 'now').mockImplementation(() => hostNow() + (skew += 6_000))
  try {
    expect(await replay()).toEqual(baseline)
  } finally {
    slowHost.mockRestore()
  }
})

const title = 'E4: a stale drop does not lose a successful replacement put (I5)'
if (!hasClaimLock && process.env.DST_EXPECT !== 'e4') {
  it.skip(`${title} (PR 21 fd0685f has the tombstone window; needs the product fix in 770eb47)`, () => {})
} else {
  it(title, async () => { await checkSeeds(claimRace) }, 55_000)
}

it.skip('E4: PID lock reaping (770eb47) needs only a multiprocess fixture for PID reuse and cross-namespace liveness', () => {})
it.skip('E4: an older CLI ignores the lock from 770eb47; testing compatibility needs only a mixed-version fixture', () => {})
it.skip('E4: death while holding the PID lock (770eb47) needs only a multiprocess fixture; these actors share one PID', () => {})
it.skip('E4: claims.drop can throw after complete committed (PR 21 fd0685f); needs a product fix and a command-level cleanup failure fixture', () => {})
it.skip('E4 seed 243: on PR 21 fd0685f a stale drop dies after moving the saved claim to .drop (I5); needs the product fix in 770eb47', () => {})
