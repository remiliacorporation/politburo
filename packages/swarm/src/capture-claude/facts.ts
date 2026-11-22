export type RequestFact = {
  source: 'otlp' | 'transcript'
  nativeSession: string
  requestId: string | null
  responseId: string | null
  model: string | null
  tokens: {
    input_uncached: number | null
    input_total: number | null
    output: number | null
    cache_read: number | null
    cache_write: number | null
    reasoning: number | null
  }
  occurred: string | null
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function utc(date: Date): string | null {
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
