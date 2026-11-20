import type { WorkSpec } from '../harness.ts'

export const failures = ['quota', 'auth', 'timeout', 'bad-output', 'verification-failed'] as const
export type AttemptFailure = typeof failures[number]

export type Model = Readonly<{ provider: string; model: string }>
export type RouteModel = Model & Readonly<{ maxCostMicros: number }>

export type AttemptContract = Readonly<{
  taskId: string
  attemptId: string
  target: RouteModel
  work: WorkSpec
}>

/** Evidence from the trusted executor/verifier, not from the model's response. */
export type Evidence = Readonly<{
  baseSha: string
  headSha: string
  changedPaths: readonly string[]
  passedCheckIds: readonly string[]
}>

/** A result confirms that execution has stopped. Unknown usage is charged at the attempt cap. */
export type AttemptResult = Readonly<{ costMicros: number | null }> & (
  | { outcome: AttemptFailure }
  | { outcome: 'candidate'; evidence: Evidence }
)

export const modelKey = ({ provider, model }: Model) => JSON.stringify([provider, model])
export const isAmount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export const isName = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(value)
const isSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)

function repoPath(path: string) {
  return typeof path === 'string' && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

export function duration(value: number, name: string) {
  if (!isAmount(value) || value < 1 || value > 2_147_483_647) throw new RangeError(`invalid ${name}`)
  return value
}

export function snapshotWork(input: WorkSpec): WorkSpec {
  const allowedPaths = [...input.allowedPaths]
  const requiredCheckIds = [...input.requiredCheckIds]
  const { wallMs, maxCostMicros } = input.limits
  duration(wallMs, 'wallMs')
  if (!isAmount(maxCostMicros)) throw new RangeError('invalid task budget')
  if (!isSha(input.baseSha) || !/^[a-f0-9]{64}$/.test(input.briefSha256) || !input.repo || !input.briefRef ||
    !allowedPaths.every((path) => repoPath(path.endsWith('/') ? path.slice(0, -1) : path)) ||
    !requiredCheckIds.every(isName)) throw new TypeError('invalid work contract')
  return Object.freeze({
    repo: input.repo, baseSha: input.baseSha, briefRef: input.briefRef, briefSha256: input.briefSha256,
    allowedPaths: Object.freeze(allowedPaths), requiredCheckIds: Object.freeze(requiredCheckIds),
    limits: Object.freeze({ wallMs, maxCostMicros }),
  })
}

export function verifies(work: WorkSpec, evidence: Evidence | undefined): evidence is Evidence {
  return !!evidence && evidence.baseSha === work.baseSha && typeof evidence.headSha === 'string' &&
    isSha(evidence.headSha) && evidence.headSha.length === work.baseSha.length &&
    Array.isArray(evidence.changedPaths) && Array.from(evidence.changedPaths).every((path) => repoPath(path) &&
      work.allowedPaths.some((allowed) => allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed)) &&
    Array.isArray(evidence.passedCheckIds) && work.requiredCheckIds.every((id) => evidence.passedCheckIds.includes(id))
}
