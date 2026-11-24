export type Urgency = 'p0' | 'p1' | 'p2' | 'p3'

export type SwarmMessage = {
  id: string
  class: string
  urgency: Urgency
  from: string
  ref?: string
  summary: string
  at: string
  expires?: string
  to?: string
  dispatch?: string
  body?: string
}

export type HeaderResult = { ok: true; message: SwarmMessage } | { ok: false; reason: string; from?: string }

const required = ['id', 'class', 'urgency', 'from', 'summary', 'at']
const ignored = ['needs', 'reply_to', 'thread', 'status', 'review_by', 'default_if_unanswered', 'answered_at']
const fields = [...required, 'ref', 'expires', 'to', 'dispatch', 'body', ...ignored]

function isMapping(raw: unknown): raw is Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') return false
  const proto = Object.getPrototypeOf(raw)
  return proto === Object.prototype || proto === null
}

export function canonicalRef(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref || undefined
  if (!isMapping(ref)) return
  const entries = Object.entries(ref)
  if (!entries.length || entries.some(([, value]) =>
    value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !Number.isFinite(value),
  )) return
  const escape = (text: string) => text.replace(/[%,=]/g, (char) => encodeURIComponent(char))
  return Object.keys(ref).sort().map((key) => `${escape(key)}=${escape(String(ref[key]))}`).join(',')
}

function timestamp(raw: unknown): string | undefined {
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.toISOString() : undefined
  if (typeof raw !== 'string') return
  const match = /^(\d{4})-(\d\d)-(\d\d)T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(raw)
  if (!match) return
  // Date.parse can roll an invalid calendar day into the next month.
  const [, year, month, day] = match
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (calendar.getUTCDate() !== Number(day)) return
  const ms = Date.parse(raw)
  if (Number.isFinite(ms)) return new Date(ms).toISOString()
}

export function parseHeader(raw: unknown, opts: { classes: string[] }): HeaderResult {
  const reject = (reason: string): HeaderResult => ({ ok: false, reason })
  if (!isMapping(raw)) return reject('bad_header')
  const unknown = Object.keys(raw).find((key) => !fields.includes(key))
  if (unknown !== undefined) return reject(`unknown_field:${unknown}`)
  for (const field of required) {
    if (!Object.hasOwn(raw, field)) return reject(`missing_field:${field}`)
  }
  const { id, class: mailClass, urgency, from, summary } = raw
  if (typeof id !== 'string' || !id) return reject('bad_id')
  if ([...id].length > 200) return reject('id_too_long')
  if (typeof mailClass !== 'string' || !opts.classes.includes(mailClass)) return reject('bad_class')
  if (urgency !== 'p0' && urgency !== 'p1' && urgency !== 'p2' && urgency !== 'p3') return reject('bad_urgency')
  if (typeof from !== 'string' || !from) return reject('bad_from')
  if (typeof summary !== 'string') return reject('bad_summary')
  if ([...summary].length > 120) return reject('summary_too_long')
  const at = timestamp(raw.at)
  if (at === undefined) return reject('bad_timestamp:at')

  const message: SwarmMessage = { id, class: mailClass, urgency, from, summary, at }
  if (Object.hasOwn(raw, 'ref')) {
    const ref = canonicalRef(raw.ref)
    if (ref === undefined) return reject('bad_ref')
    message.ref = ref
  }
  for (const field of ignored) {
    if (!Object.hasOwn(raw, field)) continue
    const value = raw[field]
    if (typeof value !== 'string' || !value || [...value].length > 200) return reject(`bad_${field}`)
  }
  if (Object.hasOwn(raw, 'expires')) {
    if (urgency === 'p0' || urgency === 'p1') return reject('expires_on_p0p1')
    const expires = timestamp(raw.expires)
    if (expires === undefined) return reject('bad_timestamp:expires')
    if (Date.parse(expires) <= Date.parse(at)) return reject('expires_not_after_at')
    message.expires = expires
  }
  for (const field of ['to', 'dispatch', 'body'] as const) {
    if (!Object.hasOwn(raw, field)) continue
    const value = raw[field]
    if (typeof value !== 'string' || (!value && field !== 'body')) return reject(`bad_${field}`)
    message[field] = value
  }
  return { ok: true, message }
}