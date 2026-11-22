import { acceptStatus, isSha, type Binding, type StatusHead, type StatusRefusal } from './status.ts'

type Awaitable<T> = T | Promise<T>

// Repo-scoped interfaces mirror runtime's; ancestry and draft reconciliation need adapter support.
export interface RefStore {
  read(branch: string, path: string): Promise<{ head: string | null; text: string | null }>
}
type RepoRefs = RefStore & { isAncestor(ancestor: string, descendant: string): Promise<boolean> }
type Draft = Readonly<{ branch: string; title: string; body?: string }>
type Pr = Readonly<{ number: number; state: 'draft' | 'ready' | 'closed' | 'merged' }>
type Check = 'pass' | 'fail' | 'pending'
export interface CodeHost {
  findPr(branch: string): Promise<Pr | null>
  // Create at sha, not the moving branch tip; reuse by branch identity, including history.
  openDraftPr(input: Draft & { readonly sha: string }): Promise<Pr>
  headSha(prOrBranch: number | string): Promise<string>
  runChecks(sha: string): Promise<{ sha: string; state: Check }> // Read only, even while paused.
  convertToDraft(pr: number, expectedHead: string): Promise<void>
}

export type Attempt = Draft & Readonly<{
  repo: string; statusBranch: string; expected: Binding; epoch: number
  taskId: string; round: number; launchedAt: number; staleMs: number
  submitter: string; reviewer?: string
}>
export type Observation = {
  status: 'working' | 'finished' | 'stale' | 'unknown' | 'refused'
  repo: string; taskId: string; round: number; attempt: string; epoch: number; stale: boolean
  reason?: StatusRefusal | 'head_changed' | 'pr_history'
  candidate?: string; pr?: number; head?: string; check?: Check | 'unknown'
  voidedHead?: string; draftPending?: boolean
}
// Stage service stub boundary: these are projections, never evidence admissions.
export interface Observer { observe(event: Observation): Awaitable<void> }
// Launch journal stub boundary: start revalidates admission and head, and reconciles by stable identity.
export interface Reviewer {
  start(attempt: { key: string; work: Attempt; reviewer: string; pr: number; commit: string }): Awaitable<void>
}
export interface Control { epoch(): Awaitable<number | 'unknown'> }
export type StatusRow = {
  cursor?: StatusHead & { receivedAt: number }; dueAt: number; failures: number
  staleReported?: boolean; retired?: boolean; pr?: number; reviewRequested?: boolean
}
export interface StatusTable {
  get(key: string): Awaitable<StatusRow | undefined>
  set(key: string, row: StatusRow): Awaitable<void>
}

// Durable status storage is a follow-up; this table is for shadow runs and tests.
export function memoryStatusTable(): StatusTable {
  const rows = new Map<string, StatusRow>()
  return { get: key => structuredClone(rows.get(key)), set: (key, row) => { rows.set(key, structuredClone(row)) } }
}

type Options = {
  refs(repo: string): RepoRefs; host(repo: string): CodeHost
  control: Control; table: StatusTable; observer: Observer; reviewer?: Reviewer
  now(): number; jitter(): number; pollMs?: number
}

export function createWatcher({ refs, host, control, table, observer, reviewer, now, jitter, pollMs = 1000 }: Options) {
  const keyOf = (a: Attempt) => JSON.stringify([a.repo, a.taskId, a.round, a.expected.attempt])
  const canWrite = async (a: Attempt) => {
    try { return await control.epoch() === a.epoch } catch { return false }
  }

  async function poll(a: Attempt, key: string) {
    const row: StatusRow = await table.get(key) ?? { dueAt: -Infinity, failures: 0 }
    const stale = () => now() - (row.cursor?.receivedAt ?? a.launchedAt) >= a.staleMs
    const event: Observation = {
      repo: a.repo, taskId: a.taskId, round: a.round, attempt: a.expected.attempt, epoch: a.epoch,
      status: 'unknown', stale: false,
    }
    async function publish() {
      row.staleReported = stale()
      event.stale = row.staleReported || event.status === 'stale'
      if (event.stale && (event.status === 'working' || event.status === 'finished')) event.status = 'stale'
      await table.set(key, row)
      await observer.observe({ ...event })
    }
    if (now() < row.dueAt) {
      if (stale() && !row.staleReported) { event.status = 'stale'; await publish() }
      return
    }

    let failed = false
    function unknown() {
      if (failed) return
      failed = true
      row.failures = Math.min(16, row.failures + 1)
      const delay = pollMs * 2 ** (row.failures - 1) * (1 + Math.max(0, Math.min(1, jitter())))
      row.dueAt = now() + Math.min(30_000, delay)
      event.status = 'unknown'
      if (event.candidate) event.check = 'unknown'
    }

    async function readStatus() {
      const store = refs(a.repo)
      const { head, text } = await store.read(a.statusBranch, 'status.json')
      if (head === null || text === null) return
      const previous = row.cursor
      const result = acceptStatus({ previous, next: { head, text, descends: true }, expected: a.expected })
      if ('status' in result && previous && !await store.isAncestor(previous.head, head)) {
        return { reason: 'status_out_of_order' } as const
      }
      return result
    }

    const result = await readStatus().catch(() => undefined)
    const usable = result && ('status' in result || result.reason === 'no_op')
    if (!result) unknown()
    else row.dueAt = now() + pollMs
    if (result && 'status' in result) {
      row.cursor = { ...result.status, receivedAt: now() }
      row.failures = 0
      await table.set(key, row)
    } else if (result && !usable) {
      event.status = 'refused'
      event.reason = result.reason
    }

    const cursor = row.cursor
    if (usable && cursor) event.status = stale() ? 'stale' : cursor.state
    if (cursor?.state !== 'finished') {
      if (usable) row.failures = 0
      await publish()
      return
    }

    const candidate = cursor.publishedSha
    event.candidate = candidate
    event.check = 'unknown'
    async function inspect(code: CodeHost) {
      let pr = await code.findPr(a.branch)
      const opened = pr === null
      if (!pr) {
        if (!usable) return
        if (row.pr !== undefined || row.retired) { unknown(); return }
        const branchHead = await code.headSha(a.branch)
        if (!isSha(branchHead)) { unknown(); return }
        if (branchHead !== candidate) { event.reason = 'head_changed'; unknown(); return }
        if (!await canWrite(a)) return
        pr = await code.openDraftPr({ branch: a.branch, title: a.title, body: a.body, sha: candidate })
      }
      if (row.pr !== undefined && row.pr !== pr.number) { unknown(); return }
      const number = row.pr = event.pr = pr.number
      const historical = pr.state === 'closed' || pr.state === 'merged'
      const needsDraft = pr.state === 'ready'

      async function readHead() {
        const head = await code.headSha(number)
        if (!isSha(head)) throw new Error('unknown PR head')
        return event.head = head
      }
      async function retire(head: string) {
        row.retired = true
        event.reason ??= 'head_changed'
        event.voidedHead = candidate
        event.draftPending = needsDraft
        if (needsDraft && await canWrite(a)) {
          await publish()
          if (!await canWrite(a)) return
          await code.convertToDraft(number, head)
          event.draftPending = false
        }
      }
      const head = opened || !historical ? await readHead() : undefined
      if (head !== undefined && (head !== candidate || (!historical && row.retired))) {
        if (opened) event.status = 'stale'
        await retire(head)
        return
      }
      if (historical) {
        event.reason ??= 'pr_history'
        if (row.retired) event.draftPending = false
        return
      }
      if (!usable || head === undefined) return
      const check = await code.runChecks(head)
      const current = await readHead()
      if (current !== head) { await retire(current); return }
      if (check.sha !== head || (check.state !== 'pass' && check.state !== 'fail' && check.state !== 'pending')) {
        unknown()
        return
      }
      event.check = check.state
    }

    if (row.retired) { event.voidedHead = candidate; event.draftPending = true }
    try { await inspect(host(a.repo)) } catch { unknown() }
    if (!failed && usable) row.failures = 0
    await publish()

    async function requestReview({ pr, check }: Observation) {
      if (!reviewer || !a.reviewer || !a.submitter || a.reviewer === a.submitter || pr === undefined ||
          check !== 'pass' || row.retired || row.reviewRequested || stale() || !await canWrite(a)) return
      const review = { key: JSON.stringify(['review', key, pr, candidate]), work: a, reviewer: a.reviewer, pr, commit: candidate }
      row.reviewRequested = true
      await table.set(key, row)
      const latest = await Promise.resolve().then(() => host(a.repo).headSha(pr)).catch(() => undefined)
      if (latest !== candidate) {
        row.reviewRequested = false
        if (isSha(latest)) {
          row.retired = true
          event.head = latest
          event.reason = 'head_changed'
          event.voidedHead = candidate
          event.draftPending = true
        }
        unknown()
        await publish()
        return
      }
      if (stale() || !await canWrite(a)) {
        row.reviewRequested = false
        await table.set(key, row)
        return
      }
      // A thrown start may have sent; only the journal may reconcile it.
      try { await reviewer.start(review) } catch { unknown(); await publish() }
    }
    await requestReview(event)
  }

  let tail = Promise.resolve()
  return {
    // The caller resolves attempts from trusted configuration.
    tick(attempts: readonly Attempt[]): Promise<void> {
      const ordered = new Map(attempts.map(a => [keyOf(a), a]))
      const run = tail.then(async () => {
        for (const key of [...ordered.keys()].sort()) await poll(ordered.get(key)!, key)
      })
      tail = run.catch(() => {})
      return run
    },
  }
}
