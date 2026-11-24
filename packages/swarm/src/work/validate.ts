import type { Outcome, OutcomesContract } from './contract.ts'

export type Evidence =
  | { kind: 'pull_request'; url: string; repo: string; base: string; state: 'open' | 'merged' | 'closed'; draft: boolean; checks: 'pass' | 'fail' | 'pending' | 'absent' | 'unknown'; headSha: string }
  | { kind: 'report' | 'research'; path: string; digest: string; sections: string[]; reviewedBy: string | null }
  | { kind: 'ops'; receipt: string; accepted_by: string | null; ref: string; verification: string }

export type OutcomeCheck = {
  result: 'valid' | 'invalid' | 'unverifiable'
  outcome: { kind: string; index: number } | null
  evidence: { ref: string; revision: string } | null
}

const noMatch: OutcomeCheck = { result: 'invalid', outcome: null, evidence: null }
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const reference = (ref: string, revision: string) => nonblank(ref) && nonblank(revision) ? { ref, revision } : null

function review(by: string | null, reviewer: string | null): OutcomeCheck['result'] {
  if (!nonblank(by) || !nonblank(reviewer)) return 'unverifiable'
  return by === reviewer ? 'valid' : 'invalid'
}

function check(outcome: Outcome, index: number, observed: Evidence, reviewer: string | null): OutcomeCheck {
  let evidence: OutcomeCheck['evidence'] = null
  function result(result: OutcomeCheck['result']): OutcomeCheck {
    return { result, outcome: { kind: outcome.kind, index }, evidence }
  }
  if (outcome.kind === 'pull_request' && observed.kind === 'pull_request') {
    const prefix = `https://github.com/${outcome.repo}/pull/`
    if (typeof observed.draft !== 'boolean' || observed.repo !== outcome.repo || observed.base !== outcome.base ||
      typeof observed.url !== 'string' || !observed.url.startsWith(prefix) || !/^[1-9][0-9]*$/.test(observed.url.slice(prefix.length)) ||
      typeof observed.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(observed.headSha)) return result('unverifiable')
    evidence = { ref: observed.url, revision: observed.headSha }
    if (!['open', 'closed', 'merged'].includes(observed.state)) return result('unverifiable')
    if ((observed.state !== 'merged' && !(outcome.state === 'open_or_merged' && observed.state === 'open')) ||
      (observed.draft && outcome.draft !== 'allowed')) return result('invalid')
    if (outcome.checks === 'required_pass' && (observed.checks === 'fail' || observed.checks === 'absent')) return result('invalid')
    if (outcome.checks === 'required_pass' && observed.checks !== 'pass') return result('unverifiable')
    return result('valid')
  }
  if (outcome.kind === 'ops' && observed.kind === 'ops') {
    if (!nonblank(observed.ref) || observed.ref !== observed.ref.trim() || /\p{Cc}/u.test(observed.ref)) return result('unverifiable')
    const validRef = outcome.evidence === 'url'
      ? !/[\\\s]/.test(observed.ref) && URL.canParse(observed.ref)
      : !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(observed.ref)
    if (!validRef || !nonblank(observed.verification)) return result('unverifiable')
    evidence = reference(observed.ref, observed.receipt)
    if (!evidence) return result('unverifiable')
    if (observed.receipt !== outcome.receipt || observed.verification !== outcome.verification) return result('invalid')
    return result(review(observed.accepted_by, reviewer))
  }
  if ((outcome.kind === 'report' || outcome.kind === 'research') && observed.kind === outcome.kind) {
    if (!nonblank(observed.path) || typeof observed.digest !== 'string' ||
      !/^sha256:[0-9a-fA-F]{64}$/.test(observed.digest) || !Array.isArray(observed.sections)) return result('unverifiable')
    evidence = { ref: observed.path, revision: observed.digest }
    if (observed.path !== outcome.location ||
      !outcome.required_sections.every(section => observed.sections.includes(section))) return result('invalid')
    return result(review(observed.reviewedBy, reviewer))
  }
  return { ...noMatch }
}

/** Check caller observations for this attempt, without fetching or inferring evidence from a link. */
export function checkOutcomes(contract: OutcomesContract, evidence: readonly Evidence[]): OutcomeCheck {
  if (!evidence.length || !contract.outcomes.length) return { ...noMatch }
  const results = contract.outcomes.map((outcome, index) => {
    const candidates = evidence.filter(candidate => candidate.kind === outcome.kind)
      .map(candidate => check(outcome, index, candidate, contract.reviewer))
    return candidates.find(candidate => candidate.result === 'valid') ??
      candidates.find(candidate => candidate.result === 'unverifiable') ?? candidates[0] ?? { ...noMatch }
  })
  // Within an outcome, one candidate can still prove it. Across all_outcomes, a known failure takes precedence.
  const order = contract.completionRule === 'all_outcomes'
    ? ['invalid', 'unverifiable', 'valid'] : ['valid', 'unverifiable', 'invalid']
  for (const status of order) {
    const matches = results.filter(result => result.result === status)
    const chosen = matches.find(match => match.outcome !== null) ?? matches[0]
    if (chosen) return chosen
  }
  return { ...noMatch }
}
