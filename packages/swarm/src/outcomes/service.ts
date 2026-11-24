import type { Board, MessageView } from '@vercel/board'
import { parse } from 'yaml'
import { validateEvidence, type DeclaredOutcome, type EvidenceObject } from './evidence.ts'
import { isOutcomeKind } from './kinds.ts'
import { decideCompletion, type ReviewRecord } from './review.ts'
import { readRecords, readReviews, writeRecord, writeReview } from './store.ts'

export type SubmitOutcomeInput = {
  taskId: string; outcome: DeclaredOutcome & { index?: number }; evidence: EvidenceObject
  root: string; party: string; attempt: string; contractRevision: number
}
export type CompleteOutcomeInput = {
  taskId: string; declaredReviewer: string; jockeys: readonly string[]; validators: string[]
  root: string; party: string; attempt: string
  claim?: { epoch: number; token: string }
}

type OutcomeTask = MessageView & { task: NonNullable<MessageView['task']> }
async function taskThread(board: Board, taskId: string) {
  const { message, replies } = await board.thread(taskId)
  if (!message.task || message.deleted || message.id !== taskId) throw new Error('expected a live task root')
  return { task: message as OutcomeTask, replies, workId: outcomeWorkId(message) }
}

export const outcomeWorkId = (task: MessageView) => (task.labels['work.id'] ?? task.id).toLowerCase()

// Parse only the versioned outcome declaration, not arbitrary ticket prose.
export function outcomeContract(task: MessageView): { outcomes: DeclaredOutcome[]; reviewer: string } {
  let contract: { outcomes: DeclaredOutcome[]; reviewer: string } | undefined
  try {
    const parts = task.text.split(/^## Acceptable outcomes\s*\r?\n<!-- politburo-outcomes:v1 -->[ \t]*\r?\n/m)
    if (parts.length !== 2) throw new Error()
    const [list, verification] = parts[1]!.split(/^## Verification[ \t]*\r?\n/m)
    const yaml = list!.replace(/^- \[[ xX]\] ([^\n]*(?:\n {6}[^\n]*)*)/gm,
      (_, entry: string) => `- ${entry.replace(/\n {4}/g, '\n')}`)
    const outcomes: DeclaredOutcome[] = parse(yaml, { maxAliasCount: 0 })
    const policy = parse(verification?.split(/^#{1,2} /m)[0] ?? '', { maxAliasCount: 0 })
    if (Array.isArray(outcomes) && outcomes.length && outcomes.every((item) => typeof item?.kind === 'string') &&
        policy?.some?.((item: { completion_rule?: string }) => item?.completion_rule === 'any_outcome')) {
      const reviewers = policy.flatMap((item: { reviewer?: string }) => item?.reviewer === undefined ? [] : [item.reviewer])
      if (reviewers.length === 1 && typeof reviewers[0] === 'string' && reviewers[0].trim()) {
        contract = { outcomes, reviewer: reviewers[0] }
      }
    }
  } catch { /* malformed contract */ }
  if (!contract) throw new Error('task has no valid outcomes contract')
  for (const { kind, location } of contract.outcomes) {
    if (isOutcomeKind(kind) && (typeof location !== 'string' || !location.trim())) {
      throw new Error(`declared ${kind} outcome requires a location`)
    }
  }
  return contract
}

export async function submitOutcome(board: Board, input: SubmitOutcomeInput) {
  const { task, workId } = await taskThread(board, input.taskId)
  if (task.revision !== input.contractRevision) throw new Error('outcomes contract revision changed')
  const { outcomes } = outcomeContract(task)
  const index = input.outcome.index ?? outcomes.findIndex(({ kind }) => kind === input.outcome.kind)
  const outcome = outcomes[index]
  if (!outcome || outcome.kind !== input.outcome.kind || !isOutcomeKind(outcome.kind)) throw new Error('outcome is not declared')
  const { result, reasons, path, sha256 } = await validateEvidence({ ...input, outcome, workId })
  const record = await writeRecord(board, task.id, {
    work_id: workId, party: input.party, attempt: input.attempt, contract_revision: task.revision,
    outcome: result === 'valid' ? { kind: outcome.kind, index } : null, result,
    evidence: { path, sha256 }, verifier_version: '1', override: null,
  })
  return { record, reasons }
}

function latest({ task, workId, replies }: Awaited<ReturnType<typeof taskThread>>, validators?: string[]) {
  return readRecords(replies).findLast(({ record, author }) => (!validators || validators.includes(author)) &&
    record.work_id === workId && record.result === 'valid' &&
    record.contract_revision === task.revision && record.outcome && record.evidence.path && record.evidence.sha256)
}

export async function reviewOutcome(board: Board, input: { taskId: string } & Pick<ReviewRecord, 'decision' | 'reason'>) {
  const { decision, reason } = input
  if (decision !== 'accept' && decision !== 'reject') throw new Error('invalid review decision')
  if (decision === 'reject' && !reason.trim()) throw new Error('reject review requires a non-empty reason')
  const thread = await taskThread(board, input.taskId)
  const saved = latest(thread)
  if (!saved) throw new Error('no valid outcome to review')
  return writeReview(board, thread.task.id, {
    work_id: thread.workId, record: saved.id, evidence_sha256: saved.record.evidence.sha256!, decision, reason,
  })
}

export async function completeOutcome(board: Board, input: CompleteOutcomeInput) {
  const thread = await taskThread(board, input.taskId)
  const { task, workId, replies } = thread
  const incomplete = (...reasons: string[]) => ({ complete: false, reasons })
  let contract
  try { contract = outcomeContract(task) } catch (error) {
    return incomplete(error instanceof Error ? error.message : 'task has no valid outcomes contract')
  }
  const saved = latest(thread, input.validators ?? [])
  const record = saved?.record
  if (!saved || !record?.outcome) return incomplete('no valid outcome to complete')
  if (record.party !== input.party || record.attempt !== input.attempt) return incomplete('outcome does not match party and attempt')
  const { outcomes, reviewer } = contract
  const outcome = outcomes[record.outcome.index]
  if (!outcome || outcome.kind !== record.outcome.kind) return incomplete('outcome is not declared')
  if (reviewer !== input.declaredReviewer) return incomplete('reviewer does not match contract')
  const validation = await validateEvidence({ root: input.root, workId, outcome, evidence: {
    work_id: workId, kind: outcome.kind, path: record.evidence.path!, sha256: record.evidence.sha256!,
  } })
  if (validation.result !== 'valid') return incomplete(...validation.reasons)
  const reviews = readReviews(replies.slice(saved.offset + 1)).filter((review) => review.record === saved.id)
  const decision = decideCompletion({ workId, validation, reviews, declared: reviewer, jockeys: input.jockeys, claimant: saved.author })
  if (!decision.complete) return decision
  if (task.task.state === 'claimed' && !input.claim) return incomplete('completion requires the current claim')
  const hold = !input.claim && task.task.blocked?.kind === 'review' ? task.task.blocked : null
  if (hold) await board.tasks.unblock(task.id)
  let held
  try {
    held = input.claim ? board.tasks.held(task.id, input.claim) : await board.tasks.claim(task.id)
    await held.complete(`outcome evidence sha256 ${validation.sha256}`)
  } catch (error) {
    if (!input.claim) await held?.release().catch(() => {})
    if (hold) {
      try { await board.tasks.block(task.id, hold.reason, { kind: 'review' }) } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'outcome completion failed and the review hold could not be restored')
      }
    }
    throw error
  }
  return decision
}
