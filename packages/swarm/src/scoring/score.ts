import { currentHeads, outcomeRefId, ScoringInputError, type Fact, type ScoreInput } from './inputs.ts'
import { levelFor, milestonesFor, type Milestone, type StableMerge } from './levels.ts'
import type { Level, ScoreRules } from './rules.ts'

export type Ref = { kind: 'spend' | 'dispatch' | 'outcome' | 'fact'; id: string }
export type Contribution = {
  rule: 'merge_unverified' | 'revert' | 'merged_pending' | 'merged_work' | 'review_rounds' |
    'tokens_per_merged_pr' | 'unknown_spend' | 'human_minutes' | 'missed_claim'
  points: number
  work_id: string | null
  refs: Ref[]
}
export type PartyScore = {
  party: string
  asOf: string
  total: number
  level: Level
  milestones: Milestone[]
  contributions: Contribution[]
  unknown: { items: number }
  unmatched: { spend_records: number }
  state: ScoreRules['state']
}

type WorkSpend = { tokens: number; unknown: boolean; refs: Ref[] }
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const factRef = (fact: Fact): Ref => ({ kind: 'fact', id: fact.fact_id })
const attemptKey = ({ work_id, attempt }: { work_id: string; attempt: string }) => JSON.stringify([work_id, attempt])
const refOrder = (a: Ref, b: Ref) => cmp(a.id, b.id) || cmp(a.kind, b.kind)

function contributionOrder(a: Contribution, b: Contribution) {
  const group = cmp(a.work_id ?? '', b.work_id ?? '') || cmp(a.rule, b.rule)
  if (group) return group
  for (let i = 0; i < Math.min(a.refs.length, b.refs.length); i++) {
    const order = cmp(a.refs[i]!.id, b.refs[i]!.id)
    if (order) return order
  }
  return a.refs.length - b.refs.length
}

export function scoreParty(input: ScoreInput, rules: ScoreRules, { party, asOf }: { party: string; asOf: string }): PartyScore {
  const now = Date.parse(asOf)
  if (!Number.isFinite(now)) throw new ScoringInputError('asOf', 'invalid timestamp')
  const contributions: Contribution[] = []
  const add = (rule: Contribution['rule'], points: number, work_id: string | null, refs: Ref[]) => {
    if (!Number.isSafeInteger(points)) throw new RangeError(`score contribution for ${rule} is not a safe integer`)
    contributions.push({ rule, points: points || 0, work_id, refs })
  }
  const spendByWork = new Map<string | null, WorkSpend>()
  const workSpend = (id: string | null) => {
    let work = spendByWork.get(id)
    if (!work) spendByWork.set(id, work = { tokens: 0, unknown: false, refs: [] })
    return work
  }
  let items = 0
  let spend_records = 0
  const unknown = (work_id: string | null, ref: Ref) => {
    const work = workSpend(work_id)
    work.unknown = true
    work.refs.push(ref)
    items++
    add('unknown_spend', -rules.unknown_spend, work_id, [ref])
  }
  const reported = new Set<string>()
  for (const { envelope, tokens, coverage, record_id } of currentHeads(input.spend)) {
    if (envelope === null) {
      spend_records++
      continue
    }
    if (envelope.party !== party) continue
    reported.add(envelope.trace.execution_id)
    const ref: Ref = { kind: 'spend', id: record_id }
    if (coverage.state !== 'closed_reconciled' || tokens.input_total === null || tokens.output === null) {
      unknown(envelope.work_id, ref)
    } else {
      const work = workSpend(envelope.work_id)
      work.tokens += tokens.input_total + tokens.output
      work.refs.push(ref)
    }
  }
  for (const { party: owner, work_id, trace } of input.dispatches) {
    if (owner !== party) continue
    const ref: Ref = { kind: 'dispatch', id: trace.execution_id }
    if (reported.has(ref.id)) workSpend(work_id).refs.push(ref)
    else unknown(work_id, ref)
  }

  const facts = input.facts.filter(fact => fact.party === party && Date.parse(fact.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || cmp(a.fact_id, b.fact_id))
  const reverts = new Map<string, Ref>()
  const reviews = new Map<string, Ref[]>()
  const minutes: Ref[] = []
  let totalMinutes = 0
  let hasUnknownMinutes = false
  for (const fact of facts) {
    const id = fact.work_id
    if (fact.kind === 'reverted' && !reverts.has(id)) reverts.set(id, factRef(fact))
    if (fact.kind === 'review_round') {
      if (!reviews.has(id)) reviews.set(id, [])
      reviews.get(id)!.push(factRef(fact))
    }
    if (fact.kind === 'missed_claim') add('missed_claim', -rules.missed_claim, id, [factRef(fact)])
    if (fact.kind === 'human_minutes') {
      const ref = factRef(fact)
      minutes.push(ref)
      if (fact.minutes === null) {
        hasUnknownMinutes = true
        unknown(id, ref)
      } else {
        totalMinutes += fact.minutes
      }
    }
  }
  for (const [id, refs] of reviews) {
    const penalty = rules.review_round * (refs.length - rules.free_review_rounds)
    if (penalty > 0) add('review_rounds', -penalty, id, refs.sort(refOrder))
  }
  const humanPenalty = hasUnknownMinutes ? rules.human_minutes.max_penalty
    : Math.min(rules.human_minutes.max_penalty, Math.floor(totalMinutes / rules.human_minutes.per_point))
  if (humanPenalty > 0) add('human_minutes', -humanPenalty, null, minutes.sort(refOrder))

  const verified = new Map<string, Ref>()
  const outcomes = input.outcomes.filter(o => o.party === party && o.result === 'valid' && o.outcome && Date.parse(o.checked_at) <= now)
    .sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at) || cmp(a.checked_at, b.checked_at))
  for (const outcome of outcomes) {
    const key = attemptKey(outcome)
    if (!verified.has(key)) verified.set(key, { kind: 'outcome', id: outcomeRefId(outcome) })
  }
  const seen = new Set<string>()
  const stable: StableMerge[] = []
  const { target, tokens_per_point, max_penalty } = rules.tokens_per_merged_pr
  for (const fact of facts) {
    if (fact.kind !== 'merged') continue
    const key = attemptKey(fact)
    const id = fact.work_id
    const merge = factRef(fact)
    const outcome = verified.get(key)
    if (!outcome) {
      add('merge_unverified', 0, id, [merge])
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    const revert = reverts.get(id)
    const stableAt = Date.parse(fact.at) + rules.stays_merged_days * 86_400_000
    if (revert) add('revert', -rules.revert, id, [merge, revert])
    else if (stableAt > now) add('merged_pending', 0, id, [merge, outcome])
    else {
      const refs = [merge, outcome]
      const work = workSpend(id)
      stable.push({ stableAt, fullyReported: !work.unknown, refs })
      add('merged_work', rules.merged_work, id, refs)
      const penalty = work.unknown ? max_penalty : Math.min(max_penalty, Math.floor(Math.max(0, work.tokens - target) / tokens_per_point))
      if (penalty > 0) add('tokens_per_merged_pr', -penalty, id, work.refs.toSorted(refOrder))
    }
  }

  contributions.sort(contributionOrder)
  const total = contributions.reduce((sum, c) => sum + c.points, 0)
  if (!Number.isSafeInteger(total)) throw new RangeError('score total is not a safe integer')
  return {
    party, asOf, total, level: levelFor(rules, total), milestones: milestonesFor(rules, stable),
    contributions, unknown: { items }, unmatched: { spend_records }, state: rules.state,
  }
}
