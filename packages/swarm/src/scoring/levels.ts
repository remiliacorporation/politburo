import type { Level, MilestoneRule, ScoreRules } from './rules.ts'
import type { Ref } from './score.ts'

export type StableMerge = { stableAt: number; fullyReported: boolean; refs: Ref[] }
export type Milestone = MilestoneRule & { reached_at: string | null; refs: Ref[] }

export function levelFor(rules: ScoreRules, total: number): Level {
  return { ...(rules.levels.findLast(level => level.min <= total) ?? rules.levels[0]!) }
}

export function milestonesFor(rules: ScoreRules, merges: readonly StableMerge[]): Milestone[] {
  const stable = merges.toSorted((a, b) => a.stableAt - b.stableAt)
  const reported = stable.filter(merge => merge.fullyReported)
  return rules.milestones.map(rule => {
    const credits = rule.metric === 'stable_merges' ? stable : reported
    const reached = credits[rule.at - 1]
    return {
      ...rule,
      reached_at: reached ? new Date(reached.stableAt).toISOString() : null,
      refs: reached ? credits.slice(0, rule.at).flatMap(merge => merge.refs) : [],
    }
  })
}
