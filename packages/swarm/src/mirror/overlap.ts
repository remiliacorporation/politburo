import type { MirrorStore } from './store.ts'
import { mirrorKinds, mirrorReasons, type MirrorClock, type MirrorRecord } from './types.ts'
import type { WorkItems } from './work-items.ts'

export type Conflict = Pick<MirrorRecord, 'kind' | 'key' | 'state' | 'draft' | 'title' | 'observedAt'> & {
  origin: 'origin branch' | 'open PR' | 'open draft PR' | 'tracker item'
}

export type OverlapResult = {
  workId: string
  repo: string
  status: 'clear' | 'conflicts' | 'partial'
  conflicts: Conflict[]
  gaps: string[]
}

export class OverlapError extends Error {
  override name = 'OverlapError'
  readonly reason = 'unknown_work_item'

  constructor() { super('unknown work item') }
}

// Accept repo-local numbers and explicit, same-repo GitHub issue references.
function issueKey(ref: string, repo: string): string | undefined {
  const local = /^#?([1-9][0-9]*)$/u.exec(ref)
  if (local) return local[1]
  const scoped = /^(?:https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/|([^/#]+\/[^/#]+)#)([1-9][0-9]*)$/iu.exec(ref)
  if ((scoped?.[1] ?? scoped?.[2])?.toLowerCase() === repo.toLowerCase()) return scoped?.[3]
}

export async function checkOverlap({ store, workItems, workId, now, maxAgeMs = 900_000 }: {
  store: Pick<MirrorStore, 'list'> & { status: Pick<MirrorStore['status'], 'read'> }
  workItems: WorkItems
  workId: string
  now: MirrorClock
  maxAgeMs?: number
}): Promise<OverlapResult> {
  const item = await workItems.get(workId)
  if (!item) throw new OverlapError()
  const { repo } = item
  const readStatuses = () => Promise.all(mirrorKinds.map((kind) => store.status.read({ repo, kind })))
  const statuses = await readStatuses()
  const records = await store.list({ repo })
  const after = await readStatuses()
  const time = new Date(now()).getTime()
  if (!Number.isFinite(time) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new RangeError('invalid overlap age')

  const gaps = new Set<string>()
  for (const [i, kind] of mirrorKinds.entries()) {
    const status = statuses[i]
    if (status?.observedAt !== after[i]?.observedAt || status?.complete !== after[i]?.complete) {
      gaps.add(`${kind}: mirror changed during read`)
    }
    if (!status) gaps.add(`${kind}: never read`)
    else if (!status.complete) {
      const reason = mirrorReasons.find((entry) => entry === status.reason)
      gaps.add(`${kind}: partial read${reason ? ` (${reason})` : ''}`)
    } else {
      const age = time - Date.parse(status.observedAt)
      if (!(age >= 0 && age <= maxAgeMs)) gaps.add(`${kind}: stale read`)
    }
  }

  const links = { branch: new Set(item.branches), pr: new Set(item.prs.map(String)), issue: new Set<string>() }
  for (const { source, ref } of item.trackerItems) {
    const key = source === 'github' ? issueKey(ref, repo) : undefined
    if (key) links.issue.add(key)
    else gaps.add(`tracker ${source}: not read`)
  }

  const conflicts: Conflict[] = []
  for (const { kind, key, state, draft, title, observedAt } of records) {
    if (!links[kind].delete(key) || (kind === 'branch' ? state === 'gone' : state !== 'open')) continue
    const origin = kind === 'branch' ? 'origin branch' : kind === 'issue' ? 'tracker item' : draft ? 'open draft PR' : 'open PR'
    conflicts.push({ kind, key, state, origin, observedAt,
      ...(draft !== undefined ? { draft } : {}), ...(title !== undefined ? { title } : {}) })
  }
  for (const [i, kind] of mirrorKinds.entries()) {
    if (kind !== 'branch' && statuses[i]?.complete) {
      for (const key of links[kind]) gaps.add(`${kind} #${key}: not in mirror`)
    }
  }
  return { workId, repo, status: conflicts.length ? 'conflicts' : gaps.size ? 'partial' : 'clear', conflicts, gaps: [...gaps] }
}
