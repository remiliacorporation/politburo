import { tokenCap } from './limits.ts'
import type { Outcome } from './receiver.ts'

export const otlpBodyBytes = 256 * 1024
const apiRequest = 'claude_code.api_request'
const fields = new Set(['event.name', 'ccr.session.id', 'model', 'request_id', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'duration_ms'])

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => {
  const string = object(value)?.stringValue
  return typeof string === 'string' ? string : undefined
}
function numeric(value: unknown, max: number) {
  const anyValue = object(value)
  const raw = anyValue && ('intValue' in anyValue ? anyValue.intValue : anyValue.doubleValue)
  const n = typeof raw === 'string' && raw.length && raw.length <= String(max).length && !/\D/.test(raw)
    ? Number(raw) : raw
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max ? n : NaN
}
function attributes(value: unknown) {
  const values = new Map<string, unknown>()
  let duplicate = false
  for (const item of array(value)) {
    const attr = object(item), key = attr?.key
    if (typeof key !== 'string' || !fields.has(key)) continue
    if (values.has(key)) duplicate = true
    // A repeated API marker must still be counted, then rejected as ambiguous.
    if (key !== 'event.name' || text(values.get(key)) !== apiRequest) values.set(key, attr?.value)
  }
  return { values, duplicate }
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
  for (const group of resourceLogs) {
    const resourceLog = object(group), resource = attributes(object(resourceLog?.resource)?.attributes)
    for (const scope of array(resourceLog?.scopeLogs)) {
      for (const item of array(object(scope)?.logRecords)) {
        const record = object(item), attrs = attributes(record?.attributes)
        const from = (key: string) => attrs.values.has(key) ? attrs.values : resource.values
        const get = (key: string) => from(key).get(key)
        if (text(from('event.name').has('event.name') ? get('event.name') : record?.body) !== apiRequest) continue
        const number = (key: string, max = tokenCap) => from(key).has(key) ? numeric(get(key), max) : null
        const millis = time(record?.timeUnixNano), duration = number('duration_ms', 86_400_000)
        const occurred = record?.timeUnixNano === undefined ? null : iso(millis)
        const tokens = { input_total: null, input_uncached: number('input_tokens'), output: number('output_tokens'),
          cache_read: number('cache_read_tokens'), cache_write: number('cache_creation_tokens'), reasoning: null }
        const invalid = attrs.duplicate || resource.duplicate || [duration, ...Object.values(tokens)].some(Number.isNaN)
        yield { sessionId: text(get('ccr.session.id')) ?? '', claim: invalid ? undefined : {
          source_event_key: text(get('request_id')), model: text(get('model')), tokens,
          occurred, ended: occurred, started: occurred && duration !== null ? iso(millis - duration) : occurred === undefined ? undefined : null,
          status: 'completed',
        } }
      }
    }
  }
}

export async function acceptOtlp(body: unknown, accept: (sessionId: string, claim: unknown) => Promise<Outcome>): Promise<Outcome> {
  const logs = object(body)?.resourceLogs
  if (!Array.isArray(logs)) return [400, 'invalid']
  // Preflight the record count before the first write.
  const records = []
  for (const record of apiRequests(logs)) {
    if (records.length === 500) return [413, 'too_many_records']
    records.push(record)
  }
  let success: Outcome | undefined, firstReject: Outcome | undefined, unknown = 0, rejected = 0
  for (const { sessionId, claim } of records) {
    const result = await accept(sessionId, claim)
    const [code] = result
    if (code === 429 || code >= 500) return result
    if (code < 300) {
      if (!success || code === 202) success = result
    } else {
      firstReject ??= result
      rejected++
      if (code === 404) unknown++
    }
  }
  if (success) return [success[0], success[1], success[2], rejected]
  if (unknown && unknown === rejected) return [404, 'unknown_envelope']
  if (firstReject) return firstReject[0] === 422 ? firstReject : [400, 'invalid', firstReject[2]]
  return [200, 'ignored']
}
