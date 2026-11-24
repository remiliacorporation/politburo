import { LedgerError } from './errors.ts'
import {
  BASES, BUCKETS, COVERAGE_STATES, QUALITIES, TIERS,
  type Basis, type Bucket, type Dispatch, type FieldKey, type Intent, type Quality, type SpendRecord,
} from './types.ts'

type Check<T> = (value: unknown, path: string) => T

function invalid(path: string, why: string): never {
  throw new LedgerError('invalid', `${path || 'record'}: ${why}`)
}

function child(path: string, key: string) {
  return path ? `${path}.${key}` : key
}

function object<F extends Record<string, Check<unknown>>, O extends keyof F = never>(fields: F, optional: readonly O[] = []) {
  type Result = { [K in Exclude<keyof F, O>]: ReturnType<F[K]> } & { [K in O]?: ReturnType<F[K]> }
  return (value: unknown, path: string): Result => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object')
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) invalid(path, 'expected a plain object')
    const props = Object.getOwnPropertyDescriptors(value)
    for (const key of Reflect.ownKeys(props)) {
      if (!Object.hasOwn(fields, key)) invalid(path, 'unexpected field')
    }
    const entries: [string, unknown][] = []
    for (const [key, check] of Object.entries(fields)) {
      const at = child(path, key)
      if (!Object.hasOwn(props, key)) {
        if (optional.some((field) => field === key)) continue
        invalid(at, 'required')
      }
      const prop = props[key]
      if (!prop || !Object.hasOwn(prop, 'value')) invalid(at, 'expected a data property')
      entries.push([key, check(prop.value, at)])
    }
    return Object.fromEntries(entries) as Result
  }
}

const nullable = <T>(check: Check<T>): Check<T | null> => (value, path) => value === null ? null : check(value, path)

function choices<const T extends string>(values: readonly T[]): Check<T> {
  return (value, path) => {
    if (!values.includes(value as T)) invalid(path, 'unexpected value')
    return value as T
  }
}

function text(pattern: RegExp, why: string, max = Infinity): Check<string> {
  return (value, path) => {
    if (typeof value !== 'string' || value.length > max || !pattern.test(value)) invalid(path, why)
    return value
  }
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/#~-]*$/
const id = text(idPattern, 'expected an identifier of at most 200 characters', 200)
const longId = text(idPattern, 'expected an identifier of at most 300 characters', 300)
const maybeId = nullable(id)
const code = text(/^[a-z0-9][a-z0-9_.:-]{0,79}$/i, 'expected a short code')
const reason: Check<string> = (value, path) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || !value.isWellFormed()) {
    invalid(path, 'expected a non-empty single line of at most 300 characters')
  }
  return value
}
const utcShape = text(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/, 'expected a UTC timestamp')
const time: Check<string> = (value, path) => {
  const s = utcShape(value, path)
  const canonical = s.length === 20 ? s.replace('Z', '.000Z') : s
  if (!Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== canonical) invalid(path, 'invalid UTC timestamp')
  return s
}
export { id as validateId, code as validateCode, time as validateTime }

const maybeTime = nullable(time)
const count: Check<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(path, 'expected a non-negative safe integer')
  return value
}

const envelope = object({
  party: id, repo: maybeId, work_id: maybeId, attempt: maybeId, tier: choices(TIERS),
  parent: maybeId, session: id, trace: object({ id, execution_id: id }),
})
const dispatch = object({ envelope, sponsor: maybeId, created: time })
const intent = object({
  intent_id: id, execution_id: id, board_id: id, task_id: id, claim_epoch: count,
  fence: id, reservation_ref: maybeId, created: time,
})

const bucketFields = BUCKETS.map((bucket) => `tokens.${bucket}` as const)
const tokens = object(Object.fromEntries(BUCKETS.map((bucket) => [bucket, nullable(count)])) as Record<Bucket, Check<number | null>>)
const quality = choices(QUALITIES)
const fieldQuality = object(Object.fromEntries([...bucketFields, 'amount'].map((key) => [key, quality])) as Record<FieldKey, Check<Quality>>)
const amount = object({
  value: text(/^-?[0-9]+(?:\.[0-9]+)?$/, 'expected a decimal string'),
  unit: text(/^[A-Za-z][A-Za-z0-9_./-]{0,31}$/, 'expected a unit code'),
})
const spend = object({
  record_id: id, dedupe_key: id, revises: maybeId, actor: id, reason,
  envelope: nullable(envelope), source: id, source_version: longId, source_event_key: id, evidence_ref: longId,
  provider: maybeId, requested_route: maybeId, actual_model: maybeId, auth_class: maybeId,
  tokens, amount: nullable(amount), basis: choices(BASES), occurred: maybeTime, received: time,
  started: maybeTime, ended: maybeTime, status: code, exit_reason: code,
  coverage: object({ state: choices(COVERAGE_STATES), field_quality: fieldQuality }),
}, ['actor', 'reason', 'exit_reason'])

const amountQualities: Record<Basis, readonly Quality[]> = {
  unknown: ['unknown'], not_applicable: ['not_applicable'], priced_estimate: ['priced_estimate'],
  settled_charge: ['provider_charge'], measured_resource: ['locally_measured', 'provider_reported'],
}

export function validateDispatch(input: unknown): Dispatch {
  return dispatch(input, '')
}

export function validateIntent(input: unknown): Intent {
  return intent(input, '')
}

export function validateRecord(input: unknown): SpendRecord {
  const r = spend(input, '')
  if (r.revises !== null) {
    if (!Object.hasOwn(r, 'actor')) invalid('actor', 'required for a revision')
    if (!Object.hasOwn(r, 'reason')) invalid('reason', 'required for a revision')
  } else {
    if (Object.hasOwn(r, 'actor')) invalid('actor', 'requires revises')
    if (Object.hasOwn(r, 'reason')) invalid('reason', 'requires revises')
  }
  if ((r.envelope === null) !== (r.coverage.state === 'unattributed')) {
    invalid('coverage.state', 'unattributed requires a null envelope and vice versa')
  }
  if (r.started !== null && r.ended !== null && Date.parse(r.started) > Date.parse(r.ended)) {
    invalid('ended', 'precedes started')
  }
  const { field_quality } = r.coverage
  for (const bucket of BUCKETS) {
    const key = `tokens.${bucket}` as const
    if (field_quality[key] === 'quota_snapshot') invalid(`coverage.field_quality.${key}`, 'a quota percentage is not a token count')
    const missing = field_quality[key] === 'unknown' || field_quality[key] === 'not_applicable'
    if ((r.tokens[bucket] === null) !== missing) invalid(`coverage.field_quality.${key}`, 'does not match the token count')
  }
  if ((r.amount === null) !== (r.basis === 'unknown' || r.basis === 'not_applicable')) {
    invalid('amount', 'does not match basis')
  }
  if (r.amount && r.basis !== 'settled_charge' && r.amount.value.startsWith('-') && /[1-9]/.test(r.amount.value)) {
    invalid('amount.value', 'only settled charges can be negative')
  }
  if (!amountQualities[r.basis].includes(field_quality.amount)) invalid('coverage.field_quality.amount', 'does not match basis')
  return r
}
