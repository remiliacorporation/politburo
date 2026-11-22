import { DEFAULT_TASK_PRIORITY, priorityRank, type TaskPriority } from '../../contract/schemas.ts'
import { needsAttentionAnswer } from './attention-store.ts'
import { byClaim, claimable, lapsed } from './claim-order.ts'
import { byWritten, initialState, isTask, type State, type TaskRoot, type Viewer } from './store.ts'
import { ago, firstLine, until } from './words.ts'

export type SwarmRecords = {
  source: 'fixtures'
  parties: Record<string, { name: string; colour: string }>
  observations: Record<string, Observation>
}

export type Observation = {
  pr?: { number: number; state: 'draft' | 'open' | 'merged' | 'closed'; checks: 'pass' | 'fail' | 'pending' | 'none' | 'unknown'; head?: string }
  spend?: { tokens: number | null; coverage: 'complete' | 'partial' | 'unknown' | 'stale' }
  trackers?: { kind: 'gh' | 'lin' | 'bd' | 'native'; id: string }[]
  overlap?: { kind: 'branch' | 'pr' | 'tracker item' | 'possible'; with: string }[]
  contract?: 'valid' | 'invalid' | 'missing'
  humanRequest?: boolean
  evidenceStale?: boolean
  reviewRejected?: boolean
  sourceStale?: boolean
  leaseLive?: boolean
}

const GROUPS = [
  ['needs', 'Needs you'],
  ['repair', 'Repair or reconcile'],
  ['review', 'Ready to review'],
  ['running', 'Running'],
  ['pull', 'Ready to pull'],
  ['waiting', 'Waiting or parked'],
  ['done', 'Done'],
] as const
export type WorkGroup = (typeof GROUPS)[number][0]

export type WorkRow = {
  root: TaskRoot
  workId: string
  title: string
  priority: TaskPriority
  party: { id: string; name: string; colour: string } | null
  claimant: string | null
  group: WorkGroup
  reason: string
  claimText: string | null
  prText: string
  spendText: string
  trackers: NonNullable<Observation['trackers']>
  overlapText: string | null
  kind: 'code' | 'research' | 'report' | 'ops'
}

function workIdOf(root: TaskRoot): string | undefined {
  const id = root.labels['work.id']?.toLowerCase()
  return id && /^[a-z][a-z0-9]*-\d+$/.test(id) ? id : undefined
}

function classify(root: TaskRoot, obs: Observation | null | undefined, viewer: Viewer | null, now: number, state: State): [WorkGroup, string] {
  const { task } = root
  const contract = workIdOf(root) ? obs?.contract : undefined
  const overlap = obs?.overlap?.find(({ kind }) => kind === 'branch' || kind === 'pr')
  const expired = lapsed(root, now)
  const held = task.state === 'blocked' || !!task.parked
  if (task.state === 'completed' || task.state === 'failed' || task.state === 'canceled') return ['done', task.state]
  if (needsAttentionAnswer(state, root)) return ['needs', 'attention answer needed']
  if (contract === 'invalid' || contract === 'missing') return ['needs', `contract ${contract}`]
  if (obs?.humanRequest) return ['needs', 'human decision requested']
  if (expired) return ['repair', `claim lapsed ${ago(task.claim!.until, now)} ago`]
  if (obs?.evidenceStale) return ['repair', 'run evidence stale']
  if (obs?.pr?.checks === 'fail') return ['repair', 'CI failed']
  if (obs?.reviewRejected) return ['repair', 'review rejected']
  if (obs?.sourceStale) return ['repair', 'source stale']
  if (task.state === 'claimed' && overlap) return ['repair', `conflicting ${overlap.kind}`]
  if (obs?.pr?.state === 'open' && obs.pr.checks === 'pass' && !held) return ['review', 'checks pass, review needed']
  if (task.state === 'claimed' && task.claim) return ['running', obs?.leaseLive ? 'claim active' : 'claimed; liveness not confirmed']
  if (task.state === 'ready' && !held && !overlap) {
    if (viewer && !claimable(root, viewer, now)) return ['waiting', 'not available to your claim-next']
    return ['pull', 'ready to claim']
  }
  if (task.parked) return ['waiting', 'parked']
  if (held) return ['waiting', task.blocked?.reason || 'held']
  if (task.state === 'waiting' && task.needs.length > 0)
    return ['waiting', `waiting on ${task.needs.length} ${task.needs.length === 1 ? 'task' : 'tasks'}`]
  if (overlap) return ['waiting', `blocked by ${overlap.kind} overlap`]
  return ['waiting', task.state === 'claimed' ? 'claim details unknown' : 'not ready to claim']
}

/** Supply the read's state to account for attention answers already seen by the inspector. */
export function groupOf(root: TaskRoot, obs: Observation | null | undefined, viewer: Viewer | null, now: number, state = initialState): WorkGroup {
  return classify(root, obs, viewer, now, state)[0]
}

function claimText(claim: TaskRoot['task']['claim'], now: number): string | null {
  if (!claim) return null
  if (Date.parse(claim.until) <= now) return `expired ${ago(claim.until, now)} ago`
  const remaining = until(claim.until, now)
  return `expires ${remaining === 'now' ? 'in 0s' : remaining}`
}

const CHECKS = { pass: 'checks pass', fail: 'CI failed', pending: 'CI pending', none: 'no checks', unknown: 'checks unknown' }
function prText(pr: Observation['pr'], group: WorkGroup): string {
  if (!pr) return 'no PR'
  const number = `PR #${pr.number}`
  if (group === 'review') return `${number} · checks pass · review needed`
  if (pr.state === 'draft' && pr.checks === 'none') return `${number} draft`
  return `${number} ${pr.state} · ${CHECKS[pr.checks]}`
}

function spendText(spend: Observation['spend']): string {
  if (!spend || spend.tokens === null || spend.coverage === 'unknown') return 'unknown'
  const tokens = spend.tokens < 1000 ? String(spend.tokens) : `${Number((spend.tokens / 1000).toFixed(1))}k`
  return `${tokens} tokens · ${spend.coverage}`
}

function own<T>(record: Record<string, T> | undefined, key: string | undefined): T | undefined {
  return record && key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined
}

export function projectWork(state: State, records: SwarmRecords | null, viewer: Viewer | null, now: number) {
  const buckets = new Map<WorkGroup, WorkRow[]>(GROUPS.map(([group]) => [group, []]))
  for (const root of Object.values(state.openTaskRoots)) {
    if (!isTask(root) || root.deleted) continue
    const id = workIdOf(root)
    const obs = own(records?.observations, id)
    const partyId = root.labels.party
    const party = own(records?.parties, partyId)
    const kind = root.labels['work.kind']
    const [group, reason] = classify(root, obs, viewer, now, state)
    buckets.get(group)!.push({
      root, group, reason,
      workId: id ?? `#${root.id}`,
      title: firstLine(root.text),
      priority: root.task.priority ?? DEFAULT_TASK_PRIORITY,
      party: partyId ? { id: partyId, name: party?.name ?? partyId, colour: party?.colour ?? '' } : null,
      claimant: root.task.claim?.actor ?? null,
      claimText: claimText(root.task.claim, now),
      prText: prText(obs?.pr, group),
      spendText: spendText(obs?.spend),
      trackers: obs?.trackers ?? [],
      overlapText: obs?.overlap?.length ? `overlap: ${obs.overlap.map(({ kind, with: other }) => `${kind} with ${other}`).join(' · ')}` : null,
      kind: kind === 'research' || kind === 'report' || kind === 'ops' ? kind : 'code',
    })
  }
  const claimOrder = viewer && byClaim(viewer)
  const groups = GROUPS.flatMap(([group, title]) => {
    const rows = buckets.get(group)!
    if (!rows.length) return []
    rows.sort((a, b) => {
      const priority = priorityRank(b.priority) - priorityRank(a.priority)
      if (group === 'pull' && claimOrder) return claimOrder(a.root, b.root)
      if (group === 'running') return Date.parse(a.root.task.claim!.until) - Date.parse(b.root.task.claim!.until) || priority ||
        a.root.id.localeCompare(b.root.id, undefined, { numeric: true })
      if (group === 'review') return a.root.createdAt.localeCompare(b.root.createdAt) || priority || byWritten(a.root, b.root)
      return priority || byWritten(a.root, b.root)
    })
    return [{ group, title, rows }]
  })
  return { rows: groups.flatMap(({ rows }) => rows), groups }
}
