export const gates = ['submission', 'tests', 'review', 'browserQA', 'acceptance', 'publication'] as const
export type Gate = typeof gates[number]
export type GateStatus = 'pass' | 'fail' | 'missing' | 'expired' | 'waived'

type Binding = { taskId: string; round: number; commit: string; gate: Gate }
type Admission = Binding & { id: string; partyId: string; author: string; at: number; expiresAt: number }
export type ArtifactRef = { sha256: string } & ({ attachmentId: string } | { repo: string; commit: string; path: string })
export type Attestation = Admission & { kind: 'attestation'; verdict: 'pass' | 'fail'; artifactRef: ArtifactRef }
export type Override = Admission & { kind: 'override'; reason: string }
export type Evidence = Attestation | Override

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
export const fullCommit = (v: unknown): v is string => typeof v === 'string' && v.length === 40 && !/[^\da-f]/i.test(v)
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function isEvidence(value: unknown): value is Evidence {
  if (!object(value) || ![value.id, value.taskId, value.partyId, value.author].every(text) ||
    !Number.isSafeInteger(value.round) || Number(value.round) < 1 || !fullCommit(value.commit) ||
    !gates.some(gate => gate === value.gate) || !Number.isFinite(value.at) || !Number.isFinite(value.expiresAt)) return false
  if (value.kind === 'override') return text(value.reason)
  const ref = value.artifactRef
  if (value.kind !== 'attestation' || (value.verdict !== 'pass' && value.verdict !== 'fail') ||
    !object(ref) || typeof ref.sha256 !== 'string' || ref.sha256.length !== 64 || /[^\da-f]/i.test(ref.sha256)) return false
  return Object.keys(ref).length === 2 && text(ref.attachmentId) ||
    Object.keys(ref).length === 4 && text(ref.repo) && ref.commit === value.commit && text(ref.path) &&
    !/[:\\]/.test(ref.path) && ref.path.split('/').every(segment => segment && segment !== '..' && segment !== '.')
}

export function gateStatus(records: readonly Evidence[], { taskId, round, commit, gate, now }: Binding & { now: number }): GateStatus {
  if (!Number.isFinite(now) || !fullCommit(commit)) return 'missing'
  let verdict: Attestation | undefined
  let waiver = false
  for (const record of records) {
    if (record.taskId !== taskId || record.round !== round || record.commit !== commit || record.gate !== gate) continue
    if (record.kind === 'attestation') {
      verdict = record
      waiver = false
    } else if (verdict && gate !== 'submission' && record.expiresAt > now) waiver = true
  }
  return waiver ? 'waived' : !verdict ? 'missing' : verdict.expiresAt <= now ? 'expired' : verdict.verdict
}
