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
  /** Set when the event has neither request nor response id, so each gap stays distinct. */
  gap?: number
}

export const buckets: (keyof RequestFact['tokens'])[] = [
  'input_uncached', 'input_total', 'output', 'cache_read', 'cache_write', 'reasoning',
]

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

export function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null
}

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function utc(date: Date): string | null {
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
