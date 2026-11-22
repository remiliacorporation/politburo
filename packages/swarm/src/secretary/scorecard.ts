import type { LedgerQuery, LedgerReader, LedgerValue } from './ledger.ts'
import type { DecisionRecord } from './shadow.ts'

type ScoreInput = LedgerQuery & { records: readonly DecisionRecord[]; ledger: LedgerReader }

function divide(value: LedgerValue, by: LedgerValue): LedgerValue {
  return typeof value === 'number' && Number.isFinite(value)
    && typeof by === 'number' && Number.isFinite(by) && by > 0 ? value / by : 'unknown'
}

export async function scorecard({ records, ledger, tag, sinceMs, untilMs }: ScoreInput) {
  const query = { tag, sinceMs, untilMs }
  const [tokens, merged] = await Promise.all([ledger.tokens(query), ledger.mergedPrs(query)])
  // The log is tag-scoped. Use decision times for wakes, receipt times for the SLA cohort.
  const observed = records.filter(({ at }) => at <= untilMs)
  const receipts = new Set<string>()
  let wakes = 0
  for (const r of observed) {
    if (r.kind !== 'wake') continue
    if (r.at >= sinceMs) wakes++
    if (r.shadow || r.delivered) receipts.add(r.wakeId)
  }
  const forwards = new Map<string, { at: number; effective: boolean }>()
  for (const r of observed) {
    if (r.kind === 'lane') for (const { id } of r.items) {
      forwards.set(id, { at: r.at, effective: receipts.has(r.wakeId) })
    }
  }
  const late = { p0: 0, p1: 0 }
  const missed = { p0: 0, p1: 0 }
  const urgencies = new Set<'p0' | 'p1'>()
  for (const r of observed) {
    if ((r.kind !== 'accept' && r.kind !== 'revision') || !r.header || r.receivedAt < sinceMs) continue
    const { id, urgency } = r.header
    if (urgency !== 'p0' && urgency !== 'p1') continue
    urgencies.add(urgency)
    const deadline = r.receivedAt + (urgency === 'p0' ? 60_000 : 600_000)
    const forward = forwards.get(id)
    if (forward && forward.at > deadline) late[urgency]++
    if (untilMs > deadline && (!forward?.effective || forward.at > deadline)) missed[urgency]++
  }
  const known = observed.some(({ at }) => at >= sinceMs)
  return {
    tokens_per_merged_pr: divide(tokens, merged),
    wakes_per_day: divide(known ? wakes : 'unknown', (untilMs - sinceMs) / 86_400_000),
    tokens_per_wake: divide(tokens, wakes),
    late_p0: urgencies.has('p0') ? late.p0 : 'unknown', late_p1: urgencies.has('p1') ? late.p1 : 'unknown',
    missed_p0: urgencies.has('p0') ? missed.p0 : 'unknown', missed_p1: urgencies.has('p1') ? missed.p1 : 'unknown',
  }
}
