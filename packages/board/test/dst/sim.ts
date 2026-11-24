import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

const realNow = performance.now.bind(performance)

export function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let n = Math.imul(state ^ (state >>> 15), state | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 2 ** 32
  }
}

type Point = { op: number; name: string; label: string }
type Op = { name: string; run: () => Promise<string> }
type State = { kind: 'running' | 'blocked' | 'done' } | { kind: 'parked'; label: string; resume: () => void }
type Policy = (point: Point, random: () => number) => string | void
const actor = new AsyncLocalStorage<{ sim: Sim; op: number }>()

/** One driver, one run. A killed actor stays suspended, including its finally blocks. */
export class Sim {
  readonly trace: string[] = []
  #aborted = false
  #elapsedMs = 0
  readonly #states: State[] = []
  readonly #seed: number
  readonly #pick: () => number
  readonly #fault: () => number
  readonly #settleMs: number

  constructor(seed: number, { settleMs = 2_000 }: { settleMs?: number } = {}) {
    this.#seed = seed
    this.#settleMs = settleMs
    this.#pick = rng(seed)
    this.#fault = rng(seed ^ 0x9e3779b9)
  }

  static get current() { return actor.getStore()?.sim }

  /** Logical time advances one millisecond per scheduled step. */
  get elapsedMs() { return this.#elapsedMs }

  get op() {
    const context = actor.getStore()
    if (context?.sim === this) return context.op
  }

  gate(label: string): Promise<void> | void {
    if (this.#aborted) {
      this.block()
      return new Promise<void>(() => {})
    }
    const op = this.op
    if (op === undefined) return // Out-of-simulation setup, observation, or cleanup.
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#states[op] = { kind: 'parked', label, resume: resolve }
    return promise
  }

  block() {
    const op = this.op
    if (op !== undefined) this.#states[op] = { kind: 'blocked' }
  }

  unblock() {
    const op = this.op
    if (op !== undefined) this.#states[op] = { kind: 'running' }
  }

  kill(): Promise<never> {
    const op = this.op
    if (op === undefined) throw new Error('cannot kill outside a simulated operation')
    this.#states[op] = { kind: 'done' }
    this.trace.push(`${op} killed`)
    return new Promise<never>(() => {})
  }

  /** At the settle deadline a running actor reports a stall, with any operation
   * error as its cause. Without a running actor, report the operation failure. */
  async run(ops: readonly Op[], beforeRelease?: Policy) {
    const errors: unknown[] = []
    ops.forEach(({ name, run }, op) => {
      void actor.run({ sim: this, op }, async () => {
        try {
          await this.gate('start')
          this.trace.push(`${op} ${name}: ${await run()}`)
        } catch (error) {
          errors.push(error)
        } finally {
          this.#states[op] = { kind: 'done' }
        }
      })
    })

    const stalled = () => new Error(
      `DST seed ${this.#seed} stalled (${this.#states.map((state) => state.kind).join(', ')}):\n${this.trace.join('\n')}`,
      errors.length ? { cause: errors[0] } : undefined,
    )
    const running = () => this.#states.some(({ kind }) => kind === 'running')
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
    try {
      for (let steps = 0; ; steps++) {
        // Real timers and crypto can delay a runnable actor. Wait for its state, not its arrival order.
        const deadline = realNow() + this.#settleMs
        while (running() && realNow() < deadline) await turn()
        if (running()) throw stalled()
        if (errors.length) throw new Error(`DST seed ${this.#seed} operation failed:\n${this.trace.join('\n')}`, { cause: errors[0] })
        if (this.#states.every(({ kind }) => kind === 'done')) return

        // Array order is operation index, even if crypto or real retry timers parked them out of order.
        const parked = this.#states.flatMap((state, op) => state.kind === 'parked' ? [{ op, ...state }] : [])
        if (!parked.length || steps >= 500) throw stalled()
        const { op, label, resume } = parked[Math.floor(this.#pick() * parked.length)]!
        const point = { op, name: ops[op]!.name, label }
        this.#elapsedMs++
        const fault = beforeRelease?.(point, this.#fault)
        this.trace.push(`${op} ${point.name} @ ${label}${fault ? ` (${fault})` : ''}`)
        this.#states[op] = { kind: 'running' }
        resume()
        // Let promise continuations from a released gate (including lock handoffs) settle first.
        await turn()
      }
    } catch (error) {
      this.#aborted = true
      // Released actors may still be in real I/O. Wait until they finish or hit
      // another suspension point, but don't wait for parked or killed actors.
      const deadline = realNow() + 2_000
      while (running() && realNow() < deadline) await turn()
      throw error
    }
  }
}
