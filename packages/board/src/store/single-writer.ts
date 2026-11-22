import { AsyncLocalStorage } from 'node:async_hooks'
import type { A2Store, Clock } from 'experimental-a2/server'

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
  const owner = new AsyncLocalStorage<{ active: boolean; now: number; checks: Check[] }>()
  const committing = new AsyncLocalStorage<readonly Check[]>()
  let tail = Promise.resolve()
  async function section<T>(write: (now: number) => Promise<T>): Promise<T> {
    const current = { active: true, now: wallTime(), checks: [] as Check[] }
    try {
      return await owner.run(current, () => write(current.now))
    } finally {
      current.active = false
    }
  }
  async function run<T>(write: (now: number) => Promise<T>): Promise<T> {
    // An awaited nested write cannot wait for its parent. It samples its own time.
    // Detached work that outlives the owner has to acquire its own turn.
    if (owner.getStore()?.active) return section(write)
    const previous = tail
    const turn = Promise.withResolvers<void>()
    tail = turn.promise
    await previous
    try {
      return await section(write)
    } finally {
      turn.resolve()
    }
  }
  return {
    run,
    beginDecision() {
      owner.getStore()?.checks.splice(0)
    },
    beforeCommit(check: Check) {
      owner.getStore()?.checks.push(check)
    },
    /** Bind checks only while the actual store append is taking its insertion timestamp. */
    guardAppend<T>(append: () => Promise<T>) {
      return committing.run(owner.getStore()?.checks.slice() ?? [], append)
    },
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
  log.append = (...args) => writer.guardAppend(() => append(...args))
  return log
}
