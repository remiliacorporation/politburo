import { count, identifier, list, object, utc, type RequestFact } from './facts.ts'

const keys = new Set([
  'event.name', 'session.id', 'model', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'request_id', 'message.id', 'response_id',
])

function isRequest(value: unknown): boolean {
  return value === 'api_request' || value === 'claude_code.api_request'
}

function token(value: Record<string, unknown> | undefined): number | null {
  const int = value?.intValue
  if (typeof int === 'string' && /^\d+$/.test(int)) return count(Number(int))
  return count(int ?? value?.doubleValue)
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return utc(new Date(Number(BigInt(value) / 1_000_000n)))
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? utc(new Date(value / 1_000_000)) : null
}

export function parseOtlpLogs(body: unknown): { facts: RequestFact[]; rejected: number } {
  const facts: RequestFact[] = []
  let rejected = 0
  let gaps = 0
  for (const resource of list(object(body)?.resourceLogs)) {
    for (const scope of list(object(resource)?.scopeLogs)) {
      for (const item of list(object(scope)?.logRecords)) {
        const row = object(item)
        const attrs = new Map<string, Record<string, unknown> | undefined>()
        for (const attribute of list(row?.attributes)) {
          const entry = object(attribute)
          const key = entry?.key
          if (typeof key === 'string' && keys.has(key)) attrs.set(key, object(entry?.value))
        }
        if (!isRequest(attrs.get('event.name')?.stringValue) && !isRequest(row?.body) &&
          !isRequest(object(row?.body)?.stringValue)) continue
        const id = (key: string) => identifier(attrs.get(key)?.stringValue)
        const nativeSession = id('session.id')
        const requestId = id('request_id')
        const responseId = id('message.id') ?? id('response_id')
        if (nativeSession === null) {
          rejected++
          continue
        }
        const gap = requestId === null && responseId === null ? ++gaps : undefined
        if (gap !== undefined) rejected++
        facts.push({
          source: 'otlp', nativeSession, requestId, responseId, model: id('model'),
          ...(gap === undefined ? {} : { gap }),
          tokens: {
            input_uncached: token(attrs.get('input_tokens')),
            input_total: null,
            output: token(attrs.get('output_tokens')),
            cache_read: token(attrs.get('cache_read_tokens')),
            cache_write: token(attrs.get('cache_creation_tokens')),
            reasoning: null,
          },
          occurred: timestamp(row?.timeUnixNano),
        })
      }
    }
  }
  return { facts, rejected }
}
