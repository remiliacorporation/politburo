import { DEFAULT_TASK_PRIORITY, priorityRank, type TaskPriority } from '../../contract/schemas.ts'
import { needsAttentionAnswer } from './attention-store.ts'
import { byClaim, claimable, lapsed } from './claim-order.ts'
import { byWritten, initialState, isTask, type State, type TaskRoot, type Viewer } from './store.ts'
import { ago, firstLine, until } from './words.ts'

export type SwarmRecords = {
  source: 'fixtures'
  parties: Record<string, {
    name: string
    colour: string
    openClaimLimit?: number
    labels?: { party_board?: string; repo_view?: string; mob_view?: string }
  }>
  observations: Record<string, Observation>
}

export type Observation = {
  attempt?: string | number
  branch?: string
  handoffReason?: string
  urls?: { source?: string; pr?: string; evidence?: string }
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
export const OPEN_WORK_GROUPS = GROUPS.map(([group]) => group).filter((group) => group !== 'done')

export const workGroupTitle = (group: WorkGroup) => GROUPS.find(([key]) => key === group)![1]

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
  leaseLive: boolean
  evidenceStale: boolean
  attempt?: Observation['attempt']
  branch?: Observation['branch']
  handoffReason?: Observation['handoffReason']
  pr?: Observation['pr']
  urls?: Observation['urls']
  prText: string
  prHead: string | null
  spendText: string
  spend: Observation['spend']
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

export function partyOf(records: SwarmRecords | null, partyId: string | null) {
  return own(records?.parties, partyId ?? undefined)
}

export function labelsOf(records: SwarmRecords | null, partyId: string | null, boardName = 'board') {
  const party = partyOf(records, partyId)
  return {
    partyBoard: { label: party?.labels?.party_board ?? 'Standing Committee', subtitle: `Standing Committee: ${party?.name ?? partyId ?? 'party'} board` },
    repoView: { label: party?.labels?.repo_view ?? 'Presidium', subtitle: `Presidium: ${boardName} repo` },
    mobView: { label: party?.labels?.mob_view ?? 'Cell', subtitle: 'Cell: one mob view' },
  }
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
      leaseLive: obs?.leaseLive === true,
      evidenceStale: obs?.evidenceStale === true,
      attempt: obs?.attempt,
      branch: obs?.branch,
      handoffReason: obs?.handoffReason,
      pr: obs?.pr,
      urls: obs?.urls,
      prText: prText(obs?.pr, group),
      prHead: obs?.pr?.head ?? null,
      spendText: spendText(obs?.spend),
      spend: obs?.spend,
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

type Party = { id: string | null; name: string; colour: string; openClaimLimit?: number }
type RunningRow = { row: WorkRow; liveness: 'live' | 'claimed; liveness not confirmed' }
type RunningParty = { party: Party; cells: Map<string | null, RunningRow[]> }
const byParty = (a: Party, b: Party) => Number(a.id === null) - Number(b.id === null) ||
  a.name.localeCompare(b.name) || (a.id ?? '').localeCompare(b.id ?? '')

function healthOf(rows: WorkRow[], now: number) {
  let active = 0, expiring = 0, stale = 0, reviewWip = 0
  let knownTokens = 0, unknownTokens = 0, unknownCoverage = 0, overlaps = 0
  for (const { root, group, evidenceStale, spend, overlapText } of rows) {
    const { state, claim } = root.task
    const left = claim ? Date.parse(claim.until) - now : NaN
    if (state === 'claimed' && left > 0) {
      active++
      if (left <= 30 * 60_000) expiring++
    }
    if (group !== 'done' && (lapsed(root, now) || evidenceStale)) stale++
    if (group === 'review') reviewWip++
    if (spend && spend.tokens !== null && Number.isFinite(spend.tokens) && spend.coverage !== 'unknown') knownTokens += spend.tokens
    else unknownTokens++
    if (!spend || spend.coverage === 'unknown' || spend.coverage === 'stale') unknownCoverage++
    if (overlapText) overlaps++
  }
  return { active, expiring, stale, reviewWip, knownTokens, unknownTokens, unknownCoverage, overlaps }
}

export function homeOf(rows: WorkRow[], records: SwarmRecords | null, now: number) {
  const needs: WorkRow[] = [], review: WorkRow[] = []
  const parties = new Map<string | null, { party: Party; rows: WorkRow[] }>(
    Object.entries(records?.parties ?? {}).map(([id, party]) => [id, { party: { ...party, id }, rows: [] }]),
  )
  const runningByParty = new Map<string | null, RunningParty>()
  let runningCount = 0
  for (const row of rows) {
    const id = row.party?.id ?? null
    let bucket = parties.get(id)
    if (!bucket) {
      bucket = { party: row.party ?? { id: null, name: 'external', colour: '' }, rows: [] }
      parties.set(id, bucket)
    }
    bucket.rows.push(row)
    if (row.group === 'needs') needs.push(row)
    if (row.group === 'review') review.push(row)
    if (row.group !== 'running') continue
    runningCount++
    let running = runningByParty.get(id)
    if (!running) {
      running = { party: bucket.party, cells: new Map() }
      runningByParty.set(id, running)
    }
    const cell = running.cells.get(row.claimant) ?? []
    cell.push({ row, liveness: row.leaseLive ? 'live' : 'claimed; liveness not confirmed' })
    running.cells.set(row.claimant, cell)
  }
  const running = [...runningByParty.values()].sort((a, b) => byParty(a.party, b.party)).map(({ party, cells }) => ({
    party,
    cells: [...cells].sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')).map(([claimant, rows]) => ({ claimant, rows })),
  }))
  const total = healthOf(rows, now)
  const perParty = [...parties.values()].sort((a, b) => byParty(a.party, b.party)).map(({ party, rows }) => ({
    party, ...healthOf(rows, now),
  }))
  const openClaimLimit = perParty.length > 0 && perParty.every(({ party }) => party.openClaimLimit !== undefined)
    ? perParty.reduce((sum, { party }) => sum + party.openClaimLimit!, 0) : undefined
  const health = { perParty, total: { ...total, openClaimLimit } }
  const counts = { needs: needs.length, review: review.length, running: runningCount, expiring: total.expiring }
  return { counts, needs, review, running, health }
}
