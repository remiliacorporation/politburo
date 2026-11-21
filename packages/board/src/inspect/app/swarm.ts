import type { AttentionView, Me, TaskView } from '../../api/routes.ts'
import { priorityRank } from '../../contract/schemas.ts'
import { compileAccess } from '../../server/access.ts'
import { answerKey, blocksOnAttention, byWritten, isTask, stateNow, taskMatches, type State, type SwarmList, type SwarmListing, type TaskRoot } from './store.ts'

export type SwarmScope = { channel?: string; needs?: string }
export const swarmKey = (actor: string | undefined, { channel, needs }: SwarmScope) => JSON.stringify([actor, channel, needs])
export const RECENT_COMPLETED = 25

export function swarmListing(state: State, which: SwarmList, scope: SwarmScope): SwarmListing | undefined {
  const list = state.swarm.lists[which]
  return list?.key === swarmKey(state.me?.actor, scope) ? list : undefined
}

export function swarmMatches(root: TaskRoot, scope: SwarmScope, now: number): boolean {
  return taskMatches(root, { state: 'all', label: [], ...scope }, now) && (scope.needs === undefined || root.task.needs.includes(scope.needs))
}

/** Local claim-next scans by root log index. Remote refs are opaque; use the task's creation time there. */
function oldest(a: TaskRoot, b: TaskRoot): number {
  const index = /^(0|[1-9]\d{0,15})$/
  return index.test(a.id) && index.test(b.id) ? Number(a.id) - Number(b.id) : byWritten(a, b)
}

/** Like claim-next in server/tasks.ts: priority first, exact assignment at equal priority, then oldest. */
export function claimOrder(ready: readonly TaskRoot[], caller: Pick<Me, 'actor' | 'principal'> | null): TaskRoot[] {
  const assigned = ({ task }: TaskRoot) => Number(caller !== null && task.for === caller.actor && task.owner === caller.principal)
  return ready.toSorted((a, b) => priorityRank(b.task.priority) - priorityRank(a.task.priority) || assigned(b) - assigned(a) || oldest(a, b))
}

function rootsIn(state: State, list: SwarmListing | undefined, scope: SwarmScope, now: number): TaskRoot[] {
  // The cache supplies newer versions, not membership. The list may no longer grant read on a cached task.
  return list?.rows.is === 'here' ? list.rows.items.map((id) => state.messages[id]).filter(isTask).filter((root) => swarmMatches(root, scope, now)) : []
}

function readied(list: SwarmListing | undefined, { id, task }: TaskRoot): boolean {
  const claim = list?.readyClaims?.get(id)
  return task.state === 'claimed' && claim !== undefined && claim.epoch === task.epoch && claim.until === task.claim?.until
}

export function queueOf(state: State, scope: SwarmScope, now: number) {
  const queue: Record<'decisions' | 'ready' | 'claimed' | 'held' | 'parked', TaskRoot[]> = { decisions: [], ready: [], claimed: [], held: [], parked: [] }
  const open = swarmListing(state, 'open', scope)
  for (const root of rootsIn(state, open, scope, now)) {
    const current = readied(open, root) ? 'ready' : stateNow(root.task, now)
    if (current === 'ready' || current === 'claimed') queue[current].push(root)
    if (current === 'blocked') {
      const group = root.task.parked ? 'parked' : blocksOnAttention(state, root) ? 'decisions' : 'held'
      queue[group].push(root)
    }
  }
  for (const group of [queue.decisions, queue.claimed, queue.held, queue.parked]) group.sort(oldest)
  return { ...queue, ready: claimOrder(queue.ready, state.me) }
}

export type Phase = 'dispatched' | 'running' | 'held' | 'reported'

/** A lease, not a health check. Finished failures and cancellations don't establish a report. */
export function phaseOf(task: TaskView, now: number): Phase | null {
  switch (stateNow(task, now)) {
    case 'waiting':
    case 'ready': return 'dispatched'
    case 'claimed': return task.claim ? 'running' : null
    case 'blocked': return 'held'
    case 'completed': return 'reported'
    case 'failed':
    case 'canceled': return null
  }
}

export type Mob = {
  key: string
  session: string | null
  branch: string | null
  work: { root: TaskRoot; claim: NonNullable<TaskView['claim']>; phase: 'running' }[]
}

/** Bindings describe the live claim only. Two unbound claims aren't evidence of one mob. */
export function mobsOf(state: State, scope: SwarmScope, now: number): Mob[] {
  const groups = new Map<string, Mob>()
  const open = swarmListing(state, 'open', scope)
  for (const root of rootsIn(state, open, scope, now).sort((a, b) => byWritten(b, a))) {
    const claim = root.task.claim
    const phase = phaseOf(root.task, now)
    if (!claim || phase !== 'running' || readied(open, root)) continue
    const { binding } = claim
    const key = JSON.stringify(binding ? [binding.session, binding.branch] : [root.id])
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { key, session: binding?.session ?? null, branch: binding?.branch ?? null, work: [] }))
    group.work.push({ root, claim, phase })
  }
  return [...groups.values()]
}

/** The board lists oldest first; Mobs displays the newest reports first. */
export function completedOf(state: State, scope: SwarmScope, now: number): TaskRoot[] {
  return rootsIn(state, swarmListing(state, 'completed', scope), scope, now).reverse().filter(({ task }) => task.state === 'completed')
}

/** The board's status, or stale when the snapshot the viewer can see has already moved on. */
export function statusOf(state: State, root: TaskRoot, attention: AttentionView, now: number): AttentionView['status'] {
  if (attention.status !== 'pending') return attention.status
  const changed = attention.evidence.some(({ message, revision }) => {
    const known = state.messages[message]
    return known && (known.revision > revision || (known.revision === revision && known.deleted))
  })
  return changed || root.revision > attention.revision || now >= Date.parse(attention.expiresAt) ? 'stale' : 'pending'
}

/** A reason not to offer an answer. The channel's responder roster isn't in the API; the board checks it on write. */
export function answerDisabled(state: State, root: TaskRoot, attention: AttentionView, now: number): string | null {
  const status = statusOf(state, root, attention, now)
  if (status !== 'pending') return `this decision is ${status}`
  const { task, channel } = root
  if (root.deleted || task.state !== 'blocked' || task.parked || task.attentionId !== attention.id) return 'this decision no longer holds the task'
  const me = state.me
  if (!me || me.kind !== 'person' || me.profile !== null || me.actor !== me.principal) return 'answer as a person without a profile'
  const access = compileAccess(me.can)
  if (!access.can('read', channel) || !access.can('post', channel)) return 'answering needs read and post in this channel'
  const answer = state.swarm.answers[answerKey(me.actor, root.id, attention.id)]
  if (answer?.is === 'sending') return 'sending answer…'
  if (answer?.is === 'failed' && (answer.status === 403 || answer.code === 'no_task_attention')) return answer.why
  return null
}
