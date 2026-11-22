import type { MailPort, Urgency } from './mail-port.ts'
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

export type RolloutAck = { mailbox: string; version: number; acked: boolean; noticeAt: string }

export function exceptionDigest({ repo, window, headers, acks = [], now }: {
  repo: string; window: { from: string; to: string }; headers: readonly MessageHeader[]
  acks?: readonly RolloutAck[]; now: string | number | Date
}) {
  // Use a half-open interval so adjacent windows do not repeat boundary headers.
  const from = Date.parse(window.from), to = Date.parse(window.to)
  const nowMs = new Date(now).getTime()
  const open = new Map<string, MessageHeader>()
  for (const { id, urgency, class: kind, state, createdAt, expires, summary } of headers) {
    const at = Date.parse(createdAt)
    if (state !== 'open' || !(at >= from && at < to)) continue
    if ((urgency === 'p2' || urgency === 'p3') && expires && Date.parse(expires) < nowMs) continue
    open.set(id, { id, urgency, class: kind, state, createdAt, ...(expires === undefined ? {} : { expires }), summary })
  }
  // An outstanding rollout can span several windows. Keep showing it until acked.
  for (const { mailbox, version, acked, noticeAt } of acks) {
    if (acked || !(nowMs - Date.parse(noticeAt) >= 60 * 60_000)) continue
    const id = policyId(mailbox, version)
    open.set(id, {
      id, class: 'policy', urgency: 'p1', state: 'open', createdAt: noticeAt,
      summary: `${mailbox} has not acknowledged party config v${version}`,
    })
  }
  const sorted = [...open.values()].sort((a, b) =>
    a.urgency.localeCompare(b.urgency) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
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
  if (!digest.items.length && !digest.act_on.length) return 'empty'
  const { landed } = await mail.post({
    id: `digest:${mailbox}:${digest.batch}`, mailbox, class: 'sec.log', urgency: 'p3',
    text: `exception digest for ${digest.repo}: ${digest.act_on.length} to act on, ${digest.items.length} items`,
    block: { schema: 'swarm-digest@1', data: digest },
  })
  return landed === 'new' ? 'posted' : 'existing'
}
