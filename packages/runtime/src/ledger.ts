import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ReplayConflict, type Harness, type Result, type RunEvent, type RunRef, type SendOutcome, type Start, type State } from './harness.ts'

export type Run = {
  ref: RunRef
  state: State
  events: RunEvent[]
  result?: Result
  input?: (text: string) => SendOutcome
  stop?: () => void
  sends: Map<string, { text: string; outcome: SendOutcome }>
}

export function finish(run: Run, result: Omit<Result, 'usage' | 'artifacts'>) {
  if (run.result) return
  run.state = result.outcome
  run.result = { ...result, usage: null, artifacts: [] }
  delete run.stop
  delete run.input
}

/** Instance-local replay and observation, shared by the fixture adapters. */
export function ledger(launch: (run: Run, input: Start) => void, interactive: boolean): Harness {
  const attempts = new Map<string, { input: Start; run: Run }>()
  const runs = new Map<RunRef, Run>()
  const get = (ref: RunRef) => {
    const run = runs.get(ref)
    if (!run) throw new Error('unknown run')
    return run
  }
  return {
    async start(input) {
      const saved = structuredClone({ ...input, model: input.model })
      const previous = attempts.get(saved.attemptId)
      if (previous) {
        if (!isDeepStrictEqual(previous.input, saved)) throw new ReplayConflict('start ID already used')
        return previous.run.ref
      }
      const wall = saved.work.limits.wallMs
      if (!Number.isSafeInteger(wall) || wall < 1 || wall > 2_147_483_647) throw new RangeError('invalid wallMs')
      const run: Run = { ref: randomUUID(), state: 'starting', events: [], sends: new Map() }
      attempts.set(saved.attemptId, { input: saved, run })
      runs.set(run.ref, run)
      launch(run, saved)
      return run.ref
    },
    async observe(ref, { after, limit }) {
      const run = get(ref)
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('invalid observation limit')
      const prefix = `${ref}:`
      const offset = after === undefined ? 0 : Number(after.slice(prefix.length))
      if (after !== undefined && (after !== `${prefix}${offset}` || !Number.isSafeInteger(offset) || offset < 0 || offset > run.events.length)) {
        throw new RangeError('invalid observation cursor')
      }
      const events = structuredClone(run.events.slice(offset, offset + Math.min(limit, 100)))
      return { state: run.state, cursor: `${prefix}${offset + events.length}`, events, usage: null }
    },
    async send(ref, { id, text }) {
      const run = get(ref)
      const previous = run.sends.get(id)
      if (previous) {
        if (previous.text !== text) throw new ReplayConflict('send ID already used')
        return previous.outcome
      }
      const outcome = !interactive ? 'unsupported' : run.state === 'running' ? run.input?.(text) ?? 'not_running' : 'not_running'
      run.sends.set(id, { text, outcome })
      return outcome
    },
    async cancel(ref) {
      get(ref).stop?.()
    },
    async collect(ref) {
      const result = get(ref).result
      return result ? structuredClone(result) : 'not_terminal'
    },
  }
}
