import { createHmac, createSecretKey, timingSafeEqual, type KeyObject } from 'node:crypto'
import { isRecord, isSha } from './cli.ts'
import type { CheckResult, CodeHost, Pr, ReadyTransition } from './code-host.ts'

export type VerdictFields = Readonly<{ sha: string; reviewer: string; outcome: 'clean' | 'findings' }>
export type Verdict = VerdictFields & Readonly<{ signature: string }>

function hasFields(value: unknown): value is VerdictFields & Record<string, unknown> {
  return isRecord(value) && isSha(value.sha) && typeof value.reviewer === 'string' && value.reviewer.length > 0 &&
    (value.outcome === 'clean' || value.outcome === 'findings')
}

function mac({ sha, reviewer, outcome }: VerdictFields, key: KeyObject) {
  return createHmac('sha256', key).update(JSON.stringify([sha, reviewer, outcome]), 'utf8').digest()
}

/** The signature is lowercase hex HMAC-SHA256 of the UTF-8 JSON field tuple. */
export function signVerdict(fields: VerdictFields, key: Uint8Array): Verdict {
  if (!hasFields(fields) || !key.byteLength) throw new TypeError('invalid verdict fields or signing key')
  const { sha, reviewer, outcome } = fields
  return { sha, reviewer, outcome, signature: mac(fields, createSecretKey(key)).toString('hex') }
}

type Refusal = 'check_missing' | 'stale_check' | 'check_pending' | 'check_failed' |
  'review_missing' | 'stale_verdict' | 'invalid_signature' | 'review_findings' | Exclude<ReadyTransition, 'ready'>

export type GateResult = { status: 'ready'; sha: string } | { status: 'refused'; sha: string; reason: Refusal }

export function reviewGate({ host, key, checkFor, verdictsFor }: {
  host: CodeHost
  key: Uint8Array
  checkFor(sha: string): CheckResult | undefined | Promise<CheckResult | undefined>
  verdictsFor(pr: Pr): readonly unknown[] | Promise<readonly unknown[]>
}) {
  if (!key.byteLength) throw new TypeError('missing verdict signing key')
  const secret = createSecretKey(key)
  return {
    async markReadyIfAllowed(pr: Pr): Promise<GateResult> {
      const sha = await host.headSha(pr)
      const refuse = (reason: Refusal): GateResult => ({ status: 'refused', sha, reason })
      const check = await checkFor(sha)
      if (!check) return refuse('check_missing')
      if (check.sha !== sha) return refuse('stale_check')
      if (check.state === 'pending') return refuse('check_pending')
      if (check.state !== 'pass') return refuse('check_failed')

      const verdicts = await verdictsFor(pr)
      if (verdicts.length === 0) return refuse('review_missing')
      let stale = false
      let invalid = false
      let findings = false
      for (const verdict of verdicts) {
        if (!hasFields(verdict) || typeof verdict.signature !== 'string' || !/^[0-9a-f]{64}$/u.test(verdict.signature) ||
            !timingSafeEqual(mac(verdict, secret), Buffer.from(verdict.signature, 'hex'))) {
          invalid = true
          continue
        }
        if (verdict.sha !== sha) { stale = true; continue }
        if (verdict.outcome === 'findings') { findings = true; continue }
        const transition = await host.markReady(pr, sha)
        return transition === 'ready' ? { status: 'ready', sha } : refuse(transition)
      }
      return refuse(findings ? 'review_findings' : invalid ? 'invalid_signature' : stale ? 'stale_verdict' : 'review_missing')
    },
  }
}
