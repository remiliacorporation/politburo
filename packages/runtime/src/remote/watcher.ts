import { isRecord, parseJson } from './cli.ts'
import { CodeHostError, type CheckResult, type CodeHost, type DraftPr, type Pr } from './code-host.ts'
import type { RefStore } from './ref-store.ts'

export type WatchWork = DraftPr & { statusBranch: string }
export type RemoteWatchResult = { status: 'not_finished' } | { status: 'checked'; pr: Pr; check: CheckResult }

export class InvalidRemoteStatus extends Error {
  override name = 'InvalidRemoteStatus'
  readonly reason = 'invalid_status'
  constructor() { super('status.json must specify a working or finished state') }
}

/** Poll one explicitly selected work branch. Checks are retained by SHA for this watcher instance. */
export function watchRemote({ refs, host }: { refs: RefStore; host: CodeHost }) {
  const checks = new Map<string, CheckResult>()
  const opening = new Map<string, Promise<Pr>>()
  async function prFor(input: DraftPr) {
    const pending = opening.get(input.branch)
    if (pending) return pending
    const open = (async () => await host.findPr(input.branch) ?? await host.openDraftPr(input))()
    opening.set(input.branch, open)
    try { return await open } finally { opening.delete(input.branch) }
  }

  return {
    checkFor(sha: string): CheckResult | undefined {
      const check = checks.get(sha)
      return check && { ...check }
    },
    async poll({ statusBranch, ...draft }: WatchWork): Promise<RemoteWatchResult> {
      const { text } = await refs.read(statusBranch, 'status.json')
      if (text === null) return { status: 'not_finished' }
      const status = parseJson(text)
      if (!isRecord(status) || (status.state !== 'working' && status.state !== 'finished')) throw new InvalidRemoteStatus()
      if (status.state === 'working') return { status: 'not_finished' }
      const pr = await prFor(draft)
      const sha = await host.headSha(pr)
      const result = await host.runChecks(sha)
      if (result.sha !== sha) throw new CodeHostError('check_sha_mismatch')
      const check = { ...result }
      checks.set(sha, check)
      return { status: 'checked', pr, check: { ...check } }
    },
  }
}
