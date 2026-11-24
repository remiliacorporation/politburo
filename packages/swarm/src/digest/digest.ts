import { checkMailbox, InputError, type MailPort, type Urgency } from './mail-port.ts'
import { policyId } from './notices.ts'

export type MessageHeader = {
  id: string
  urgency: Urgency
  class: string
  state: string
  createdAt: string
  expires?: string
  summary: string
}

export type RolloutAck = { mailbox: string; record?: string; version: number; acked: boolean; noticeAt: string }

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

function projectHeader({ id, urgency, class: kind, state, createdAt, expires, summary }: MessageHeader): MessageHeader {
  return { id, urgency, class: kind, state, createdAt, ...(expires === undefined ? {} : { expires }), summary }
}

function timestamp(value: unknown, field: string, id?: string): number {
  const syntax = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/
  if (typeof value === 'string' && syntax.test(value)) {
    const at = Date.parse(value)
    // Date.parse can normalize an impossible date into the following month.
    if (Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value.slice(0, 10)) return at
  }
  throw new InputError(`invalid ${field}${id === undefined ? '' : ` for header ${JSON.stringify(id)}`}`)
}

export function windowBound(value: string, bound: 'from' | 'to'): number {
  return timestamp(value, `window ${bound}`)
}

export function exceptionDigest({ repo, window, headers, acks = [], now }: {
  repo: string; window: { from: string; to: string }; headers: readonly MessageHeader[]
  acks?: readonly RolloutAck[]; now: string | number | Date
}) {
  // Use a half-open interval so adjacent windows do not repeat boundary headers.
  const from = windowBound(window.from, 'from'), to = windowBound(window.to, 'to')
  const nowMs = new Date(now).getTime()
  const open = new Map<string, MessageHeader>()
  const latest = new Map<string, { item: MessageHeader; at: number; expiry: number }>()
  for (const header of headers) {
    const item = projectHeader(header)
    const { id, urgency, createdAt, expires } = item
    const at = timestamp(createdAt, 'createdAt', id)
    if (expires !== undefined && (urgency === 'p0' || urgency === 'p1')) {
      throw new InputError(`expires is not allowed on ${urgency} header ${JSON.stringify(id)}`)
    }
    const expiry = expires === undefined ? Infinity : timestamp(expires, 'expires', id)
    const prior = latest.get(id)
    // Exact-ID duplicates at the same instant use the projected fields as a stable tie-breaker.
    if (!prior || at > prior.at || (at === prior.at && compare(JSON.stringify(item), JSON.stringify(prior.item)) < 0)) {
      latest.set(id, { item, at, expiry })
    }
  }
  for (const { item, at, expiry } of latest.values()) {
    if (item.state === 'open' && at >= from && at < to && expiry > nowMs) open.set(item.id, item)
  }
  // An outstanding rollout can span several windows. Keep showing it until acked.
  for (const { mailbox, record = 'party', version, acked, noticeAt } of acks) {
    if (acked || !(nowMs - Date.parse(noticeAt) >= 60 * 60_000)) continue
    const id = policyId(mailbox, version, record)
    open.set(id, {
      id, class: 'policy', urgency: 'p1', state: 'open', createdAt: noticeAt,
      summary: `${mailbox} has not acknowledged config ${record} v${version}`,
    })
  }
  const sorted = [...open.values()].sort((a, b) =>
    compare(a.urgency, b.urgency) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || compare(a.id, b.id))
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 }
  for (const { urgency } of sorted) counts[urgency]++
  return {
    batch: `${repo.split('/').at(-1)!.slice(0, 2).toLowerCase()}-${new Date(to).toISOString().slice(0, 16)}Z`,
    repo, window: { from: window.from, to: window.to }, counts,
    act_on: sorted.filter(({ urgency }) => urgency === 'p0' || urgency === 'p1').map(({ id }) => id),
    items: sorted.filter(({ urgency, class: kind }) => urgency !== 'p3' && !(urgency === 'p2' && kind === 'sec.log')),
  }
}

export type ExceptionDigest = ReturnType<typeof exceptionDigest>

export async function postDigest({ digest, mailbox, mail }: {
  digest: ExceptionDigest; mailbox: string; mail: MailPort
}): Promise<'empty' | 'posted' | 'existing'> {
  checkMailbox(mailbox)
  const { batch, repo, window: { from, to }, counts: { p0, p1, p2, p3 }, act_on, items } = digest
  const fromMs = windowBound(from, 'from'), toMs = windowBound(to, 'to')
  if (!items.length && !act_on.length) return 'empty'
  const { landed } = await mail.post({
    id: `digest:${mailbox}:${repo}:${new Date(fromMs).toISOString()}:${new Date(toMs).toISOString()}`,
    mailbox, class: 'sec.log', urgency: 'p3',
    text: `exception digest for ${repo}: ${act_on.length} to act on, ${items.length} items`,
    block: { schema: 'swarm-digest@1', data: {
      batch, repo, window: { from, to }, counts: { p0, p1, p2, p3 }, act_on: [...act_on], items: Array.from(items, projectHeader),
    } },
  })
  return landed === 'new' ? 'posted' : 'existing'
}
