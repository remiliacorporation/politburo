export type Pr = number
export type DraftPr = Readonly<{ branch: string; title: string; body?: string }>
export type CheckResult = Readonly<{ sha: string; state: 'pass' | 'fail' | 'pending' }>
export type ReadyTransition = 'ready' | 'head_changed' | 'readiness_unfenced'

/** One repository. PR identity is scoped to this host. */
export interface CodeHost {
  /** Reuse an existing PR for this branch, including a closed or merged one. */
  openDraftPr(input: DraftPr): Promise<Pr>
  findPr(branch: string): Promise<Pr | null>
  headSha(pr: Pr): Promise<string>
  /** Run or observe checks on this exact commit, never on a moving ref. */
  runChecks(sha: string): Promise<CheckResult>
  /** Compare the expected head at the transition, or refuse if it can't be fenced. */
  markReady(pr: Pr, expectedSha: string): Promise<ReadyTransition>
}

const messages = {
  invalid_options: 'invalid GitHub adapter options',
  invalid_target: 'invalid PR number or commit sha',
  gh_failed: 'GitHub CLI request failed',
  unexpected_response: 'GitHub CLI returned an unexpected response',
  ambiguous_pr: 'more than one PR has this head branch',
  check_sha_mismatch: 'checks reported a different commit than requested',
} as const

export class CodeHostError extends Error {
  override name = 'CodeHostError'
  readonly reason: keyof typeof messages
  constructor(reason: keyof typeof messages) {
    super(messages[reason])
    this.reason = reason
  }
}
