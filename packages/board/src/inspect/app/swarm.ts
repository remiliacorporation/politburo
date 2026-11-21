import type { AttentionView, Me, TaskView } from '../../api/routes.ts'
import { priorityRank } from '../../contract/schemas.ts'
import { answerKey, attentionOf, blocksOnAttention, byWritten, isTask, readAccess, stateNow, taskMatches, type State, type TaskFilter, type TaskRoot, type TaskState } from './store.ts'

export type SwarmScope = { channel?: string; needs?: string }
export const RECENT_COMPLETED = 25

/** Local claim-next scans by root log index. Remote refs are opaque; use creation time there. */
function oldest(a: TaskRoot, b: TaskRoot): number {
  const index = /^(0|[1-9]\d{0,15})$/
  return index.test(a.id) && index.test(b.id) ? Number(a.id) - Number(b.id) : byWritten(a, b)
}

/** Like claim-next: priority first, exact assignment at equal priority, then oldest. */
export function claimOrder(ready: readonly TaskRoot[], caller: Pick<Me, 'actor' | 'principal'> | null): TaskRoot[] {
  const assigned = ({ task }: TaskRoot) => Number(caller !== null && task.for === caller.actor && task.owner === caller.principal)
  return ready.toSorted((a, b) => priorityRank(b.task.priority) - priorityRank(a.task.priority) || assigned(b) - assigned(a) || oldest(a, b))
}

/** Task pages and live events share one cache. Current access, not cache membership, decides what shows. */
export function swarmRoots(state: State, scope: SwarmScope, now: number): TaskRoot[] {
  const access = readAccess(state)
  const filter: TaskFilter = { state: 'all', label: [], ...scope }
  return Object.values(state.messages).filter(isTask).filter((root) =>
    access.readable(root.channel) && taskMatches(root, filter, now) && (scope.needs === undefined || root.task.needs.includes(scope.needs)))
}

/** Null means a cached lease needs checking; it isn't evidence of running work. */
export function swarmState(state: State, { id, task }: TaskRoot, now: number): TaskState | null {
  const current = stateNow(task, now)
  if (current !== 'claimed') return current
  if (!task.claim) return null
  const { control, claimEpochs, readyCheck, reads } = state.swarm
  const fenced = readyCheck?.fenced.get(id)
  if (fenced?.epoch === task.epoch && fenced.until === task.claim.until) return 'ready'
  if (!control) return reads.control?.status === 501 ? 'claimed' : null
  if (control.paused) return 'ready'
  const admission = claimEpochs[id]
  if (admission?.epoch === task.epoch) return admission.pauseEpoch < control.pauseEpoch ? 'ready' : 'claimed'
  if (control.pauseEpoch === 0 || (readyCheck?.pauseEpoch === control.pauseEpoch && readyCheck.checked.get(id) === task.epoch && fenced?.epoch !== task.epoch)) return 'claimed'
  return null
}

export function queueOf(state: State, scope: SwarmScope, now: number) {
  const queue: Record<'decisions' | 'ready' | 'claimed' | 'held' | 'parked', TaskRoot[]> = { decisions: [], ready: [], claimed: [], held: [], parked: [] }
  for (const root of swarmRoots(state, scope, now)) {
    const current = swarmState(state, root, now)
    if (current === 'ready' || current === 'claimed') queue[current].push(root)
    if (current === 'blocked') queue[root.task.parked ? 'parked' : blocksOnAttention(state, root) ? 'decisions' : 'held'].push(root)
  }
  for (const group of [queue.decisions, queue.claimed, queue.held, queue.parked]) group.sort(oldest)
  return { ...queue, ready: claimOrder(queue.ready, state.me) }
}

export type Phase = 'dispatched' | 'running' | 'held' | 'reported'

/** A lease, not a health check. Finished failures and cancellations don't establish a report. */
export function phaseOf(state: State, root: TaskRoot, now: number): Phase | null {
  switch (swarmState(state, root, now)) {
    case 'waiting':
    case 'ready': return 'dispatched'
    case 'claimed': return 'running'
    case 'blocked': return 'held'
    case 'completed': return 'reported'
    default: return null
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
  for (const root of swarmRoots(state, scope, now).sort((a, b) => byWritten(b, a))) {
    const claim = root.task.claim
    const phase = phaseOf(state, root, now)
    if (!claim || phase !== 'running') continue
    const { binding } = claim
    const key = JSON.stringify(binding ? [binding.session, binding.branch] : [root.id])
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { key, session: binding?.session ?? null, branch: binding?.branch ?? null, work: [] }))
    group.work.push({ root, claim, phase })
  }
  return [...groups.values()]
}

/** The board's latest list is by thread activity; a completion the feed brings is activity too. */
export function completedOf(state: State, scope: SwarmScope, now: number): TaskRoot[] {
  const roots = swarmRoots(state, scope, now).filter(({ task }) => task.state === 'completed')
  const latest = new Map(roots.map((root) => [root.id, state.swarm.completedAt[root.id] ?? root]))
  for (const message of Object.values(state.messages)) {
    if (message.re === null || message.deleted) continue
    const active = latest.get(message.re)
    if (active && byWritten(message, active) > 0) latest.set(message.re, message)
  }
  return roots.sort((a, b) => byWritten(latest.get(b.id)!, latest.get(a.id)!)).slice(0, RECENT_COMPLETED)
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
  if (root.deleted || root.task.attentionId !== attention.id || !blocksOnAttention(state, root)) return 'this decision no longer holds the task'
  const read = attentionOf(state, root)?.error
  if (read?.status === 501 || read?.status === 403 || read?.status === 401 || read?.status === 404) return read.why
  const me = state.me
  if (!me || me.kind !== 'person' || me.profile !== null || me.actor !== me.principal) return 'answer as a person without a profile'
  const access = readAccess(state)
  if (!access.can('read', root.channel) || !access.can('post', root.channel)) return 'answering needs read and post in this channel'
  const answer = state.swarm.answers[answerKey(me.actor, root.id, attention.id)]
  if (answer?.is === 'sending') return 'sending answer…'
  if (answer?.is === 'failed' && (answer.status === 403 || answer.status === 501)) return answer.why
  return null
}
