import { LedgerError } from './errors.ts'
import type { AppendOutcome, CoverageState, Dispatch, SpendRecord } from './types.ts'
import { validateRecord } from './validate.ts'

type Writer = { append(record: SpendRecord): AppendOutcome }
type RevisionWriter = Writer & { record(id: string): SpendRecord | null }
type BindingWriter = RevisionWriter & {
  heads(): readonly SpendRecord[]
  dispatch(executionId: string): Dispatch | null
}

type Revision = { dedupe_key: string; actor: string; reason: string; received: string }
export type BindInput = Revision & {
  record_id: string
  execution_id: string
  new_record_id: string
  state: Exclude<CoverageState, 'unattributed'>
}

const factFields = [
  'tokens', 'amount', 'basis', 'coverage', 'status', 'exit_reason', 'occurred', 'started', 'ended',
  'provider', 'requested_route', 'actual_model', 'auth_class', 'evidence_ref',
] as const
export type CorrectInput = Revision & {
  revises: string
  record_id: string
  changes: Partial<Pick<SpendRecord, (typeof factFields)[number]>>
}

export function ingest(ledger: Writer, input: unknown): AppendOutcome {
  return ledger.append(validateRecord(input))
}

export function bind(ledger: BindingWriter, input: BindInput): AppendOutcome {
  const { record_id, execution_id, new_record_id, dedupe_key, actor, reason, received, state } = input
  const target = ledger.record(record_id)
  if (!target || target.envelope !== null) throw new LedgerError('not_bindable', 'record_id: expected an unbound head')
  if (!ledger.heads().some((head) => head.record_id === record_id)) {
    // A replay may name a historical target; let append compare the full successor.
    const replay = ledger.record(new_record_id)
    if (!replay || replay.revises !== record_id || replay.dedupe_key !== dedupe_key || replay.envelope === null) {
      throw new LedgerError('not_bindable', 'record_id: expected an unbound head')
    }
  }
  const dispatch = ledger.dispatch(execution_id)
  if (!dispatch) throw new LedgerError('unknown_dispatch', 'execution_id: no persisted dispatch')
  return ingest(ledger, {
    ...target, record_id: new_record_id, revises: record_id, dedupe_key, actor, reason, received,
    envelope: dispatch.envelope, coverage: { ...target.coverage, state },
  })
}

export function correct(ledger: RevisionWriter, input: CorrectInput): AppendOutcome {
  const { revises, record_id, dedupe_key, actor, reason, received, changes } = input
  const target = ledger.record(revises)
  if (!target) throw new LedgerError('unknown_revision', 'revises: no persisted record')
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new LedgerError('invalid', 'changes: expected an object')
  }
  const props = Object.getOwnPropertyDescriptors(changes)
  for (const key of Reflect.ownKeys(props)) {
    if (!factFields.some((field) => field === key)) {
      throw new LedgerError('invalid', 'changes: only fact fields can be corrected')
    }
  }
  const facts = { ...target, revises, record_id, dedupe_key, actor, reason, received }
  for (const key of factFields) {
    if (!Object.hasOwn(props, key)) continue
    const prop = props[key]
    if (!prop || !Object.hasOwn(prop, 'value')) throw new LedgerError('invalid', `changes.${key}: expected a data property`)
    Object.assign(facts, { [key]: prop.value })
  }
  return ingest(ledger, facts)
}
