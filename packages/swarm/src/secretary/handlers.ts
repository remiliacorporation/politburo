import type { MailHeader } from './route.ts'

export type Fact<T = boolean> = T | 'unknown'
export type Verdict = {
  action: 'hold' | 'needs_spawner' | 'push' | 'retry' | 'retire' | 'ack'
  reason: string
  missing: string[]
}
export type PushJob = {
  repo: string; ref: string; expectedBase: string; artifactDigest: string; check: string
}
export interface JobSource {
  job(tag: string, ref: string): PushJob | 'unknown' | undefined
  base(tag: string, ref: string): Fact<string>
  failure?(tag: string, ref: string): { code: string; retries: number } | 'unknown'
}
export type RetireFacts = Record<'headOnOrigin' | 'cleanWorktree' | 'noRunningSprite' | 'noLiveClaim' | 'approvedCompletion', Fact>
export interface RetireEvidence {
  inspect(tag: string, ref: string): { mob: RetireFacts; sprites: readonly (RetireFacts | undefined)[] | 'unknown' } | 'unknown'
}
export interface RolloutLedger {
  validated(tag: string, version: string): Fact
}

const verdict = (action: Verdict['action'], reason: string, missing: string[] = []): Verdict => ({ action, reason, missing })
const transient = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])

export function handlePush(item: Pick<MailHeader, 'ref' | 'class'>, tag: string, jobs?: JobSource): Verdict {
  if (item.ref === undefined) return verdict('hold', 'hold_missing_job', ['job'])
  const job = jobs?.job(tag, item.ref)
  if (!job || job === 'unknown' || [job.repo, job.ref, job.expectedBase, job.artifactDigest, job.check]
    .some((value) => !value || value === 'unknown')) {
    return verdict('hold', 'hold_missing_job', ['job'])
  }
  if (job.repo !== tag || job.ref !== item.ref) return verdict('needs_spawner', 'job_scope_mismatch')
  const base = jobs?.base(tag, item.ref) ?? 'unknown'
  if (base === 'unknown') return verdict('hold', 'unknown', ['base'])
  if (base !== job.expectedBase) return verdict('needs_spawner', 'base_moved')
  if (item.class !== 'sec.retry') return verdict('push', 'job_ready')
  const failure = jobs?.failure?.(tag, item.ref) ?? 'unknown'
  if (failure === 'unknown') return verdict('hold', 'unknown', ['failure'])
  if (!transient.has(failure.code) || failure.retries !== 0) return verdict('needs_spawner', 'not_retryable')
  return verdict('retry', 'transient_failure')
}

const retireChecks = ['headOnOrigin', 'cleanWorktree', 'noRunningSprite', 'noLiveClaim', 'approvedCompletion'] as const

export function handleRetire(item: Pick<MailHeader, 'ref'>, tag: string, evidence?: RetireEvidence): Verdict {
  if (item.ref === undefined) return verdict('hold', 'unknown', ['mob', 'sprites'])
  const snapshot = evidence?.inspect(tag, item.ref) ?? 'unknown'
  if (snapshot === 'unknown') return verdict('hold', 'unknown', ['mob', 'sprites'])
  const missing: string[] = []
  let blocked = false
  function check(label: string, facts: RetireFacts) {
    for (const fact of retireChecks) {
      if (facts[fact] === false) blocked = true
      else if (facts[fact] !== true) missing.push(`${label}.${fact}`)
    }
  }
  check('mob', snapshot.mob)
  if (snapshot.sprites === 'unknown') missing.push('sprites')
  else for (let i = 0; i < snapshot.sprites.length; i++) {
    const sprite = snapshot.sprites[i]
    if (sprite === undefined) missing.push(`sprites.${i}`)
    else check(`sprites.${i}`, sprite)
  }
  if (missing.length) return verdict('hold', 'unknown', missing)
  return blocked ? verdict('hold', 'retire_blocked') : verdict('retire', 'retire_ready')
}

export function handleRolloutAck(item: Pick<MailHeader, 'ref'>, tag: string, ledger?: RolloutLedger): Verdict {
  if (item.ref === undefined) return verdict('hold', 'unknown', ['rollout_validation'])
  const validated = ledger?.validated(tag, item.ref) ?? 'unknown'
  if (validated === 'unknown') return verdict('hold', 'unknown', ['rollout_validation'])
  return validated ? verdict('ack', 'version_validated') : verdict('hold', 'version_not_validated')
}