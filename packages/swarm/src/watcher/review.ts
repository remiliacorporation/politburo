import { isSha } from './status.ts'

export type ReviewLevel = 'none' | 'minor' | 'major' | 'blocker'

export function acceptVerdict({ outcome, level, commit, head }: {
  outcome: unknown; level: unknown; commit: unknown; head: string
}): { level: ReviewLevel } | { reason: 'invalid_verdict' | 'stale_verdict' | 'review_level_conflict' } {
  if (!isSha(commit) || (outcome !== 'clean' && outcome !== 'findings')) return { reason: 'invalid_verdict' }
  if (commit !== head) return { reason: 'stale_verdict' }
  const normalized = level === 'high' ? 'major' : level
  if (normalized !== 'none' && normalized !== 'minor' && normalized !== 'major' && normalized !== 'blocker') {
    return { reason: 'invalid_verdict' }
  }
  if (outcome === 'clean' && (normalized === 'major' || normalized === 'blocker')) {
    return { reason: 'review_level_conflict' }
  }
  return { level: normalized }
}
