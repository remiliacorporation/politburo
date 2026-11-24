import { AsyncLocalStorage } from 'node:async_hooks'
import type { A2Store, Clock } from 'experimental-a2/server'
import { accessContract, ACCESS_SESSION } from '../contract/contract.ts'

const accessLog = `${accessContract.name}\u001f${ACCESS_SESSION}`

export class AccessMoved extends Error {}

/** Read through Date at call time, including when the simulation replaces it. */
export const wallTime = () => Date.now()

class CommitRefused extends Error {}

/** A2 wraps store errors; only unwrap a refusal raised by our insertion clock. */
export function appendRefusal(error: unknown): unknown {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof CommitRefused) return current.cause
  }
  return error
}

export function singleWriter() {
  type Check = (at: number) => void
  type Turn = {
    active: boolean
    now: number
    checks: Check[]
    release: (() => void) | undefined
    suspendedAt: number | undefined
  }
  const owner = new AsyncLocalStorage<Turn>()
  const committing = new AsyncLocalStorage<readonly Check[]>()
  let tail = Promise.resolve()
  let accessVersion = 0
  let guarded = false

  async function acquire() {
    const previous = tail
    const turn = Promise.withResolvers<void>()
    tail = turn.promise
    await previous
    return () => turn.resolve()
  }

  async function resume(current: Turn) {
    if (current.suspendedAt === undefined) return
    current.release = await acquire()
    const expected = current.suspendedAt
    current.suspendedAt = undefined
    if (expected !== accessVersion) throw new AccessMoved('board access changed while a write was pending')
  }

  async function section<T>(write: (now: number) => Promise<T>, release?: () => void): Promise<T> {
    const current: Turn = { active: true, now: wallTime(), checks: [], release, suspendedAt: undefined }
    try {
      return await owner.run(current, () => write(current.now))
    } finally {
      current.active = false
      current.release?.()
    }
  }
  async function run<T>(write: (now: number) => Promise<T>): Promise<T> {
    // An awaited nested write cannot wait for its parent. It samples its own time.
    // Detached work that outlives the owner has to acquire its own turn.
    const parent = owner.getStore()
    return parent?.active && parent.suspendedAt === undefined ? section(write) : section(write, await acquire())
  }
  return {
    run,
    beginDecision(retry: boolean) {
      const current = owner.getStore()
      if (!current) return
      current.checks.length = 0
      if (retry) current.now = wallTime()
    },
    beforeCommit(check: Check) {
      owner.getStore()?.checks.push(check)
    },
    /** Let versioned reads and conditional append adapters wait without owning the FIFO. */
    async outside<T>(io: () => Promise<T>): Promise<T> {
      const current = owner.getStore()
      // A nested write does not own the enclosing turn, and an unguarded store
      // has no hook to reacquire the turn before it inserts.
      if (!guarded || !current?.active || !current.release) return io()
      current.suspendedAt = accessVersion
      current.release()
      current.release = undefined
      try {
        return await io()
      } finally {
        await resume(current)
      }
    },
    /** Rejoin the FIFO before the actual conditional insert, below any delaying adapter. */
    async guardAppend<T>(append: () => Promise<T>, access = false): Promise<T> {
      const current = owner.getStore()
      if (current?.active) await resume(current)
      const result = await committing.run(current?.checks.slice() ?? [], append)
      if (access) accessVersion++
      return result
    },
    installGuard() { guarded = true },
    clock(clock?: Clock): Clock {
      return { now: () => {
        const date = clock?.now() ?? new Date(wallTime())
        try {
          for (const check of committing.getStore() ?? []) check(date.getTime())
        } catch (cause) {
          throw new CommitRefused('write refused at insertion', { cause })
        }
        return date
      } }
    },
    time: () => {
      const current = owner.getStore()
      if (!current?.active) throw new Error('write decision outside the local writer')
      return current.now
    },
    // A2's detached consumers do not own the turn of the append that woke them.
    detached: <T>(work: () => T): T => owner.exit(work),
  }
}

export type SingleWriter = ReturnType<typeof singleWriter>
const writers = new WeakMap<A2Store, SingleWriter>()

/** All local sessions on the same log, including across bindings, share one writer. */
export function writerFor(log: A2Store): SingleWriter {
  let writer = writers.get(log)
  if (!writer) writers.set(log, writer = singleWriter())
  return writer
}

/** Install at store construction, below any I/O adapters that suspend an append. */
export function guardedLog<T extends A2Store>(open: (clock: Clock) => T, clock?: Clock): T {
  const writer = singleWriter()
  const log = open(writer.clock(clock))
  writers.set(log, writer)
  const append = log.append.bind(log)
  writer.installGuard()
  log.append = (...args) => writer.guardAppend(() => append(...args), args[0] === accessLog)
  return log
}
