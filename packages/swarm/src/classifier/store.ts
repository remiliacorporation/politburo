import { appendFileSync, closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { Action, QuestionKey } from './questions.ts'

export type Mode = 'shadow' | 'live'
export type Reason = 'classified' | 'unavailable' | 'invalid' | 'below_threshold' | 'guard' | 'p0' | 'disabled' | 'shadow'
export type CallRecord = {
  id: string; at: string; question: QuestionKey; prompt_version: number; state: Mode;
  label: string | null; probability: number | null; action_would: Action; action_taken: Action; reason: Reason; case_ref: string
}
export type Outcome = { spawner_did: Action; costly: boolean }
export type OutcomeRecord = Outcome & { call_id: string; at: string }
export type SwitchRecord = { question: QuestionKey; at: string; reason: string } & (
  { type: 'breach'; costly: number; classified: number; limit: string } | { type: 'clear'; call_cursor: number }
)

function read<T>(path: string): T[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  lines.pop() // A record is complete only once its newline is written.
  return lines.flatMap((line) => {
    if (!line) return []
    try { return [JSON.parse(line) as T] } catch { throw new Error('invalid classifier log') }
  })
}

function discardTornTail(path: string): void {
  let fd: number
  try { fd = openSync(path, 'r+') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const size = fstatSync(fd).size
    const last = Buffer.alloc(1)
    if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) {
      ftruncateSync(fd, readFileSync(fd).lastIndexOf(10) + 1)
    }
  } finally { closeSync(fd) }
}

export function openClassifierStore(dir: string) {
  const calls = join(dir, 'calls.jsonl')
  const switches = join(dir, 'switches.jsonl')
  function append(path: string, record: CallRecord | OutcomeRecord | SwitchRecord) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    discardTornTail(path)
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }
  return {
    readCalls: () => read<CallRecord | OutcomeRecord>(calls),
    readSwitches: () => read<SwitchRecord>(switches),
    appendCall: (record: CallRecord | OutcomeRecord) => append(calls, record),
    appendSwitch: (record: SwitchRecord) => append(switches, record),
  }
}

export function callHistory(records: (CallRecord | OutcomeRecord)[], outcomeStart = 0) {
  const calls: CallRecord[] = []
  const outcomes = new Map<string, OutcomeRecord>()
  for (const [i, record] of records.entries()) {
    if ('id' in record) calls.push(record)
    else if (i >= outcomeStart && !outcomes.has(record.call_id)) outcomes.set(record.call_id, record)
  }
  return { calls, outcomes }
}

export function activeLatches(records: SwitchRecord[]) {
  const latched = new Set<QuestionKey>()
  for (const record of records) {
    if (record.type === 'breach') latched.add(record.question)
    else if (record.type === 'clear') latched.delete(record.question)
  }
  return latched
}
