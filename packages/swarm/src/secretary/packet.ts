import type { Urgency } from './message.ts'
import { redact } from './redact.ts'
import type { Forward, MailHeader } from './route.ts'
import { wakeId } from './wake.ts'

export type PacketInput = {
  tag: string; lane: Forward['lane']; items: readonly MailHeader[]; now: number
  counts?: Record<Urgency, number>; act_on?: readonly string[]; missing?: readonly string[]
  generation?: string | number
}

function bounded(value: string) {
  const safe = redact(value)
  return safe.length > 200 ? safe.slice(0, 199) + '…' : safe
}

export function compilePacket({ tag, lane, items, now, counts, act_on, missing = [], generation = now }: PacketInput) {
  const totals = { p0: 0, p1: 0, p2: 0, p3: 0 }
  const headers: MailHeader[] = []
  for (const { id, class: mailClass, urgency, from, ref, summary, at } of items) {
    totals[urgency]++
    if (mailClass !== 'sec.log' || urgency === 'p0') {
      headers.push({ id: bounded(id), class: bounded(mailClass), urgency, from: bounded(from),
        ...(ref !== undefined && { ref: bounded(ref) }), summary: bounded(summary), at: bounded(at) })
    }
  }
  // Inputs are in receipt order; stable sort keeps the oldest at equal urgency.
  headers.sort((a, b) => a.urgency.localeCompare(b.urgency))
  const actions = new Set((act_on ?? items.filter((item) => item.class.startsWith('spawner.')
    || item.class === 'core.escalate').map(({ id }) => id)).map(bounded))
  const packet = {
    packetId: wakeId(tag, lane, items.map(({ id }) => id), generation), tag: bounded(tag), lane,
    generatedAt: new Date(now).toISOString(), items: [] as MailHeader[],
    counts: counts ? { p0: counts.p0, p1: counts.p1, p2: counts.p2, p3: counts.p3 } : totals,
    act_on: [] as string[], missing: [...new Set(missing.map(redact))], omitted: headers.length,
  }
  const cap = 12_800
  // A real p0 lane has one item. For mixed callers the cap is soft if p0 alone exceeds it.
  let low = headers.filter(({ urgency }) => urgency === 'p0').length
  let high = headers.length
  function keep(n: number) {
    packet.items = headers.slice(0, n)
    packet.act_on = [...new Set(packet.items.map(({ id }) => id).filter((id) => actions.has(id)))]
    packet.omitted = headers.length - n
  }
  keep(low)
  if (JSON.stringify(packet).length > cap) packet.missing = ['missing_list_truncated']
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    keep(mid)
    if (JSON.stringify(packet).length <= cap) low = mid
    else high = mid - 1
  }
  keep(low)
  return packet
}

export type CasePacket = ReturnType<typeof compilePacket>