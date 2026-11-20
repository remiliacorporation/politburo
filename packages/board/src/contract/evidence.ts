import { z } from 'zod'
import { Author, MessageId, TaskNote, authorView, storable } from './schemas.ts'
import type { BoardEvent } from './events.ts'
import type { Message } from './folds.ts'

export const Commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'use a full lowercase Git commit ID')
export const AttestationGate = z.enum(['tests', 'review', 'browserQA', 'acceptance', 'publication'])
export const Gate = z.enum(['submission', ...AttestationGate.options])
export const Round = z.number().int().positive()
export const ArtifactRef = z.string().trim().min(1).max(1000).refine(storable)
export const Verdict = z.enum(['pass', 'fail'])
export const EvidenceExpiry = z.iso.datetime()
export const EvidenceReason = TaskNote.refine((reason) => reason.trim().length > 0, 'give a reason')

export type Gate = z.infer<typeof Gate>
export type AttestationGate = z.infer<typeof AttestationGate>
export type EvidencePolicy = {
  /** Enforce submission, tests and review at completion. Defaults to true when configured. */
  gates?: boolean
  browserQA?: boolean
  acceptance?: boolean
  publication?: boolean
  /** Require explicit resolution of each dependency. Defaults to false. */
  releaseDependencies?: boolean
  /** Verified principal IDs, not handles or profiles. Missing roles grant nothing. */
  attesters?: Partial<Record<AttestationGate, readonly string[]>>
  operators?: readonly string[]
  resolvers?: readonly string[]
}

const task = { id: MessageId, thread: z.string().min(1).max(200).refine(storable), by: Author }
const candidate = { commit: Commit, round: Round }
export const evidenceEvents = {
  'task.work_submitted': z.object({ ...task, ...candidate, revision: Round, artifactRef: ArtifactRef }),
  'task.work_evidence': z.object({ ...task, ...candidate, gate: AttestationGate, verdict: Verdict, artifactRef: ArtifactRef, expiresAt: EvidenceExpiry.nullable() }),
  'task.work_override': z.object({ ...task, ...candidate, gate: AttestationGate, reason: EvidenceReason, expiresAt: EvidenceExpiry }),
  'task.work_resolved': z.object({ ...task, needId: MessageId, evidenceId: z.string() }),
}

type Recorded = { id: string; taskId: string; round: number; commit: string; by: Author; at: string }
export type Evidence = Recorded & { gate: Gate; verdict: z.infer<typeof Verdict>; artifactRef: string; expiresAt: string | null }
export type Override = Recorded & { gate: AttestationGate; reason: string; expiresAt: string }
export type EdgeRelease = { needId: string; evidenceId: string }
export type EvidenceStatus = {
  required: Gate[]
  submission: Evidence | null
  evidence: Evidence[]
  overrides: Override[]
  releases: EdgeRelease[]
}

/** Bounded projection; previous candidates, verdicts and overrides remain in the event feed. */
export type TaskEvidence = {
  revision: number
  submission: Evidence
  evidence: Partial<Record<AttestationGate, Evidence>>
  overrides: Partial<Record<AttestationGate, Override>>
}

export const unexpired = (record: { expiresAt: string | null }, now: number) => record.expiresAt === null || Date.parse(record.expiresAt) > now

/** Without a current pause epoch, only evidence from completed tasks is eligible. */
export function currentEvidence(root: Message, now: number, pauseEpoch?: number) {
  const task = root.task
  const evidence = task?.evidence
  if (!task || !evidence || root.deleted || evidence.revision !== (root.revision ?? root.id) || evidence.submission.round !== task.epoch) return null
  const live = task.state === 'claimed' && (task.claim!.pauseEpoch ?? 0) === pauseEpoch && Date.parse(task.claim!.until) > now
  return task.state === 'completed' || live ? evidence : null
}

type EvidenceEvent = Extract<BoardEvent, { type: keyof typeof evidenceEvents }>

export function foldEvidence(root: Message, event: EvidenceEvent): boolean {
  const task = root.task
  if (!task || root.deleted) return false
  if (event.type === 'task.work_resolved') {
    const { needId, evidenceId } = event.payload
    if (!task.needs.includes(needId)) return false
    const releases = (task.releases ??= {})
    releases[needId] = evidenceId
    return true
  }
  const { id, by, commit, round } = event.payload
  const record = { id: String(event.index), taskId: String(id), by: authorView(by), commit, round, at: new Date(event.createdAt).toISOString() }
  if (event.type === 'task.work_submitted') {
    if (task.state !== 'claimed' || task.epoch !== round || task.evidence?.submission.round === round) return false
    const { revision, artifactRef } = event.payload
    task.evidence = { revision, submission: { ...record, artifactRef, gate: 'submission', verdict: 'pass', expiresAt: null }, evidence: {}, overrides: {} }
    return true
  }
  const state = task.evidence
  if (!state || state.submission.round !== round || state.submission.commit !== commit) return false
  const { gate } = event.payload
  if (event.type === 'task.work_override') state.overrides[gate] = { ...record, gate, expiresAt: event.payload.expiresAt, reason: event.payload.reason }
  else state.evidence[gate] = { ...record, gate, expiresAt: event.payload.expiresAt, verdict: event.payload.verdict, artifactRef: event.payload.artifactRef }
  return true
}
