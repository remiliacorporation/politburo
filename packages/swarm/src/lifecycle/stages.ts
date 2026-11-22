import { gateStatus, type Evidence, type Gate, type GateStatus } from './evidence.ts'
export type { Gate } from './evidence.ts'

const open = ['proposed', 'scoped', 'implementing', 'review', 'repair', 'approved'] as const
export const stages = [...open, 'rejected', 'canceled', 'done'] as const
export type Stage = typeof stages[number]
export type Role = 'dispatcher' | 'scoper' | 'reviewer' | 'qa' | 'jockey' | 'service'
export type Actor = { id: string; role: Role }

type Check = 'intake_missing' | 'scope_missing' | 'outcomes_invalid' | 'dependency_unavailable' |
  'scope_stale' | 'waiting_on' | 'admission_refused' | 'claim_missing' | 'binding_missing' |
  'claim_lost' | 'handoff_missing' | 'outcome_missing' | 'head_changed' | 'fix_limit' | 'attempt_end_missing'
type ReasonCheck = 'repair_reason_missing' | 'rescope_reason_missing' | 'rejection_reason_missing' |
  'cancel_reason_missing' | 'reopen_reason_missing'
export type MoveRefusal = Check | ReasonCheck | 'claim_deadline' | 'submission_missing' | 'gate_closed' |
  'release_gate_closed' | 'stage_conflict' | 'forbidden' | 'board_paused' | 'task_parked' | 'reopen_completed_unsupported'
export type MoveResult = { ok: true; round: number } | {
  ok: false; reason: MoveRefusal; gate?: Gate; status?: GateStatus
}
export type MoveRoot = {
  taskId: string; paused?: boolean; parked?: boolean; checks?: Partial<Record<Check, boolean>>;
  commit?: string; claimCutoff?: number; finding?: boolean; revisionMismatch?: boolean;
  enabled?: readonly ('browserQA' | 'acceptance' | 'publication')[]; prerequisite?: boolean
}

type Rule = {
  from: readonly (Stage | null)[]; to: Stage; who: readonly Role[]; checks?: readonly Check[];
  gates?: readonly Gate[]; reason?: ReasonCheck; advance?: boolean; protective?: boolean
}
const approval = ['submission', 'tests', 'review', 'browserQA', 'acceptance'] as const
export const moves: readonly Rule[] = [
  { from: [null], to: 'proposed', who: ['dispatcher'], checks: ['intake_missing'] },
  { from: ['proposed'], to: 'scoped', who: ['scoper'], checks: ['scope_missing', 'outcomes_invalid', 'dependency_unavailable'] },
  { from: ['scoped', 'repair'], to: 'implementing', who: ['dispatcher'], checks: ['scope_stale', 'waiting_on', 'admission_refused', 'claim_missing', 'binding_missing'] },
  { from: ['implementing'], to: 'review', who: ['dispatcher'], checks: ['claim_lost', 'handoff_missing'], gates: ['submission'] },
  { from: ['review'], to: 'approved', who: ['scoper'], checks: ['handoff_missing'], gates: approval },
  { from: ['approved'], to: 'done', who: ['scoper'], checks: ['head_changed', 'handoff_missing'], gates: [...approval, 'publication'] },
  { from: ['review', 'approved'], to: 'repair', who: ['reviewer', 'qa', 'scoper'], reason: 'repair_reason_missing', checks: ['fix_limit'], advance: true, protective: true },
  { from: ['implementing'], to: 'repair', who: ['dispatcher'], checks: ['attempt_end_missing'], advance: true, protective: true },
  { from: open.slice(1), to: 'proposed', who: ['service'], reason: 'rescope_reason_missing', advance: true, protective: true },
  { from: open, to: 'rejected', who: ['scoper'], reason: 'rejection_reason_missing', protective: true },
  { from: [...open, 'rejected'], to: 'canceled', who: ['scoper', 'jockey'], reason: 'cancel_reason_missing', protective: true },
  { from: ['rejected'], to: 'proposed', who: ['scoper'], reason: 'reopen_reason_missing', advance: true },
]

export const refuse = (reason: MoveRefusal): MoveResult => ({ ok: false, reason })
export function decideMove({ stage, round, to, actor, reason, root, gates, now }: {
  stage: Stage | null; round: number | null; to: Stage; actor: Actor; reason?: string;
  root: MoveRoot; gates: readonly Evidence[]; now: number
}): MoveResult {
  if (stage === 'done') return refuse('reopen_completed_unsupported')
  const rule = moves.find(row => row.to === to && row.from.includes(stage))
  if (!rule || (stage === null ? round !== null : !Number.isSafeInteger(round) || round! < 1)) return refuse('stage_conflict')
  if (!actor.id.trim() || !rule.who.includes(actor.role)) return refuse('forbidden')
  if (!rule.protective && root.paused) return refuse('board_paused')
  if (!rule.protective && root.parked) return refuse('task_parked')
  if (rule.reason && !reason?.trim() && !(rule.reason === 'repair_reason_missing' && root.finding) &&
    !(rule.reason === 'rescope_reason_missing' && root.revisionMismatch)) return refuse(rule.reason)
  for (const check of rule.checks ?? []) {
    if (root.checks?.[check] !== true) return refuse(to === 'done' && check === 'handoff_missing' ? 'gate_closed' : check)
  }
  if ((to === 'approved' || to === 'done') && (root.enabled === undefined || root.prerequisite === undefined)) return refuse('gate_closed')
  for (const gate of rule.gates ?? []) {
    if (gate !== 'submission' && gate !== 'tests' && gate !== 'review' && !root.enabled?.includes(gate)) continue
    const status = gateStatus(gates, { taskId: root.taskId, round: round!, commit: root.commit ?? '', gate, now })
    if (status !== 'pass' && !(status === 'waived' && !(to === 'done' && root.prerequisite))) {
      if (gate === 'submission' && to !== 'done') return refuse('submission_missing')
      return { ok: false, reason: gate === 'publication' ? 'release_gate_closed' : 'gate_closed', gate, status }
    }
  }
  if (to === 'review') {
    if (root.checks?.outcome_missing !== true) return refuse('outcome_missing')
    if (!Number.isFinite(root.claimCutoff) || !(now < root.claimCutoff!)) return refuse('claim_deadline')
  }
  return { ok: true, round: round === null ? 1 : round + Number(rule.advance === true) }
}
