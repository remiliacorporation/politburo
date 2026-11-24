import { outcomeRefId, ScoringInputError, type ScoreInput } from './inputs.ts'
import type { ScoreRules } from './rules.ts'
import { scoreParty, type Contribution, type PartyScore, type Ref } from './score.ts'

export type Row = {
  rank: number
  party: string
  total: number
  level: string
  milestones_reached: number
  unknown: number
}
export type ItemScore = {
  work_id: string | null
  total: number
  contributions: Contribution[]
}
export type Scorecard = PartyScore & { items: ItemScore[] }
export type Resolved = { ref: Ref; record: ScoreInput[keyof ScoreInput][number] }

type PartyAt = { party: string; asOf: string }
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

export function parties(input: ScoreInput): string[] {
  const ids = new Set<string>()
  for (const dispatch of input.dispatches) ids.add(dispatch.party)
  for (const { envelope } of input.spend) if (envelope !== null) ids.add(envelope.party)
  for (const outcome of input.outcomes) ids.add(outcome.party)
  for (const fact of input.facts) ids.add(fact.party)
  return [...ids].sort(cmp)
}

export function leaderboard(input: ScoreInput, rules: ScoreRules, { asOf }: { asOf: string }): Row[] {
  const scores = parties(input).map(party => scoreParty(input, rules, { party, asOf }))
    .sort((a, b) => b.total - a.total || cmp(a.party, b.party))
  let rank = 0
  return scores.map(({ party, total, level, milestones, unknown }, i) => {
    if (total !== scores[i - 1]?.total) rank = i + 1
    return {
      rank, party, total, level: level.name,
      milestones_reached: milestones.filter(milestone => milestone.reached_at !== null).length,
      unknown: unknown.items,
    }
  })
}

export function scorecard(input: ScoreInput, rules: ScoreRules, options: PartyAt): Scorecard {
  const score = scoreParty(input, rules, options)
  const byWork = new Map<string | null, ItemScore>()
  for (const contribution of score.contributions) {
    const { work_id, points } = contribution
    let item = byWork.get(work_id)
    if (!item) byWork.set(work_id, item = { work_id, total: 0, contributions: [] })
    item.total += points
    item.contributions.push(contribution)
  }
  const items = [...byWork.values()].sort((a, b) =>
    a.work_id === null ? 1 : b.work_id === null ? -1 : cmp(a.work_id, b.work_id))
  return { ...score, items }
}

export function history(input: ScoreInput, rules: ScoreRules, { party, asOfs }: { party: string; asOfs: string[] }) {
  return asOfs.toSorted((a, b) => Date.parse(a) - Date.parse(b)).map(asOf => {
    const { total, level, unknown } = scoreParty(input, rules, { party, asOf })
    return { asOf, total, level: level.name, unknown: unknown.items }
  })
}

export function drill(
  input: ScoreInput, rules: ScoreRules, { party, asOf, work_id }: PartyAt & { work_id: string | null },
): { item: ItemScore; records: Resolved[]; unknown: number } {
  const item = scorecard(input, rules, { party, asOf }).items.find(item => item.work_id === work_id)
  if (!item) throw new ScoringInputError('work_id', `no score contributions for ${work_id ?? 'party overhead'}`)
  const byKind = {
    spend: new Map(input.spend.map(record => [record.record_id, record])),
    dispatch: new Map(input.dispatches.filter(record => record.party === party)
      .map(record => [record.trace.execution_id, record])),
    outcome: new Map(input.outcomes.map(record => [outcomeRefId(record), record])),
    fact: new Map(input.facts.map(record => [record.fact_id, record])),
  }
  const records = item.contributions.flatMap(({ refs }) => refs.map(ref => {
    const record = byKind[ref.kind].get(ref.id)
    if (!record) throw new ScoringInputError(`${ref.kind}/${ref.id}`, 'missing referenced record')
    return { ref, record }
  }))
  return { item, records, unknown: item.contributions.filter(c => c.rule === 'unknown_spend').length }
}
