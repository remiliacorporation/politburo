import type { Outcome } from './receiver.ts'

export const otlpBodyBytes = 256 * 1024
const apiRequest = 'claude_code.api_request'
const fields = new Set(['ccr.session.id', 'model', 'request_id', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'duration_ms'])

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => {
  const string = object(value)?.stringValue
  return typeof string === 'string' ? string : undefined
}
function numeric(value: unknown) {
  const anyValue = object(value)
  const integer = anyValue?.intValue
  const n = typeof integer === 'string' && /^-?\d+$/.test(integer) ? Number(integer)
    : typeof integer === 'number' ? integer : anyValue?.doubleValue
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
function tokens(value: unknown) {
  const n = numeric(value)
  // Pass negatives to claim validation; do not turn them into missing counts.
  return n !== null && (n < 0 || Number.isInteger(n)) ? n : null
}
function attributes(value: unknown, record = false) {
  const result = new Map<string, unknown>()
  for (const item of array(value)) {
    const attr = object(item), key = attr?.key
    if (typeof key === 'string' && (fields.has(key) || (record && key === 'event.name'))) {
      result.set(key, attr?.value)
    }
  }
  return result
}
function time(value: unknown) {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return Number(BigInt(value) / 1_000_000n)
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return Math.floor(value / 1_000_000)
  return NaN
}
function iso(ms: number) {
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function* apiRequests(resourceLogs: unknown[]) {
  let count = 0
  for (const group of resourceLogs) {
    const resourceLog = object(group), resource = attributes(object(resourceLog?.resource)?.attributes)
    for (const scope of array(resourceLog?.scopeLogs)) {
      for (const item of array(object(scope)?.logRecords)) {
        const record = object(item), attrs = attributes(record?.attributes, true)
        if (text(attrs.get('event.name')) !== apiRequest && text(record?.body) !== apiRequest) continue
        const get = (key: string) => attrs.has(key) ? attrs.get(key) : resource.get(key)
        const millis = time(record?.timeUnixNano), duration = numeric(get('duration_ms'))
        const occurred = record?.timeUnixNano === undefined ? null : iso(millis)
        yield { sessionId: text(get('ccr.session.id')) ?? '', claim: {
          source_event_key: text(get('request_id')), model: text(get('model')),
          tokens: { input_total: null, input_uncached: tokens(get('input_tokens')), output: tokens(get('output_tokens')),
            cache_read: tokens(get('cache_read_tokens')), cache_write: tokens(get('cache_creation_tokens')), reasoning: null },
          occurred, ended: occurred, started: occurred && duration !== null ? iso(millis - duration) : occurred === undefined ? undefined : null,
          status: 'completed',
        } }
        if (++count === 500) return
      }
    }
  }
}

export async function acceptOtlp(body: unknown, accept: (sessionId: string, claim: unknown) => Promise<Outcome>): Promise<Outcome> {
  const logs = object(body)?.resourceLogs
  if (!Array.isArray(logs)) return [400, 'invalid']
  let success: Outcome | undefined, failure: Outcome | undefined, unknown: Outcome | undefined
  for (const { sessionId, claim } of apiRequests(logs)) {
    const result = await accept(sessionId, claim)
    const [code, message] = result
    if (code === 429 || message === 'record_cap') return result
    if (code === 404) unknown = result
    else if (code < 300) {
      if (!success || code === 202) success = result
    } else if (!failure || code > failure[0]) failure = result
  }
  if (failure?.[0] === 422) return failure
  return success ?? failure ?? unknown ?? [200, 'ignored']
}
