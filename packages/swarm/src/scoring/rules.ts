import { ConfigError, validateConfig, type PartyConfig } from '../config/load.ts'

export type Level = { name: string; min: number }
export type MilestoneRule = { id: string; metric: 'stable_merges' | 'fully_reported_merges'; at: number }
export type ScoreRules = {
  state: 'off' | 'shadow' | 'on'
  merged_work: number
  stays_merged_days: number
  revert: number
  review_round: number
  free_review_rounds: number
  tokens_per_merged_pr: { target: number; tokens_per_point: number; max_penalty: number }
  human_minutes: { per_point: number; max_penalty: number }
  missed_claim: number
  unknown_spend: number
  levels: Level[]
  milestones: MilestoneRule[]
}

export function scoreRules(config: PartyConfig): ScoreRules {
  validateConfig(config)
  const rules: ScoreRules = structuredClone(config.score)
  for (let i = 1; i < rules.levels.length; i++) {
    if (rules.levels[i]!.min <= rules.levels[i - 1]!.min) {
      throw new ConfigError(`score.levels.${i}.min`, 'must be greater than the previous minimum')
    }
  }
  const ids = new Set<string>()
  for (const [i, { id }] of rules.milestones.entries()) {
    if (ids.has(id)) throw new ConfigError(`score.milestones.${i}.id`, 'duplicate id')
    ids.add(id)
  }
  rules.missed_claim *= config.claims.dock.missed_claim
  if (rules.missed_claim > 1_000_000) {
    throw new ConfigError('claims.dock.missed_claim', 'when multiplied by score.missed_claim, must not exceed 1000000')
  }
  return rules
}
