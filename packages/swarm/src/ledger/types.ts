// The shapes of design/swarm-spend.md. Types only: no behavior lives here.

export const TIERS = ['core', 'spawner', 'secretary', 'mob', 'sprite', 'jockey'] as const
export type Tier = (typeof TIERS)[number]

/** The eight fixed fields. Persisted before any side effect; never edited. */
export type Envelope = Readonly<{
  party: string
  repo: string | null
  work_id: string | null
  attempt: string | null
  tier: Tier
  parent: string | null
  session: string
  trace: Readonly<{ id: string; execution_id: string }>
}>

/**
 * One dispatch: the envelope plus what is not an envelope field. `sponsor` is the
 * execution id of the spawner that sponsored the dispatch, fixed at creation, so a
 * later change of repo owner never moves a charge (design "Roll-ups", Spawner).
 */
export type Dispatch = Readonly<{ envelope: Envelope; sponsor: string | null; created: string }>

export const BUCKETS = ['input_uncached', 'input_total', 'output', 'cache_read', 'cache_write', 'reasoning'] as const
export type Bucket = (typeof BUCKETS)[number]
/** Nullable counts. Null is unknown (or not applicable, per field_quality), never zero. */
export type Tokens = Readonly<Record<Bucket, number | null>>

/** An exact decimal string (`-?\d+(\.\d+)?`) and its currency or unit. */
export type Amount = Readonly<{ value: string; unit: string }>

export const BASES = ['priced_estimate', 'settled_charge', 'measured_resource', 'unknown', 'not_applicable'] as const
export type Basis = (typeof BASES)[number]

export const COVERAGE_STATES = ['live', 'pending', 'partial', 'unattributed', 'conflict', 'closed_reconciled'] as const
export type CoverageState = (typeof COVERAGE_STATES)[number]

/** `not_applicable` marks a field a fact cannot have (tokens of a worker-seconds interval). */
export const QUALITIES = [
  'provider_reported', 'locally_measured', 'provider_charge', 'priced_estimate', 'quota_snapshot', 'unknown', 'not_applicable',
] as const
export type Quality = (typeof QUALITIES)[number]

/** Keys of `field_quality`: `tokens.<bucket>` and `amount`. */
export type FieldKey = `tokens.${Bucket}` | 'amount'
export type Coverage = Readonly<{ state: CoverageState; field_quality: Readonly<Partial<Record<FieldKey, Quality>>> }>

/** One exclusive fact. Counts, ids and times only: never a prompt, output, credential or transcript. */
export type SpendRecord = Readonly<{
  record_id: string
  dedupe_key: string
  /** The record this one corrects or binds; null for an original. A record is revised at most once. */
  revises: string | null
  /** Required with `revises`. */
  actor?: string
  reason?: string
  /** Null only for an unbound observation (coverage `unattributed`); else the stored dispatch's envelope. */
  envelope: Envelope | null
  source: string
  source_version: string
  source_event_key: string
  evidence_ref: string
  provider: string | null
  requested_route: string | null
  actual_model: string | null
  auth_class: string | null
  tokens: Tokens
  amount: Amount | null
  basis: Basis
  /** UTC ISO 8601 with `Z`. `received` is required. */
  occurred: string | null
  received: string
  started: string | null
  ended: string | null
  status: string
  exit_reason?: string
  coverage: Coverage
}>

export const INTENT_STATES = ['pending', 'ready', 'launching', 'ambiguous', 'launched', 'compensated'] as const
export type IntentState = (typeof INTENT_STATES)[number]
/** What a fenced pending-dispatch record binds: the board claim and the ledger reservation share one intent. */
export type Intent = Readonly<{
  intent_id: string
  execution_id: string
  board_id: string
  task_id: string
  claim_epoch: number
  fence: string
  /** Opaque reservation id; the amounts and limits are WP-504's. */
  reservation_ref: string | null
  created: string
}>
export type IntentView = Readonly<{
  intent: Intent
  state: IntentState
  reservation_confirmed: boolean
  claim_confirmed: boolean
}>

export type AppendOutcome =
  | { outcome: 'appended'; record_id: string }
  /** Same dedupe_key and same content: replay, no spend added. */
  | { outcome: 'duplicate'; record_id: string }
  /** Same dedupe_key, different content: nothing stored. A source-drift signal, never spend. */
  | { outcome: 'dedupe_mismatch'; record_id: string }
