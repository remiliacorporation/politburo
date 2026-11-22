export type Binding = Readonly<{
  session: string; briefDigest: string; attempt: string; generation: number
}>
export type RemoteStatus = Binding & Readonly<{ version: 1; sequence: number }> & (
  { state: 'working'; publishedSha?: never } | { state: 'finished'; publishedSha: string }
)
export type StatusHead = RemoteStatus & Readonly<{ head: string }>
export type StatusRefusal = 'invalid_status' | 'binding_mismatch' | 'generation_mismatch' | 'status_out_of_order' | 'no_op'

const fields = new Set(['version', 'state', 'session', 'briefDigest', 'attempt', 'generation', 'sequence', 'publishedSha'])
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const clean = (value: unknown) => typeof value === 'string' && value.length > 0 && !/\p{Cc}/u.test(value)
export const isSha = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 40 && /^[0-9a-f]+$/iu.test(value)

function invalidTokens(text: string) {
  const keys = new Set<string>()
  let key: string | undefined
  // JSON.parse checks syntax; scan the flat record without rounding numeric tokens.
  for (const [, string, colon, number] of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu)) {
    if (string !== undefined && colon) {
      key = JSON.parse(string) as string
      if (keys.has(key)) return true
      keys.add(key)
    } else if (number !== undefined) {
      if (key === 'version' ? number !== '1' :
          (key !== 'sequence' && key !== 'generation') || !/^(?:0|[1-9]\d{0,14})$/u.test(number)) return true
    }
  }
  return false
}

export function parseStatus(text: string): { status: RemoteStatus } | { reason: 'invalid_status' | 'generation_mismatch' } {
  const invalid = { reason: 'invalid_status' } as const
  if (Buffer.byteLength(text) > 64 * 1024) return invalid
  let value: Record<string, unknown>
  try { value = JSON.parse(text) } catch { return invalid }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.has(key)) ||
      value.version !== 1 || !count(value.sequence) ||
      !clean(value.session) || !clean(value.briefDigest) || !clean(value.attempt) ||
      (value.state !== 'working' && value.state !== 'finished') ||
      (value.state === 'finished' ? !isSha(value.publishedSha) : Object.hasOwn(value, 'publishedSha')) ||
      invalidTokens(text)) return invalid
  if (!Object.hasOwn(value, 'generation')) return { reason: 'generation_mismatch' }
  if (!count(value.generation)) return invalid
  return { status: value as RemoteStatus }
}

export function acceptStatus({ previous, next, expected }: {
  previous?: StatusHead
  next: { head: string; text: string; descends?: boolean }
  expected: Binding
}): { status: StatusHead } | { reason: StatusRefusal } {
  if (!isSha(next.head)) return { reason: 'invalid_status' }
  const parsed = parseStatus(next.text)
  if ('reason' in parsed) return parsed
  const status = parsed.status
  const matches = (binding: Binding) => binding.session === expected.session &&
    binding.briefDigest === expected.briefDigest && binding.attempt === expected.attempt
  if (!matches(status) || (previous && !matches(previous))) return { reason: 'binding_mismatch' }
  if (status.generation !== expected.generation || (previous && previous.generation !== expected.generation)) {
    return { reason: 'generation_mismatch' }
  }
  if (previous) {
    if (next.head === previous.head && status.sequence === previous.sequence) {
      return { reason: 'no_op' }
    }
    if (status.sequence <= previous.sequence || next.head === previous.head ||
        previous.state === 'finished' || next.descends !== true) return { reason: 'status_out_of_order' }
  }
  return { status: { ...status, head: next.head } }
}
