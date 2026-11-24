// Local stubs for WP-103 and WP-401/408. Replace with their readers when they land on main.
import Ajv from 'ajv'

const tiers = ['core', 'spawner', 'secretary', 'mob', 'sprite', 'jockey'] as const
const coverageStates = ['live', 'pending', 'partial', 'unattributed', 'conflict', 'closed_reconciled'] as const
const buckets = ['input_uncached', 'input_total', 'output', 'cache_read', 'cache_write', 'reasoning'] as const
const results = ['valid', 'invalid', 'unverifiable'] as const

export type Envelope = {
  party: string
  repo: string | null
  work_id: string | null
  attempt: string | null
  tier: typeof tiers[number]
  parent: string | null
  session: string
  trace: { id: string; execution_id: string }
}
export type Dispatch = Envelope
export type SpendRecord = {
  record_id: string
  dedupe_key: string
  revises: string | null
  envelope: Envelope | null
  tokens: Record<typeof buckets[number], number | null>
  coverage: { state: typeof coverageStates[number] }
}
export type OutcomeRecord = {
  work_id: string
  party: string
  attempt: string
  contract_revision: string | number
  outcome: { kind: string; index: number } | null
  result: typeof results[number]
  evidence: string
  checked_at: string
  verifier_version: string
  override: { actor: string; reason: string } | null
}
export type Fact = { fact_id: string; party: string; work_id: string; attempt: string; at: string } & (
  | { kind: 'merged'; pr: string }
  | { kind: 'reverted' | 'review_round' | 'missed_claim' }
  | { kind: 'human_minutes'; minutes: number | null }
)
export type ScoreInput = { dispatches: Dispatch[]; spend: SpendRecord[]; outcomes: OutcomeRecord[]; facts: Fact[] }

export class ScoringInputError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ScoringInputError'
  }
}

const text = { type: 'string' }
const id = { ...text, minLength: 1 }
const count = { type: 'integer', minimum: 0 }
const timestamp = { type: 'string', format: 'utc' }
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const list = (items: object) => ({ type: 'array', items })
const strict = (properties: Record<string, object>) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
})
const key = { party: id, work_id: id, attempt: id }
const envelope = strict({
  party: id, repo: nullable(text), work_id: nullable(id), attempt: nullable(id),
  tier: { enum: tiers }, parent: nullable(id), session: text, trace: strict({ id: text, execution_id: id }),
})
const fact = (kind: Fact['kind'], extra = {}) => strict({ ...key, fact_id: id, at: timestamp, kind: { const: kind }, ...extra })
const ajv = new Ajv.default({ allErrors: true, ownProperties: true, discriminator: true })
ajv.addFormat('utc', (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false
  const time = new Date(value)
  return Number.isFinite(+time) && time.toISOString().slice(0, 19) === value.slice(0, 19)
})
const validate = ajv.compile<ScoreInput>({
  ...strict({
    dispatches: list(envelope),
    spend: list(strict({
      record_id: id, dedupe_key: text, revises: nullable(id), envelope: nullable(envelope),
      tokens: strict(Object.fromEntries(buckets.map(bucket => [bucket, nullable(count)]))),
      coverage: strict({ state: { enum: coverageStates } }),
    })),
    outcomes: list(strict({
      ...key, contract_revision: { anyOf: [text, count] }, outcome: nullable(strict({ kind: text, index: count })),
      result: { enum: results }, evidence: text, checked_at: timestamp,
      verifier_version: text, override: nullable(strict({ actor: text, reason: text })),
    })),
    facts: list({ discriminator: { propertyName: 'kind' }, type: 'object', oneOf: [
      fact('merged', { pr: text }), fact('reverted'), fact('review_round'), fact('missed_claim'),
      fact('human_minutes', { minutes: nullable({ type: 'number', minimum: 0 }) }),
    ] }),
  }),
})

export function currentHeads(spend: readonly SpendRecord[]): SpendRecord[] {
  const superseded = new Set(spend.map(record => record.revises))
  return spend.filter(record => !superseded.has(record.record_id))
}

function unique<T>(rows: T[], list: string, field: keyof T) {
  const byId = new Map<T[keyof T], T>()
  for (const [i, row] of rows.entries()) {
    if (byId.has(row[field])) throw new ScoringInputError(`${list}/${i}/${String(field)}`, 'duplicate id')
    byId.set(row[field], row)
  }
  return byId
}

export function outcomeRefId({ work_id, attempt, checked_at }: OutcomeRecord): string {
  return `${work_id}#${attempt}@${checked_at}`
}

export function parseScoreInput(value: unknown): ScoreInput {
  if (!validate(value)) {
    const errors = validate.errors!
    const error = errors.find(e => e.keyword === 'additionalProperties') ?? errors[0]!
    const field = error.params.additionalProperty ?? error.params.missingProperty
    const path = error.instancePath + (field === undefined ? '' : `/${field}`)
    throw new ScoringInputError(path || '/', error.message ?? 'invalid input')
  }
  const executionIds = new Set<string>()
  for (const [i, { trace }] of value.dispatches.entries()) {
    if (executionIds.has(trace.execution_id)) {
      throw new ScoringInputError(`dispatches/${i}/trace/execution_id`, 'duplicate dispatch execution id')
    }
    executionIds.add(trace.execution_id)
  }
  const spendById = unique(value.spend, 'spend', 'record_id')
  unique(value.facts, 'facts', 'fact_id')
  for (const [i, record] of value.spend.entries()) {
    if (record.revises === null) continue
    const target = spendById.get(record.revises)
    if (!target) throw new ScoringInputError(`spend/${i}/revises`, 'missing record')
    if (target.envelope !== null && target.envelope.party !== record.envelope?.party) {
      throw new ScoringInputError(`spend/${i}/revises`, 'revision of a bound record must belong to the same party')
    }
  }
  const outcomeIds = new Set<string>()
  for (const [i, outcome] of value.outcomes.entries()) {
    const id = outcomeRefId(outcome)
    if (outcomeIds.has(id)) throw new ScoringInputError(`outcomes/${i}`, 'duplicate outcome ref')
    outcomeIds.add(id)
  }
  return value
}
