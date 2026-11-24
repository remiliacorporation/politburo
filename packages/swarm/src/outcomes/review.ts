import type { EvidenceValidation } from './evidence.ts'

export type ReviewRecord = {
  work_id: string
  evidence_sha256: string
  reviewer: string
  decision: 'accept' | 'reject'
  reason: string
  at: string
}

type ReviewerPolicy = { declared: string; claimant: string; jockeys: readonly string[] }

export function reviewerAllowed({ declared, actor, claimant, jockeys }: ReviewerPolicy & { actor: string }): boolean {
  return typeof actor === 'string' && actor.trim() !== '' && actor !== claimant &&
    (declared === 'jockey' ? jockeys.includes(actor) : actor === declared)
}

type CompletionInput = ReviewerPolicy & {
  workId: string
  validation: Pick<EvidenceValidation, 'workId' | 'result' | 'sha256'>
  reviews: readonly ReviewRecord[]
}

export function decideCompletion({ workId, validation, reviews, declared, claimant, jockeys }: CompletionInput): {
  complete: boolean
  reasons: string[]
} {
  const incomplete = (...reasons: string[]) => ({ complete: false, reasons })
  if (validation.result !== 'valid' || !validation.sha256) return incomplete('evidence is not valid')
  const ticket = workId.toLowerCase()
  if (validation.workId?.toLowerCase() !== ticket) return incomplete('evidence is for a different work id')

  let latest: ReviewRecord | undefined
  let latestAt = -Infinity
  for (const review of reviews) {
    if (typeof review.work_id !== 'string' || review.work_id.toLowerCase() !== ticket ||
        review.evidence_sha256 !== validation.sha256) continue
    const at = Date.parse(review.at)
    if (!Number.isFinite(at)) return incomplete('review has an invalid timestamp')
    // When timestamps tie, the last record in the supplied history wins.
    if (at >= latestAt) {
      latest = review
      latestAt = at
    }
  }
  if (!latest) return incomplete('no review for this work id and evidence sha256')

  const reasons: string[] = []
  if (!reviewerAllowed({ declared, actor: latest.reviewer, claimant, jockeys })) {
    reasons.push('latest reviewer is not allowed')
  }
  if (latest.decision === 'reject') {
    reasons.push(typeof latest.reason === 'string' && latest.reason.trim()
      ? 'latest review rejected the evidence'
      : 'reject review requires a non-empty reason')
  } else if (latest.decision !== 'accept') {
    reasons.push('latest review has an invalid decision')
  }
  return { complete: reasons.length === 0, reasons }
}
