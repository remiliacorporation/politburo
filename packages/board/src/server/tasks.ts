import { wallTime } from '../store/single-writer.ts'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import { LEASE_DEFAULT_S, type MessageView, type TaskBinding, type TaskClaim, type TaskHandoffInput } from '../api/routes.ts'
import type { Protocol } from '../api/protocol.ts'
import type { AttentionAnswerBody, AttentionDraft, AttentionReceipt, AttentionResponders, AttentionView, RequestAttentionBody } from '../contract/attention.ts'
import { LEASES_SESSION, leasesContract, type LeaseEvents } from '../contract/contract.ts'
import { ALONG_MAX, type BoardEvent } from '../contract/events.ts'
import { foldMessages, workCanClaim, workTerminal, type Message, type MessagesState, type Task } from '../contract/folds.ts'
import { actorsReducer, channelsReducer, type WorkState } from '../contract/reducers.ts'
import { DEFAULT_TASK_PRIORITY, OPEN_TASK_STATES, priorityRank, TASK_BATCH_MAX, TASK_KEY_MAX, TASK_LABEL, TASK_NEEDS_MAX, TASK_NOTE_MAX, TaskHoldKind, TaskPriority, type TaskState, type WorkStage, type WorkStageTarget } from '../contract/schemas.ts'
import { batchPlan, type BatchNeed } from '../contract/task-batch.ts'
import { authorize, type Access, type Permission } from './access.ts'
import type { BoardBinding } from './backend.ts'
import { badRequest, batchTooLarge, forbidden, HttpError, noAccessFence, notFound } from './errors.ts'
import { indexOf, ref, toMessageFilter, view, whoIs } from './feed.ts'
import type { MessageFilter, ThreadSummary } from '../store/types.ts'
import { appendFrom, authorizeMessage, movedOn, ownedBy, seenFor, untilApplied, type Along, type AlongEach, type Events, type Identity, type WriteContext } from './writes.ts'
import { workOpen } from './control.ts'
import { expiredClaim, expiry, holdEndsLease, lapsed, stale } from './task-lease.ts'

/** The shortest and the longest lease this board gives, in seconds. */
export const LEASE_MIN_S = 30
export const LEASE_CAP_S = 3600
/** How many owners one claim takes tasks from on this board, beside its caller. */
const FROM_MAX = 32
/** The board's own author for derived task events that carry a `by`. */
const TASKS_AUTHOR = { actor: 'board:tasks', principal: 'board:tasks', profile: null }

/**
 * This board's own limits on a task. board() checks a request's shape and leaves how much a
 * backend holds to the backend, so these are checked here: what's over one is refused as a
 * misshapen request is, 400 `invalid_request`, before anything is read or written.
 */
export const taskLimits = {
  lease(seconds: number | undefined) {
    if (seconds !== undefined && !(seconds >= LEASE_MIN_S && seconds <= LEASE_CAP_S)) throw badRequest(`lease: a lease is ${LEASE_MIN_S} to ${LEASE_CAP_S} seconds`)
  },
  needs(refs: readonly string[] | undefined) {
    if (new Set(refs).size > TASK_NEEDS_MAX) throw badRequest(`needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`)
  },
  note(what: 'result' | 'reason', note: string | null | undefined) {
    if (typeof note === 'string' && note.length > TASK_NOTE_MAX) throw badRequest(`${what}: a task's ${what} is at most ${TASK_NOTE_MAX.toLocaleString('en-US')} characters`)
  },
  kind(kind: string | undefined) {
    if (kind !== undefined && !TaskHoldKind.safeParse(kind).success) throw badRequest('kind: a kind is up to 64 lowercase letters, numbers, and _.-')
  },
  from(owners: readonly string[] | undefined) {
    if ((owners?.length ?? 0) > FROM_MAX) throw badRequest(`from: a claim takes tasks from at most ${FROM_MAX} owners`)
  },
  /** A batch: how many tasks this board makes in one append, which its sender splits on, and of each what one task holds. */
  batch(tasks: readonly { key?: string | undefined; needs?: readonly BatchNeed[] | undefined }[]) {
    if (tasks.length > TASK_BATCH_MAX) throw batchTooLarge(tasks.length, TASK_BATCH_MAX)
    for (const [at, task] of tasks.entries()) {
      if (task.key !== undefined && task.key.length > TASK_KEY_MAX) throw badRequest(`tasks.${at}.key: a task's key is at most ${TASK_KEY_MAX} characters`)
      // Each task it waits for once, however it's named: one of the batch by its key, one that's there by its ID.
      const waits = new Set(task.needs?.map((need) => (typeof need === 'string' ? `id ${need}` : `key ${need.key}`)))
      if (waits.size > TASK_NEEDS_MAX) throw badRequest(`tasks.${at}.needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`)
    }
  },
}
/** A timer that fires this early waits again; any closer counts as on time. */
const EARLY_MS = 1000
/** Roots a scan of tasks reads at a time. */
const PAGE = 500

/** A task's root: the message that carries it. */
type Root = Message & { task: Task }
type Change = Events | { events: Events; access?: number }

type AttentionChange = { task: MessageView; attention: AttentionView }

/** What a claim's own writes show: the `epoch` and `token` its claim answered. */
type Proof = { epoch: number; token: string }
type Start = Pick<Protocol['createTask']['input'], 'needs' | 'for' | 'priority' | 'claim' | 'lease' | 'token' | 'binding' | 'id'>

const conflict = (code: string, message: string) => new HttpError(409, code, message)
const notATask = (id: number) => notFound(`#${id} isn't a task`, 'not_a_task')
const noLifecycle = () => new HttpError(501, 'no_work_lifecycle', 'this task does not use the work lifecycle')
const invalidStage = (root: Root, action: string) => conflict('invalid_task_stage', `cannot ${action} #${root.id} while it is ${root.task.work!.stage}`)

/** Non-rejection edges for the authority's stage route. Reject can leave any nonterminal stage. */
const fromStages: Record<Exclude<WorkStageTarget, 'rejected'>, readonly WorkStage[]> = {
  review: ['handoff'],
  qa: ['review'],
  repair: ['review', 'qa', 'approved'],
  approved: ['review', 'qa'],
  done: ['approved'],
}

export type WorkLifecycleOptions = {
  /** Verified principal IDs allowed to scope and move tasks, with channel manage permission. */
  scopers: readonly string[]
}

const beforeHandoff = (task: Task) => !task.work || task.work.stage === 'proposed' || workCanClaim(task.work.stage)
const canReady = (task: Task) => !task.work || workCanClaim(task.work.stage)
// Deleting a completed root does not undo completion for existing dependents.
const completedNeed = (message: Message | undefined) => message?.task?.state === 'completed'
const claimLost = (id: number) => conflict('claim_lost', `this claim on #${id} is over: claim it again`)
const parked = (id: number) => conflict('task_blocked', `#${id} is parked: an operator must unpark it`)

/** Assignment metadata attests to a controller but never acts as one. The owner is server-derived. */
function bindingOf(identity: Identity, binding: TaskBinding | undefined): TaskBinding | undefined {
  if (binding === undefined) return undefined
  const owner = { principal: identity.principal.id, actor: identity.actor.id }
  if (binding.owner.principal !== owner.principal || binding.owner.actor !== owner.actor)
    throw forbidden('the binding owner must be the verified claimant')
  return { ...binding, owner }
}

function sameBinding(id: number, requested: TaskBinding | undefined, current: TaskBinding | undefined) {
  if (requested !== undefined && !isDeepStrictEqual(requested, current))
    throw conflict('binding_mismatch', `the claim on #${id} already has a different binding or no binding`)
}
const staleAttention = () => conflict('attention_stale', 'the attention request or its snapshot is no longer current')
const attentionExpired = (draft: AttentionDraft, at: number) => !(at < Date.parse(draft.expiresAt))

/** 128 random bits, base64url: a claim's secret, which the board answers once and keeps only the hash of. */
const newToken = () => randomBytes(16).toString('base64url')
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
/** Whether `token` is the secret `hash` was made from, compared without saying how much of it matched. */
const hashes = (token: string, hash: string) => timingSafeEqual(Buffer.from(hashOf(token), 'hex'), Buffer.from(hash, 'hex'))

/** A lease asked for in seconds, as this board gives it, in milliseconds. */
const leaseOf = (seconds: number | undefined) => Math.min(seconds ?? LEASE_DEFAULT_S, LEASE_CAP_S) * 1000

/** A pause fences outstanding claims, and resume does not revive them. */
export const claimFenced = (task: Task, status: WorkState) => status.paused || stale(task, status.pauseEpoch)

/** A claim whose lease ran out or was fenced by pause no longer holds the task. */
const stateNow = (task: Task, at: number, pauseEpoch: number): TaskState => (lapsed(task, at, pauseEpoch) ? 'ready' : task.state)

const finished = (task: Task) => task.state === 'completed' || task.state === 'failed' || task.state === 'canceled'

/** How many tasks a change of what a task needs walks, behind the ones it adds, to see that none waits for it. */
export const NEEDS_WALK_MAX = 500

/** Whether `value` is shaped like an ID, `<where it's from>:<who>`, as every principal's and actor's is. What it names is a credential's to say, never a client's. */
const isId = (value: string) => /^[^\s:]+:\S+$/.test(value)

/** Waits `ms`, or until `signal` aborts, whichever is first. */
const paused = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/** The profile part of an actor ID, as the board writes one: lowercase. */
const PROFILE = /^[a-z][a-z0-9-]{0,31}$/

/**
 * The actor a task is assigned to: one of its owner's (`<owner>+<profile>`), or null for anyone who
 * may claim it. Another principal's actor is refused: a profile is the owner's own word for which of
 * its agents does what.
 */
function ownActor(owner: string, actor: string | null | undefined): string | null {
  if (actor === undefined || actor === null) return null
  if (!actor.startsWith(`${owner}+`) || !PROFILE.test(actor.slice(owner.length + 1)))
    throw badRequest(`for: a task is assigned to one of its owner's profiles, ${owner}+<profile>, got ${actor}`)
  return actor
}

/**
 * Tasks on a local board: a thread with a state, kept on its root. Every write here is one
 * conditional append: it reads the task as the tables have it, decides, and lands only while that
 * read is still the log's last word, so of writes that race, one lands and the rest look again.
 * A claim's lease is timed outside the board log, which holds only what came of it.
 */
export function createTasks(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined; workLifecycle?: WorkLifecycleOptions | undefined; attentionResponders?: AttentionResponders | undefined }) {
  const scopers = options.workLifecycle && new Set(options.workLifecycle.scopers)
  const initialWork = scopers ? { work: 'proposed' as const } : {}
  const requireScope = () => { throw conflict('work_lifecycle_required', 'new work must be scoped before it can be claimed') }
  const responders = new Map(Object.entries(options.attentionResponders ?? {}).map(([channel, ids]) => [channel, new Set(ids)]))
  let bound: WriteContext | null = null
  let accessNow: BoardBinding['accessNow']
  let accessPosition: () => Promise<number>
  const writes = (): WriteContext => {
    if (!bound) throw new Error('tasks used before the board bound them')
    return bound
  }

  /**
   * A claim's lease, timed: when it's due, the task's claim expires if it's still that claim and
   * its lease wasn't renewed. A renewal arms its own timer, so one for an earlier end fires into
   * nothing.
   */
  async function due(context: ConsumerContext<LeaseEvents, 'lease.due'>) {
    const ctx = writes()
    const { id, epoch, at } = context.event.payload
    const read: { early: string | null } = { early: null }
    const rows = await ctx.writer.run(() => appendFrom(ctx, async (now) => {
      read.early = null
      const position = await ctx.reads.tables.position()
      const root = (await ctx.reads.tables.messagesAt([id], position)).get(id)
      const task = root?.task
      // Released, settled, held, or claimed again since: this claim is over already.
      if (!root || !task || task.state !== 'claimed' || task.epoch !== epoch) return { position, events: [] }
      const until = Date.parse(task.claim!.until)
      if (until - now > (holdEndsLease(task.claim!) ? 0 : EARLY_MS)) {
        // Renewed, with a timer of its own; or delivered early, and it waits again.
        if (until === at) read.early = task.claim!.until
        return { position, events: [] }
      }
      const waits = !(await satisfied(task, position))
      return { position, events: [expiry(root, task, now, waits)] }
    }))
    await untilApplied(ctx, rows)
    if (read.early !== null) await arm(id, epoch, read.early, `again-${context.event.index}`)
  }

  const expiring = consumer({
    contract: leasesContract,
    name: 'board-leases',
    types: ['lease.due'],
    lane: ({ event }) => `task:${event.payload.id}`,
  }).run((context) => writes().writer.detached(() => due(context)))

  const server = createServer({
    contract: leasesContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [expiring],
  })
  const leases = server.session(LEASES_SESSION)

  /**
   * Arms the timer for a claim's lease. Without a scheduler there's none: a claim still checks the
   * clock and can take over an eligible task when its lease runs out. One whose timer can't be
   * armed is the same, so the claim that landed still answers.
   */
  async function arm(id: number, epoch: number, until: string, again?: string) {
    if (!options.scheduler) return
    const at = Date.parse(until)
    const name = `lease-${id}-${epoch}-${at}${again ? `-${again}` : ''}`
    await leases.schedule(name, { at: new Date(at) }, { type: 'lease.due', payload: { id, epoch, at } }).catch((error: unknown) => {
      console.warn(`[board] no timer for #${id}'s lease, which a claim still ends:`, (error as Error).message)
    })
  }

  /** A message the caller may read, as the tables have it: a 404 otherwise, as if it weren't there. */
  async function readable(access: Access, id: number): Promise<Message> {
    const message = await writes().reads.message(id)
    if (!message || !access.readable(message.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
    return message
  }

  /** A task the caller may read, by its root's ID. Who it is and where it is never change, so what a caller may do to it is checked on this read. */
  async function taskOf(access: Access, id: number): Promise<Root> {
    const message = await readable(access, id)
    if (!message.task) throw notATask(id)
    return message as Root
  }

  /** The root and each cited message are live and unchanged in this one table snapshot. */
  async function matchesAttention(root: Message, draft: AttentionDraft, position: number): Promise<boolean> {
    if (root.deleted || (root.revision ?? root.id) !== draft.revision) return false
    const evidence = draft.evidence.map(({ message, revision }) => ({ id: indexOf(message) ?? 0, revision }))
    if (evidence.some(({ id }) => id === 0)) return false
    const replies = [...new Set(evidence.map(({ id }) => id))].filter((id) => id !== root.id)
    const found = replies.length > 0 ? await writes().reads.tables.messagesAt(replies, position) : null
    return evidence.every(({ id, revision }) => {
      const message = id === root.id ? root : found?.get(id)
      return message && !message.deleted && message.channel === root.channel && message.thread === root.thread &&
        (message.id === root.id || message.re === root.id) && (message.revision ?? message.id) === revision
    })
  }

  /** Show only the public request and receipt. `stale` is a live read, never a timeout write. */
  function attentionView(attention: NonNullable<Task['attention']>, stale = false): AttentionView {
    if (attention.status === 'answered') {
      const { epoch: _epoch, ...answered } = attention
      return answered
    }
    const { epoch: _epoch, ...request } = attention
    return { ...request, status: stale && attention.status === 'pending' ? 'stale' : attention.status }
  }

  /** `message` as `identity` sees it. */
  async function shown(identity: Identity, message: Message): Promise<MessageView> {
    const ctx = writes()
    const { state: actors } = await ctx.session.state(actorsReducer)
    return view(message, actors, await ctx.reads.reader(identity.principal.access, [message]))
  }

  /**
   * One write to the message `id`: `decide` gets it as it is at the index the write will land after,
   * throws what refuses the write, and returns what to append. Answers the message as the write left
   * it: as it was, when there was nothing to append.
   */
  async function change(identity: Identity, id: number, decide: (found: Message, position: number, now: number) => Change | Promise<Change>): Promise<Message> {
    const ctx = writes()
    const seen = seenFor(identity, (await ctx.session.state(actorsReducer)).state)
    const read: { before?: Message } = {}
    const rows = await appendFrom(ctx, async (now) => {
      const position = await ctx.reads.tables.position()
      const found = (await ctx.reads.tables.messagesAt([id], position)).get(id)
      if (!found) throw notFound(`message not found: #${id}`, 'message_not_found')
      read.before = found
      const decision = await decide(found, position, now)
      const { events, access } = Array.isArray(decision) ? { events: decision } : decision
      return { position, access, events: events.length > 0 && seen ? [seen, ...events] : events }
    })
    await untilApplied(ctx, rows)
    return after(read.before!, rows)
  }

  /** `message` once `rows`, a write's own events, are applied to it: what the write answers, whatever lands next. */
  function after(message: Message, rows: readonly { index: number }[]): Message {
    const state: MessagesState = { byId: { [message.id]: structuredClone(message) }, replies: {} }
    for (const row of [...rows].sort((a, b) => a.index - b.index)) foldMessages(state, row as unknown as BoardEvent)
    return state.byId[message.id]!
  }

  /** `change`, for a write to a task: `decide` gets its root. */
  const changeTask = (identity: Identity, id: number, decide: (root: Root, position: number, now: number) => Change | Promise<Change>) =>
    change(identity, id, (found, position, now) => {
      if (!found.task) throw notATask(id)
      if (found.task.work && found.deleted) throw notFound(`message not found: #${id}`, 'message_not_found')
      return decide(found as Root, position, now)
    })

  /**
   * Whether the caller changes a task as its owner: `manage` in its channel, or the owner while it
   * may still write there. A principal ID is coarser than access (a proxy narrows one token with
   * `x-board-can`), so one narrowed to reading doesn't cancel its principal's tasks. And a
   * principal's profiles share its credential (a sandbox's agent writes as one), so, as with a
   * message, a profile changes only the tasks it made, and the principal itself any of them:
   * otherwise one profile would assign itself what was another's.
   */
  function owns(identity: Identity, root: Root) {
    const { access } = identity.principal
    if (access.can('manage', root.channel)) return
    if (ownedBy(root.task, identity) && (access.can('post', root.channel) || access.can('label', root.channel))) return
    throw new HttpError(403, 'task_not_owned', `#${root.id} is someone else's task: its owner as itself, the profile that made it, or manage in ${root.channel}, changes it`)
  }

  /** Recheck effective grants on an append retry or after a claim-next poll wakes. */
  const accessFor = async (identity: Identity) => identity.principal.id.startsWith('board:') ? identity.principal.access : accessNow(identity.principal)

  async function scoper(identity: Identity, root: Root, decide: (access: Access) => Events | Promise<Events>) {
    if (!scopers) throw noLifecycle()
    const hidden = () => notFound(`message not found: #${root.id}`, 'message_not_found')
    let epoch: number | undefined
    if (!identity.principal.id.startsWith('board:')) {
      if (!writes().fence) throw noAccessFence()
      // Read the access head first: a grant change since then must move the append's guard.
      epoch = await accessPosition().catch(() => undefined)
      if (epoch === undefined) throw hidden()
    }
    const access = await accessFor(identity).catch(() => null)
    if (!access?.readable(root.channel)) throw hidden()
    if (!scopers.has(identity.principal.id) || !access.can('manage', root.channel))
      throw forbidden(`only a work scoper with manage in ${root.channel} can move #${root.id}`)
    return { events: await decide(access), access: epoch }
  }

  /** Scoper writes recheck access inside each append look. Legacy writes keep their own checks. */
  const changeScoperTask = (identity: Identity, id: number, decide: (root: Root, position: number, access: Access, now: number) => Events | Promise<Events>) =>
    changeTask(identity, id, (root, position, now) => root.task.work
      ? scoper(identity, root, (access) => decide(root, position, access, now))
      : decide(root, position, identity.principal.access, now))

  function atVersion(root: Root, ifVersion: number) {
    if ((root.version ?? root.id) !== ifVersion) throw conflict('task_version_conflict', `#${root.id} changed since version ${ifVersion}`)
  }

  function stageChanged(root: Root, identity: Identity, to: WorkStage, reason: string, result?: string | null): Events[number] {
    return { type: 'task.stage_changed', payload: { id: root.id, thread: root.thread, from: root.task.work!.stage, to, reason, by: identity.author, ...(result === undefined ? {} : { result }) } }
  }

  /** A scoped or repair stage projects to waiting when it has needs, until they're checked at this append. */
  async function enterWork(root: Root, identity: Identity, to: WorkStage, reason: string, position: number): Promise<Events> {
    const ready = workCanClaim(to) && !root.task.blocked && !root.task.parked && root.task.needs.length > 0 && await satisfied(root.task, position)
    const about = { id: root.id, thread: root.thread }
    return [stageChanged(root, identity, to, reason), ...(ready ? [{ type: 'task.ready' as const, payload: about }] : [])]
  }

  /**
   * The exact actor and principal that claimed the task. Tables written before the claim carried
   * its principal recover it from the original event, never from the actor name or the caller.
   */
  async function claimedBy(root: Root, identity: Identity): Promise<boolean> {
    const { task } = root
    const claim = task.claim!
    if (claim.actor !== identity.actor.id) return false
    if (claim.principal !== undefined) return claim.principal === identity.principal.id
    const { session, reads } = writes()
    for (let end = root.version ?? (await reads.tables.position()); end > root.id; ) {
      const start = Math.max(root.id + 1, end - PAGE + 1)
      const rows = (await session.history({ gte: start, lte: end })) as BoardEvent[]
      for (const row of rows) {
        if (row.type !== 'task.claimed') continue
        const { id, epoch, by, token } = row.payload
        if (id === root.id && epoch === task.epoch && token === claim.token && by.actor === claim.actor)
          return by.principal === identity.principal.id
      }
      end = start - 1
    }
    return false
  }

  const epochAt = async (position: number) => (await writes().work.at(position)).status.pauseEpoch
  const openAt = async (position?: number, epoch?: number) => workOpen((await writes().work.at(position)).status, epoch)

  /** A proof must name this caller's live claim in the current pause epoch; it gives no permissions. */
  async function fenced(root: Root, identity: Identity, proof: Proof, position: number, now: number) {
    authorize(identity.principal.access, 'label', root.channel)
    const { task } = root
    const { status } = await writes().work.at(position)
    if (status.paused || task.state !== 'claimed' || task.epoch !== proof.epoch || lapsed(task, now, status.pauseEpoch) || !hashes(proof.token, task.claim!.token))
      throw claimLost(root.id)
    if (!(await claimedBy(root, identity))) throw claimLost(root.id)
    const until = Date.parse(task.claim!.until)
    writes().writer.beforeCommit((at) => { if (at >= until) throw claimLost(root.id) })
  }

  /**
   * Whether `identity` is who a task is assigned to: its owner's principal, writing as that actor.
   * The actor ID alone doesn't say whose it is. An ID is a principal's and then `+<profile>`, and
   * another principal's own ID can end that way, so the two can be one string.
   */
  const assignedTo = (task: Task, identity: Identity) => task.for === identity.actor.id && task.owner === identity.principal.id

  /** Refuses a claim of a task that can't be claimed now, by `identity`. */
  function claimable(root: Root, identity: Identity, pauseEpoch: number, now: number) {
    const { task } = root
    if (task.work && !scopers) throw noLifecycle()
    if (task.work && !workCanClaim(task.work.stage)) throw invalidStage(root, 'claim')
    if (task.state === 'waiting') throw waiting(root)
    if (task.parked) throw parked(root.id)
    if (task.state === 'blocked') throw conflict('task_blocked', `#${root.id} is held for a person: ${task.blocked!.reason}`)
    if (finished(task)) throw conflict('task_finished', `#${root.id} is ${task.state}`)
    if (task.for !== null && !assignedTo(task, identity)) throw conflict('task_assigned', `#${root.id} is assigned to ${task.for}`)
    if (task.state === 'claimed' && !lapsed(task, now, pauseEpoch)) throw conflict('task_claimed', `#${root.id} is claimed until ${task.claim!.until}`)
  }

  const waiting = (root: Root) => conflict('task_waiting', `#${root.id} waits for ${root.task.needs.map((need) => `#${need}`).join(', ')}`)

  /**
   * A claim of an eligible task: the events and what the claim answers. A lapsed claim expires in
   * the same append, using the prerequisite check the caller made at that position.
   */
  function claiming(root: { id: number; thread: string }, task: Task | null, identity: Identity, lease: number | undefined, token: string, pauseEpoch: number, binding: TaskBinding | undefined, now: number, hold?: number, waits = false): { events: Events; claim: TaskClaim } {
    const about = { id: root.id, thread: root.thread }
    const epoch = (task?.epoch ?? 0) + 1
    const hardEnd = hold === undefined ? Infinity : now + hold * 1000
    const until = new Date(Math.min(now + leaseOf(lease), hardEnd)).toISOString()
    const metadata = { ...(binding === undefined ? {} : { binding }), ...(hold === undefined ? {} : { holdUntil: new Date(hardEnd).toISOString() }) }
    return {
      events: [
        ...(task?.state === 'claimed' ? [expiry(root, task, now, waits)] : []),
        { type: 'task.claimed', payload: { ...about, epoch, ...(pauseEpoch === 0 ? {} : { pauseEpoch }), until, token: hashOf(token), by: identity.author, ...metadata } },
      ],
      claim: { epoch, token, until, pauseEpoch, ...metadata },
    }
  }

  /** The tasks `refs` name, as of `position`, and whether they've all completed. A task can't name `self` as a prerequisite. */
  async function needsAt(
    access: Access,
    refs: readonly string[] | undefined,
    position: number,
    self: number | null,
    kept?: readonly number[],
  ): Promise<{ ids: number[]; completed: boolean }> {
    const named = namedNeeds(refs, self)
    const found = named.size === 0 ? new Map<number, Message>() : await writes().reads.tables.messagesAt([...named.keys()], position)
    return needsAmong(access, named, found, kept)
  }

  const invalidNeed = (value: string, why: string) => badRequest(`needs: #${value} ${why}`, 'invalid_needs')

  /** The messages `refs` name, each by the ref that named it: one that names none, or `self`, is refused. */
  function namedNeeds(refs: readonly string[] | undefined, self: number | null): Map<number, string> {
    const named = new Map<number, string>()
    for (const value of refs ?? []) {
      const id = indexOf(value)
      if (id === null || id === 0) throw invalidNeed(value, "isn't a task")
      if (id === self) throw invalidNeed(value, "is the task itself: it can't wait for itself")
      named.set(id, value)
    }
    return named
  }

  /**
   * Checks the named prerequisites and says whether they've all completed. Refuses unreadable
   * tasks as if they weren't tasks. A canceled task can never complete, but a failed one may
   * reopen. A deleted staged root can only be kept, and only if it already completed.
   */
  function needsAmong(
    access: Access,
    named: ReadonlyMap<number, string>,
    found: ReadonlyMap<number, Message>,
    kept?: readonly number[],
  ): { ids: number[]; completed: boolean } {
    for (const [id, value] of named) {
      const need = found.get(id)
      if (!need?.task || !access.readable(need.channel)) throw invalidNeed(value, "isn't a task")
      if (need.task.state === 'canceled' || (need.task.work && need.deleted && !(kept?.includes(id) && completedNeed(need))))
        throw invalidNeed(value, 'was canceled or deleted: it can never complete')
    }
    const ids = [...named.keys()]
    return { ids, completed: ids.every((id) => completedNeed(found.get(id))) }
  }

  /**
   * Refuses prerequisites that would make task `id` wait for itself: one that waits for it already,
   * through however many tasks. A new task can't be waited for, so only a change of what a task
   * needs can close a cycle, and only with a prerequisite it adds: one the task keeps was looked
   * behind when it was added, and whatever came to wait behind it since was checked as it did. So
   * it walks what the `added` ones need, and what those need, a level a read, and gives up past
   * `NEEDS_WALK_MAX` tasks: a change it can't check is refused too. One that only drops some walks
   * nothing.
   *
   * The walk stops at a readable, completed legacy task. Its completion is final, so no task
   * can be made to wait on it again. Completed staged tasks can reopen and make their dependents
   * wait again, so the walk follows their needs. It also follows unreadable tasks, completed or
   * not: where it stops, and whether it gets past `NEEDS_WALK_MAX`, must depend on nothing the
   * caller can't see. A canceled task is followed: it may have waited for anything.
   */
  async function acyclic(access: Access, id: number, added: readonly number[], position: number) {
    const invalid = (need: number, why: string) => badRequest(`needs: #${need} ${why}`, 'invalid_needs')
    /** Each task the walk reached, by the added prerequisite it reached it from. */
    const from = new Map<number, number>(added.map((need) => [need, need]))
    for (let level = [...added]; level.length > 0; ) {
      const found = await writes().reads.tables.messagesAt(level, position)
      const next: number[] = []
      for (const at of level) {
        const message = found.get(at)
        const task = message?.task
        if (!task || (!task.work && task.state === 'completed' && access.readable(message.channel))) continue
        for (const need of task.needs) {
          if (need === id) throw invalid(from.get(at)!, `waits for #${id} already: they would wait for each other`)
          if (from.has(need)) continue
          from.set(need, from.get(at)!)
          next.push(need)
        }
      }
      if (from.size > NEEDS_WALK_MAX) throw invalid(added[0]!, `has more than ${NEEDS_WALK_MAX} tasks behind it and the others: too many to check that none waits for #${id}`)
      level = next
    }
  }

  /** Whether every task `task` waits for has completed, as of `position`, leaving out `but`, which is completing now. */
  async function satisfied(task: Task, position: number, but?: number): Promise<boolean> {
    const ids = task.needs.filter((id) => id !== but)
    if (ids.length === 0) return true
    const found = await writes().reads.tables.messagesAt(ids, position)
    return ids.every((id) => completedNeed(found.get(id)))
  }

  /** Queue readiness, independent of who may read or claim the task. */
  async function readyAt(task: Task, position: number, now: number, pauseEpoch: number): Promise<boolean> {
    return !task.parked && stateNow(task, now, pauseEpoch) === 'ready' && canReady(task) && (!task.work || !!scopers) && (await satisfied(task, position))
  }

  /** Every root that wears `board.task` as one of `states` and matches `filter`, oldest first, all as of `position`. */
  async function* rootsAt(filter: MessageFilter, states: readonly TaskState[], position: number, staged = false): AsyncGenerator<Root> {
    const labels = [...(filter.labels ?? []), { key: TASK_LABEL, values: states }]
    const ctx = writes()
    for (let after = 0; ; ) {
      const load = () => ctx.reads.tables.roots({ ...filter, labels }, { after, limit: PAGE })
      const page = await (staged ? ctx.writer.outside(load) : load())
      // A page that reflects a later index than the write looked at: the board moved on, and it looks again.
      if (page.position !== position) throw movedOn()
      for (const { root } of page.threads) if (root.task) yield root as Root
      if (page.threads.length < PAGE) return
      after = page.threads.at(-1)!.root.id
    }
  }

  /** `task.ready` for each task that waited only for `id`, which is completing: its dependents, in the same append. */
  async function readied(id: number, position: number): Promise<Events> {
    const events: Events = []
    for await (const root of rootsAt({}, ['waiting'], position))
      if (canReady(root.task) && root.task.needs.includes(id) && (await satisfied(root.task, position, id))) events.push({ type: 'task.ready', payload: { id: root.id, thread: root.thread } })
    return events
  }

  /**
   * `filter`, narrowed to the channels where `access` gives `permission` among those the log has,
   * and the index that list reflects. One that gives it everywhere needs nothing more.
   */
  async function within(filter: MessageFilter, access: Access, permission: Permission): Promise<{ filter: MessageFilter; through: number }> {
    if (access.everywhere(permission)) return { filter, through: Number.POSITIVE_INFINITY }
    const { state, index } = await writes().session.state(channelsReducer)
    const { channel, ...rest } = filter
    const inside = (path: string) => !channel || path === channel.path || (channel.subtree && path.startsWith(`${channel.path}/`))
    return { filter: { ...rest, channels: Object.keys(state).filter((path) => inside(path) && access.can(permission, path)) }, through: index }
  }

  /** The IDs a handle or an ID names, itself included: an owner or an assignee the board has yet to see write is still found by its ID. */
  async function named(value: string): Promise<Set<string>> {
    const who = whoIs(value, (await writes().session.state(actorsReducer)).state)
    return new Set([value, ...who.actors, ...who.principals])
  }

  /**
   * The owner a claim's `from` names: the principal with that ID. A task's text is instructions for
   * whoever claims it, so whose it takes is never a handle's to say: a handle is how someone shows,
   * and several can show the same, one a client picked and one a credential gave alike (two projects
   * on different teams share a name). An ID is one principal's alone, whether or not the board has
   * seen it write as itself: one that only ever wrote through a profile owns its tasks all the same.
   */
  function ownerFrom(value: string): string {
    if (isId(value)) return value
    throw badRequest(`from: ${value} is a handle, which several can share: name the owner by ID`, 'invalid_from')
  }

  /**
   * Claims the highest priority ready task the caller can take. At equal priority, prefer tasks
   * assigned to the caller, then take the oldest within the same assignment group.
   */
  async function claimNext(identity: Identity, input: Protocol['claimReadyTask']['input'], signal: AbortSignal, pauseEpoch: number, binding: TaskBinding | undefined): Promise<{ root: Message; claim: TaskClaim } | null> {
    const ctx = writes()
    const { principal } = identity
    const access = scopers ? await accessFor(identity) : principal.access
    if (!access) throw forbidden('this token no longer has access to claim work')
    const subtree = input.channel.endsWith('/')
    const channel = { path: subtree ? input.channel.slice(0, -1) : input.channel, subtree }
    // A claim changes a task's state, which is what `label` gives: where the caller has none, there's nothing it claims.
    if (!subtree) authorize(access, 'label', channel.path)
    else if (!access.anywhere('label')) throw forbidden("this token can't label anywhere, so it can't claim a task")
    const base: MessageFilter = { channel, labels: Object.entries(input.label ?? {}).map(([key, value]) => ({ key, values: [value] })) }
    const { filter } = await within(base, access, 'label')
    if (filter.channels?.length === 0) return null
    // Whose tasks it takes: its own, and those of the owners it names.
    const owners = new Set([principal.id])
    for (const value of input.from ?? []) owners.add(ownerFrom(value))
    const seen = seenFor(identity, (await ctx.session.state(actorsReducer)).state)
    const token = input.token ?? newToken()
    const read: { taken: { root: Root; claim: TaskClaim } | null } = { taken: null }
    const rows = await appendFrom(ctx, async (now) => {
      read.taken = null
      const position = await ctx.reads.tables.position()
      await openAt(position, pauseEpoch)
      const current = scopers ? await accessFor(identity) : access
      if (!current) throw forbidden('this token no longer has access to claim work')
      let root: Root | null = null
      let best = -1
      let bestAssigned = false
      for await (const candidate of rootsAt(filter, ['ready', 'claimed'], position, true)) {
        const { task } = candidate
        if (scopers && (!current.readable(candidate.channel) || !current.can('label', candidate.channel))) continue
        const assigned = assignedTo(task, identity)
        if (!assigned && !(task.for === null && owners.has(task.owner))) continue
        const rank = priorityRank(task.priority)
        if (rank < best || (rank === best && (bestAssigned || !assigned)) || !(await readyAt(task, position, now, pauseEpoch))) continue
        root = candidate
        best = rank
        bestAssigned = assigned
        if (bestAssigned && best === TaskPriority.options.length - 1) break
      }
      // Selection may have waited on a page from before a pause (including a pause and resume).
      await openAt(undefined, pauseEpoch)
      // A caller that stopped waiting takes nothing: a task claimed for no one would sit out its lease.
      if (!root || signal.aborted) return { position, events: [] }
      const { events, claim } = claiming(root, root.task, identity, input.lease, token, pauseEpoch, binding, now, input.hold)
      read.taken = { root, claim }
      return { position, events: seen ? [seen, ...events] : events }
    })
    if (read.taken === null) return null
    const { root, claim } = read.taken
    await untilApplied(ctx, rows)
    await arm(root.id, claim.epoch, claim.until)
    return { root: after(root, rows), claim }
  }

  return {
    server,
    bind: (binding: { writes: WriteContext; accessNow: BoardBinding['accessNow']; accessPosition: () => Promise<number> }) => {
      bound = binding.writes
      accessNow = binding.accessNow
      accessPosition = binding.accessPosition
    },

    /**
     * What makes a new thread a task, to append with its root: `task.created`, `task.ready` when
     * the tasks it needs have all completed, and its claim when it asks for one. `claimed(id)` is
     * what that claim answers once root `id` landed. A retry recovers only the original, live
     * claim, and only with the caller's own token.
     */
    async starting(
      identity: Identity,
      input: Start & { channel: string },
      screenedEpoch?: number,
    ): Promise<{ along: Along; workEpoch: number | undefined; committed: () => void; claimed: (id: number) => Promise<TaskClaim | null> }> {
      const { principal, actor, author } = identity
      const assigned = ownActor(principal.id, input.for)
      // Claiming is what `label` gives, on a task made in the same write as on any other.
      if (input.claim) authorize(principal.access, 'label', input.channel)
      const binding = bindingOf(identity, input.binding)
      const workEpoch = input.claim ? await openAt(undefined, screenedEpoch) : undefined
      const token = input.token ?? newToken()
      let planned: TaskClaim | null = null
      let committed = false
      const along: Along = async (now) => {
        if (scopers && input.claim) requireScope()
        const position = await writes().reads.tables.position()
        if (workEpoch !== undefined) await openAt(position, workEpoch)
        const needs = await needsAt(principal.access, input.needs, position, null)
        const waits = needs.ids.length > 0 && !needs.completed
        if (input.claim && waits) throw conflict('task_waiting', `the task would wait for ${needs.ids.map((id) => `#${id}`).join(', ')}: nothing was made`)
        if (input.claim && assigned !== null && assigned !== actor.id) throw conflict('task_assigned', `the task would be assigned to ${assigned}: nothing was made`)
        return {
          position,
          events: (root) => {
            const about = { id: root.id, thread: root.thread }
            const events: Events = [{ type: 'task.created', payload: { ...about, needs: needs.ids, for: assigned, priority: input.priority ?? DEFAULT_TASK_PRIORITY, by: author, ...initialWork } }]
            if (!scopers && needs.ids.length > 0 && !waits) events.push({ type: 'task.ready', payload: about })
            if (workEpoch !== undefined) {
              const taken = claiming(root, null, identity, input.lease, token, workEpoch, binding, now)
              planned = taken.claim
              events.push(...taken.events)
            }
            return events
          },
        }
      }
      const claimed = async (id: number): Promise<TaskClaim | null> => {
        if (!input.claim) return null
        const replay = !committed && input.token !== undefined
        let created: BoardEvent<'task.claimed'> | undefined
        if (input.id !== undefined && (binding !== undefined || replay)) {
          const events = (await writes().session.history({ gte: id, lte: id + ALONG_MAX })) as BoardEvent[]
          const post = events[0]
          const along = post?.type === 'message.posted' ? post.payload.along ?? 0 : 0
          created = events.slice(1, 1 + along).find((row) => row.type === 'task.claimed')
          // An idempotent bound create cannot pretend to have written a different binding.
          sameBinding(id, binding, created?.payload.binding)
        }
        if (committed && planned) {
          await arm(id, planned.epoch, planned.until)
          return planned
        }
        if (!replay || !created) return null
        const ctx = writes()
        const now = ctx.writer.time()
        const { status, index } = await ctx.work.at()
        if (status.paused || status.pauseEpoch !== workEpoch) return null
        const found = (await ctx.reads.messagesAt([id], index)).get(id)
        const task = found?.task
        // A later claim can reuse the same token but is not the one created with this post.
        if (!task || task.state !== 'claimed' || task.epoch !== created.payload.epoch) return null
        const current = task.claim
        if (!current || !hashes(token, current.token) || lapsed(task, now, status.pauseEpoch)) return null
        if (!(await claimedBy(found as Root, identity))) return null
        sameBinding(id, binding, current.binding)
        await arm(id, task.epoch, current.until)
        return { epoch: task.epoch, token, until: current.until, pauseEpoch: status.pauseEpoch, ...(current.binding ? { binding: current.binding } : {}) }
      }
      return { along, workEpoch, committed: () => { committed = true }, claimed }
    },

    /**
     * What makes several new threads tasks, to append with their roots, all in one write: for each,
     * `task.created`, and `task.ready` when it waits only for tasks that were there and have all
     * completed. A task waits for the batch's others by their `key`, wherever they come in it, and
     * those are new, so it waits. Refused before anything is read: an assignee that isn't its
     * owner's, a `key` two tasks have or none has, and tasks that wait for each other.
     */
    startingMany(identity: Identity, tasks: readonly { key?: string | undefined; needs?: readonly BatchNeed[] | undefined; for?: string | null | undefined; priority?: TaskPriority | undefined }[]): AlongEach {
      const { principal, author } = identity
      const assigned = tasks.map((task) => ownActor(principal.id, task.for))
      const plan = batchPlan(tasks)
      if ('problem' in plan) throw badRequest(`needs: ${plan.problem}`, 'invalid_needs')
      const { inside } = plan
      const named = tasks.map((task) => namedNeeds((task.needs ?? []).filter((need) => typeof need === 'string'), null))
      const outside = [...new Set(named.flatMap((needs) => [...needs.keys()]))]
      return async () => {
        const position = await writes().reads.tables.position()
        // What the batch waits for that was there, read once for all its tasks.
        const found = outside.length === 0 ? new Map<number, Message>() : await writes().reads.tables.messagesAt(outside, position)
        const needs = named.map((refs) => needsAmong(principal.access, refs, found))
        const readied = needs.map(({ ids, completed }, at) => !scopers && ids.length > 0 && completed && inside[at]!.length === 0)
        return {
          position,
          counts: readied.map((ready) => (ready ? 2 : 1)),
          events: (roots) =>
            roots.map((root, at): Events => {
              const about = { id: root.id, thread: root.thread }
              const waitsFor = [...needs[at]!.ids, ...inside[at]!.map((other) => roots[other]!.id)]
              return [{ type: 'task.created', payload: { ...about, needs: waitsFor, for: assigned[at]!, priority: tasks[at]!.priority ?? DEFAULT_TASK_PRIORITY, by: author, ...initialWork } }, ...(readied[at] ? [{ type: 'task.ready' as const, payload: about }] : [])]
            }),
        }
      }
    },

    /**
     * Makes the thread rooted at `id` a task, as it is: `label` in its channel, and the caller's
     * principal owns it. A reply names no task, and neither does a root that's gone.
     */
    async adopt(identity: Identity, id: number, input: Start, screenedEpoch?: number): Promise<{ task: MessageView; claim?: TaskClaim }> {
      const { principal, actor, author } = identity
      const start = input.claim ? (await writes().work.at()).status : undefined
      await authorizeMessage(writes(), principal.access, 'label', id)
      const pauseEpoch = start === undefined ? undefined : workOpen(start, screenedEpoch)
      if (scopers && input.claim) requireScope()
      const assigned = ownActor(principal.id, input.for)
      const binding = bindingOf(identity, input.binding)
      const token = input.token ?? newToken()
      const made: { claim: TaskClaim | null } = { claim: null }
      const root = await change(identity, id, async (found, position, now) => {
        made.claim = null
        if (pauseEpoch !== undefined) await openAt(position, pauseEpoch)
        if (found.re !== null) throw badRequest(`#${id} is a reply: a task is a thread, so name its root, #${found.re}`)
        if (found.deleted) throw badRequest('message was deleted', 'message_deleted')
        if (found.task) throw conflict('already_a_task', `#${id} is a task already`)
        const needs = await needsAt(principal.access, input.needs, position, id)
        const waits = needs.ids.length > 0 && !needs.completed
        if (input.claim && waits) throw conflict('task_waiting', `#${id} would wait for ${needs.ids.map((need) => `#${need}`).join(', ')}: it wasn't made a task`)
        if (input.claim && assigned !== null && assigned !== actor.id) throw conflict('task_assigned', `#${id} would be assigned to ${assigned}: it wasn't made a task`)
        const about = { id, thread: found.thread }
        const events: Events = [{ type: 'task.created', payload: { ...about, needs: needs.ids, for: assigned, priority: input.priority ?? DEFAULT_TASK_PRIORITY, by: author, ...initialWork } }]
        if (!scopers && needs.ids.length > 0 && !waits) events.push({ type: 'task.ready', payload: about })
        if (pauseEpoch !== undefined) {
          const claimed = claiming(found, null, identity, input.lease, token, pauseEpoch, binding, now)
          events.push(...claimed.events)
          made.claim = claimed.claim
        }
        return events
      })
      const { claim } = made
      if (claim) await arm(id, claim.epoch, claim.until)
      return { task: await shown(identity, root), ...(claim ? { claim } : {}) }
    },

    /** Tasks the caller reads, oldest first, a page at a time. */
    async list(identity: Identity, query: Protocol['tasks']['input']): Promise<Protocol['tasks']['output']> {
      const ctx = writes()
      const { principal, actor } = identity
      const { state: actors } = await ctx.session.state(actorsReducer)
      const wanted = query.state ?? 'open'
      // A claim whose lease ran out still wears `claimed`: what's ready is looked for among both.
      const states: readonly TaskState[] | null = wanted === 'all' ? null : wanted === 'open' ? OPEN_TASK_STATES : wanted === 'ready' ? ['ready', 'claimed'] : [wanted]
      const base = toMessageFilter({ ...(query.channel !== undefined ? { channel: query.channel } : {}), ...(query.by !== undefined ? { by: query.by } : {}), ...(query.label ? { label: query.label } : {}) }, { me: { id: actor.id, handle: actor.handle }, actors, access: principal.access })
      const { filter, through } = await within({ ...base, labels: [...(base.labels ?? []), { key: TASK_LABEL, values: states }] }, principal.access, 'read')
      const owners = query.owner === undefined ? null : await named(query.owner)
      const assignees = query.for === undefined ? null : await named(query.for)
      // A ref that names nothing here is no task's prerequisite.
      const needed = query.needs === undefined ? null : (indexOf(query.needs) ?? -1)
      const now = wallTime()
      const { status: { pauseEpoch } } = await ctx.work.at()
      const matches = (task: Task) =>
        (wanted === 'all' || wanted === 'open' || wanted === 'ready' || stateNow(task, now, pauseEpoch) === wanted) &&
        (owners === null || owners.has(task.owner)) &&
        (assignees === null || (task.for !== null && assignees.has(task.for))) &&
        (needed === null || task.needs.includes(needed))
      const limit = query.limit ?? 50
      const found: ThreadSummary[] = []
      let last = 0
      if (query.after !== undefined) {
        const at = indexOf(query.after)
        if (at === null) throw badRequest(`${query.after} isn't a cursor or a message ID on this board`, 'invalid_cursor')
        last = at
      }
      let position = await ctx.reads.position()
      // A reader of no channel has nothing to look for. A page that fills picks up after the last root it looked at.
      scan: for (let more = filter.channels?.length !== 0; more; ) {
        const page = await ctx.reads.roots(filter, { after: last, limit: PAGE })
        position = page.position
        more = page.threads.length === PAGE
        for (const thread of page.threads) {
          last = thread.root.id
          const { task } = thread.root
          if (task && matches(task) && (wanted !== 'ready' || (await readyAt(task, position, now, pauseEpoch)))) found.push(thread)
          if (!query.latest && found.length === limit) break scan
        }
      }
      // Once it has read them all, the next read picks up at what the board has now.
      const cursor = !query.latest && found.length === limit ? last : Math.max(last, Math.min(position, through))
      // The last active: a sort keeps ties as they came, in the order they were made.
      const activeAt = (t: ThreadSummary) => (t.last ?? t.root).createdAt
      const kept = query.latest ? found.sort((a, b) => activeAt(a).localeCompare(activeAt(b))).slice(-limit) : found
      const reader = await ctx.reads.reader(principal.access, kept.flatMap((t) => (t.last ? [t.root, t.last] : [t.root])))
      return {
        tasks: kept.map((t) => ({ message: view(t.root, actors, reader), replies: t.replies, last: t.last && view(t.last, actors, reader) })),
        cursor: ref(cursor),
      }
    },

    /**
     * Claims a task: `label` in its channel, whoever owns it. Of claims that race, one lands. With
     * the token of the claim that holds it now, it answers that claim as it is.
     */
    async claim(identity: Identity, id: number, input: Protocol['claimTask']['input'], screenedEpoch?: number): Promise<Protocol['claimTask']['output']> {
      const { principal } = identity
      const { status: start } = await writes().work.at()
      const { channel } = await taskOf(principal.access, id)
      authorize(principal.access, 'label', channel)
      const pauseEpoch = workOpen(start, screenedEpoch)
      const binding = bindingOf(identity, input.binding)
      const token = input.token ?? newToken()
      const made: { claim?: TaskClaim; replay?: boolean } = {}
      const root = await changeTask(identity, id, async (found, position, now) => {
        made.replay = false
        await openAt(position, pauseEpoch)
        const { task } = found
        if (task.work && !scopers) throw noLifecycle()
        const current = task.claim
        if (input.token !== undefined && current && hashes(token, current.token)) {
          if (stale(task, pauseEpoch)) throw claimLost(id)
          if (!lapsed(task, now, pauseEpoch) && (await claimedBy(found, identity))) {
            sameBinding(id, binding, current.binding)
            made.claim = { epoch: task.epoch, token, until: current.until, pauseEpoch, ...(current.binding ? { binding: current.binding } : {}), ...(current.holdUntil ? { holdUntil: current.holdUntil } : {}) }
            made.replay = true
            return []
          }
        }
        claimable(found, identity, pauseEpoch, now)
        const waits = !(await satisfied(task, position))
        if (waits) throw waiting(found)
        const claimed = claiming(found, task, identity, input.lease, token, pauseEpoch, binding, now, input.hold)
        made.claim = claimed.claim
        return claimed.events
      })
      const claim = made.claim!
      if (made.replay) await openAt(undefined, pauseEpoch)
      await arm(id, claim.epoch, claim.until)
      return { task: await shown(identity, root), claim }
    },

    /** Claims the next ready task there, waiting up to `wait` seconds for one. */
    async claimReady(identity: Identity, input: Protocol['claimReadyTask']['input'], signal: AbortSignal,
      attempt: <T>(claim: (identity: Identity) => Promise<T>) => Promise<T>,
    ): Promise<Protocol['claimReadyTask']['output']> {
      const binding = bindingOf(identity, input.binding)
      const deadline = wallTime() + (input.wait ?? 0) * 1000
      const pauseEpoch = await openAt()
      for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
        // Looked at again before every try: the caller may have gone while this waited.
        if (signal.aborted) return { task: null }
        const next = await attempt(async (current) => {
          const taken = await claimNext(current, input, signal, pauseEpoch, binding)
          return taken && { task: await shown(current, taken.root), claim: taken.claim }
        })
        if (next) return next
        await openAt(undefined, pauseEpoch)
        const left = deadline - wallTime()
        if (left <= 0) return { task: null }
        await paused(Math.min(pause, left), signal)
      }
    },

    /** Extends a claim's lease from now. */
    async renew(identity: Identity, id: number, proof: Proof, lease: number | undefined): Promise<Protocol['renewTask']['output']> {
      await taskOf(identity.principal.access, id)
      const made = { until: '' }
      const root = await changeTask(identity, id, async (found, position, now) => {
        await fenced(found, identity, proof, position, now)
        const { holdUntil } = found.task.claim!
        made.until = new Date(Math.min(now + leaseOf(lease), holdUntil === undefined ? Infinity : Date.parse(holdUntil))).toISOString()
        return [{ type: 'task.renewed', payload: { id, thread: found.thread, epoch: proof.epoch, until: made.until, by: identity.author } }]
      })
      await arm(id, proof.epoch, made.until)
      return { task: await shown(identity, root), until: made.until }
    },

    /** What ends a claim, by the claim: released, completed, or failed. A completion readies the tasks that waited only for it. */
    async settle(
      identity: Identity,
      id: number,
      proof: Proof,
      how: { type: 'task.released' } | { type: 'task.completed'; result: string | null } | { type: 'task.failed'; reason: string },
    ): Promise<{ task: MessageView }> {
      await taskOf(identity.principal.access, id)
      const root = await changeTask(identity, id, async (found, position, now) => {
        await fenced(found, identity, proof, position, now)
        const about = { id, thread: found.thread, epoch: proof.epoch, by: identity.author }
        if (how.type === 'task.released') {
          const waits = !(await satisfied(found.task, position))
          if (Date.parse(found.task.claim!.until) <= now) throw claimLost(id)
          return [{ type: 'task.released', payload: { ...about, ...(waits ? { waiting: true } : {}) } }]
        }
        if (found.task.work) {
          if (!scopers) throw noLifecycle()
          if (how.type === 'task.failed') throw conflict('work_lifecycle_required', 'release the claim for another attempt, or ask a scoper to reject the task')
          if (!workCanClaim(found.task.work.stage)) throw invalidStage(found, 'hand off')
          if (!(await satisfied(found.task, position))) throw waiting(found)
          if (Date.parse(found.task.claim!.until) <= now) throw claimLost(id)
          return [stageChanged(found, identity, 'handoff', how.result ?? 'implementation complete', how.result)]
        }
        if (how.type === 'task.failed') return [{ type: 'task.failed', payload: { ...about, reason: how.reason } }]
        const ready = await readied(id, position)
        return [{ type: 'task.completed', payload: { ...about, result: how.result } }, ...ready]
      })
      return { task: await shown(identity, root) }
    },

    /**
     * Holds a task for a person. A claimed task's hold is its claim's, which it ends; otherwise its
     * owner's, or `manage`'s. One whose lease ran out is no one's, so its owner holds it.
     */
    async block(identity: Identity, id: number, input: { reason: string; kind?: string | undefined; proof?: Proof | undefined }): Promise<{ task: MessageView }> {
      const task = await taskOf(identity.principal.access, id)
      if (!input.proof) owns(identity, task)
      const { proof } = input
      const root = await changeTask(identity, id, async (found, position, now) => {
        let expired: Events = []
        if (proof) await fenced(found, identity, proof, position, now)
        else {
          if (!beforeHandoff(found.task)) throw invalidStage(found, 'block')
          if (found.task.parked) throw parked(id)
          expired = expiredClaim(found, now, await epochAt(position))
          const state = expired.length ? 'ready' : found.task.state
          if (state === 'claimed') throw conflict('task_claimed', `#${id} is claimed until ${found.task.claim!.until}: only its claim holds it`)
          if (state === 'blocked') throw conflict('task_blocked', `#${id} is held already: ${found.task.blocked!.reason}`)
          if (finished(found.task)) throw conflict('task_finished', `#${id} is ${found.task.state}`)
        }
        return [...expired, { type: 'task.blocked', payload: { id, thread: found.thread, kind: input.kind ?? null, reason: input.reason, by: identity.author } }]
      })
      return { task: await shown(identity, root) }
    },

    /** Opens a hold, converts a plain human hold, or replaces the latest unanswered request. */
    async requestAttention(identity: Identity, id: number, input: RequestAttentionBody): Promise<AttentionChange> {
      await taskOf(identity.principal.access, id)
      const { claim, replaces, ...draft } = input
      const requestId = randomUUID()
      const root = await changeTask(identity, id, async (found, position, now) => {
        const { task } = found
        let expired: Events = []
        if (claim) await fenced(found, identity, claim, position, now)
        else {
          owns(identity, found)
          expired = expiredClaim(found, now, await epochAt(position))
          if (task.state === 'claimed' && !expired.length) throw conflict('task_claimed', `#${id} is claimed until ${task.claim!.until}: only its claim holds it`)
        }
        // A claimant may open a hold with its proof, but cannot delegate a failure it doesn't own.
        const canFail = draft.options.some(({ next }) => next === 'fail')
        if (claim && canFail) owns(identity, found)
        if (finished(task) || found.deleted) throw conflict('task_finished', `#${id} is ${task.state}`)
        if (task.parked) throw parked(id)
        if (!beforeHandoff(task)) throw invalidStage(found, 'request attention on')
        if (task.work && canFail) throw conflict('work_lifecycle_required', 'only a scoper can reject staged work')
        if (task.attention?.status === 'pending' ? task.attention.id !== replaces : replaces !== undefined) throw staleAttention()
        if (task.state === 'blocked' && task.blocked?.kind !== 'needs_input' && task.blocked?.kind !== 'awaiting_approval') {
          throw conflict('task_blocked', `#${id} is held already: ${task.blocked!.reason}`)
        }
        if (!(await matchesAttention(found, draft, position))) throw staleAttention()
        if (attentionExpired(draft, now)) throw badRequest('expiresAt must be in the future')
        writes().writer.beforeCommit((at) => {
          if (attentionExpired(draft, at)) throw badRequest('expiresAt must be in the future')
        })
        return [...expired, { type: 'task.attention_requested', payload: { id, thread: found.thread, by: identity.author, requestId, epoch: task.epoch, draft, ...(replaces !== undefined ? { replaces } : {}) } }]
      })
      return { task: await shown(identity, root), attention: attentionView(root.task!.attention!) }
    },

    async attention(identity: Identity, id: number): Promise<{ attention: AttentionView | null }> {
      const { reads } = writes()
      await reads.ensure()
      const position = await reads.tables.position()
      const root = (await reads.tables.messagesAt([id], position)).get(id)
      if (!root || !identity.principal.access.readable(root.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
      if (!root.task) throw notATask(id)
      const { attention, epoch, state } = root.task
      if (!attention) return { attention: null }
      const stale = attention.status === 'pending' && (
        state !== 'blocked' || attention.epoch !== epoch || !(await matchesAttention(root, attention, position)) || attentionExpired(attention, wallTime())
      )
      return { attention: attentionView(attention, stale) }
    },

    async answerAttention(identity: Identity, id: number, requestId: string, input: AttentionAnswerBody, verifiedRequest: boolean): Promise<AttentionChange> {
      const { principal, actor, author } = identity
      const { channel } = await taskOf(principal.access, id)
      if (!verifiedRequest || principal.kind !== 'person' || actor.id !== principal.id || author.profile !== null ||
          !principal.access.can('post', channel) ||
          !(responders.get(channel)?.has(principal.id) || responders.get('*')?.has(principal.id))) {
        throw forbidden('only a configured responder acting as themselves with read and post access can answer task attention')
      }
      const root = await changeTask(identity, id, async (found, position, now) => {
        const { task } = found
        const { attention } = task
        if (task.state !== 'blocked' || attention?.status !== 'pending' || attention.id !== requestId ||
            attention.commit !== input.commit || attention.epoch !== task.epoch ||
            !(await matchesAttention(found, attention, position)) || attentionExpired(attention, now)) throw staleAttention()
        const option = attention.options.find(({ id }) => id === input.option)
        if (!option) throw badRequest('option is not available on this attention request')
        const routedTo = option.next === 'fail' ? 'failed' : canReady(task) && (await satisfied(task, position)) ? 'ready' : 'waiting'
        writes().writer.beforeCommit((at) => { if (attentionExpired(attention, at)) throw staleAttention() })
        const receipt: AttentionReceipt = { option: option.id, by: author, at: new Date(now).toISOString(), routedTo }
        return [{ type: 'task.attention_answered', payload: { id, thread: found.thread, by: author, requestId, epoch: task.epoch, receipt } }]
      })
      return { task: await shown(identity, root), attention: attentionView(root.task!.attention!) }
    },

    /** Lifts a hold: back to ready, or to waiting while a task it needs hasn't completed. One that isn't held is left as it is. */
    async unblock(identity: Identity, id: number): Promise<{ task: MessageView }> {
      owns(identity, await taskOf(identity.principal.access, id))
      const root = await changeTask(identity, id, async (found, position, now) => {
        if (found.task.parked) throw parked(id)
        if (finished(found.task)) throw conflict('task_finished', `#${id} is ${found.task.state}`)
        if (found.task.state !== 'blocked') return []
        if (found.task.attention?.status === 'pending') throw conflict('attention_required', `#${id} is held by an attention request`)
        const about = { id, thread: found.thread }
        // The fold puts a task that needs any back to waiting: what it needs may have completed while it was held.
        const ready = canReady(found.task) && found.task.needs.length > 0 && (await satisfied(found.task, position))
        return [{ type: 'task.unblocked', payload: { ...about, by: identity.author } }, ...(ready ? [{ type: 'task.ready' as const, payload: about }] : [])]
      })
      return { task: await shown(identity, root) }
    },

    /** Places or lifts an operator's hold without reviving any lease. */
    async park(identity: Identity, id: number, reason: string, action: 'park' | 'unpark'): Promise<{ task: MessageView }> {
      await taskOf(identity.principal.access, id)
      const root = await changeTask(identity, id, async (found, position, now) => {
        const { task, thread, channel } = found
        if (identity.principal.kind !== 'person' || identity.actor.kind !== 'person' || identity.author.profile !== null)
          throw forbidden('only a verified person acting as themselves can park or unpark a task')
        authorize(identity.principal.access, 'manage', channel)
        if (finished(task)) throw conflict('task_finished', `#${id} is ${task.state}`)
        const about = { id, thread }
        const by = identity.author
        if (action === 'park') {
          if (task.parked) return []
          if (task.state !== 'waiting' && task.state !== 'ready' && task.state !== 'claimed')
            throw conflict('task_blocked', `#${id} is already blocked`)
          const expired = expiredClaim(found, now, await epochAt(position))
          return [...expired, { type: 'task.parked', payload: { ...about, reason, by, previous: expired.length ? 'ready' : task.state } }]
        }
        if (!task.parked) return []
        const ready = !task.blocked && canReady(task) && task.needs.length > 0 && (await satisfied(task, position))
        return [{ type: 'task.unparked', payload: { ...about, reason, by } }, ...(ready ? [{ type: 'task.ready' as const, payload: about }] : [])]
      })
      return { task: await shown(identity, root) }
    },

    /** Records a packet reference, fencing both the claim and the handoff it replaces. */
    async handoff(identity: Identity, id: number, proof: Proof, packet: TaskHandoffInput): Promise<{ task: MessageView }> {
      await taskOf(identity.principal.access, id)
      const root = await changeTask(identity, id, async (found, position, now) => {
        await fenced(found, identity, proof, position, now)
        const { commit, packetPath, sha256, supersedes } = packet
        if (supersedes !== found.task.handoff?.id)
          throw conflict('handoff_conflict', `supersedes must name the current handoff on #${id}, or be omitted for the first handoff`)
        const handoff = { id: randomUUID(), commit, packetPath, sha256, ...(supersedes !== undefined ? { supersedes } : {}), by: identity.author, at: new Date(now).toISOString(), generation: proof.epoch }
        return [{ type: 'task.handoff', payload: { id, thread: found.thread, handoff } }]
      })
      return { task: await shown(identity, root) }
    },

    async scope(identity: Identity, id: number, reason: string, ifVersion: number): Promise<{ task: MessageView }> {
      if (!scopers) throw noLifecycle()
      taskLimits.note('reason', reason)
      await taskOf(identity.principal.access, id)
      const root = await changeScoperTask(identity, id, (found, position) => {
        if (!found.task.work) throw noLifecycle()
        if (found.task.work.stage !== 'proposed') throw invalidStage(found, 'scope')
        atVersion(found, ifVersion)
        return enterWork(found, identity, 'scoped', reason, position)
      })
      return { task: await shown(identity, root) }
    },

    async stage(identity: Identity, id: number, stage: WorkStageTarget, reason: string, ifVersion: number): Promise<{ task: MessageView }> {
      if (!scopers) throw noLifecycle()
      taskLimits.note('reason', reason)
      await taskOf(identity.principal.access, id)
      const root = await changeScoperTask(identity, id, async (found, position) => {
        if (!found.task.work) throw noLifecycle()
        const from = found.task.work.stage
        if (stage === 'rejected' ? workTerminal(from) : !fromStages[stage].includes(from)) throw invalidStage(found, `move to ${stage}`)
        atVersion(found, ifVersion)
        if (stage === 'done' && !(await satisfied(found.task, position))) throw waiting(found)
        const events = await enterWork(found, identity, stage, reason, position)
        if (stage === 'done') events.push(...await readied(id, position))
        return events
      })
      return { task: await shown(identity, root) }
    },

    /** Legacy failed work retries in place. Staged work must be scoped again. */
    async reopen(identity: Identity, id: number, reason?: string, ifVersion?: number): Promise<{ task: MessageView }> {
      const task = await taskOf(identity.principal.access, id)
      if (!task.task.work) owns(identity, task)
      const root = await changeScoperTask(identity, id, async (found, position) => {
        if (found.task.work) {
          const from = found.task.work.stage
          if (from !== 'done' && from !== 'rejected') throw invalidStage(found, 'reopen')
          if (reason === undefined || ifVersion === undefined) throw badRequest('reason and ifVersion are required to reopen staged work')
          taskLimits.note('reason', reason)
          atVersion(found, ifVersion)
          const events: Events = [stageChanged(found, identity, 'proposed', reason)]
          if (from === 'done') {
            // Only ready dependents wait again here. A dependent that was claimed keeps its claim.
            // The board authors the change because the dependent's readers may not see the stage move.
            for await (const root of rootsAt({}, ['ready'], position)) {
              if (root.task.needs.includes(id))
                events.push({ type: 'task.needs_changed', payload: { id: root.id, thread: root.thread, needs: root.task.needs, by: TASKS_AUTHOR } })
            }
          }
          return events
        }

        const { task } = found
        if (task.state === 'completed' || task.state === 'canceled') throw conflict('task_finished', `#${id} is ${task.state}`)
        if (task.state !== 'failed') return []
        const waiting = !(await satisfied(task, position))
        return [{ type: 'task.reopened', payload: { id, thread: found.thread, by: identity.author, ...(waiting ? { waiting: true as const } : {}) } }]
      })
      return { task: await shown(identity, root) }
    },

    /** Assigns a task to one of its owner's actors, or with null to anyone who may claim it. A claim it has stays. */
    async assign(identity: Identity, id: number, actor: string | null): Promise<{ task: MessageView }> {
      const task = await taskOf(identity.principal.access, id)
      if (!task.task.work) owns(identity, task)
      const root = await changeScoperTask(identity, id, async (found, position, _access, now) => {
        // Only a caller allowed to assign may see the owner's namespace in a validation error.
        const assigned = ownActor(found.task.owner, actor)
        if (found.task.work) {
          if (!beforeHandoff(found.task)) throw invalidStage(found, 'assign')
          if (stateNow(found.task, now, await epochAt(position)) === 'claimed') throw conflict('task_claimed', `#${id} is claimed: release the claim before reassigning it`)
        }
        if (finished(found.task)) throw conflict('task_finished', `#${id} is ${found.task.state}`)
        return found.task.for === assigned ? [] : [{ type: 'task.assigned', payload: { id, thread: found.thread, for: assigned, by: identity.author } }]
      })
      return { task: await shown(identity, root) }
    },

    /**
     * Replaces what a task waits for, for its owner or `manage`, while no one holds it and it isn't
     * finished. Added prerequisites are checked as a new task's are and must not close a cycle.
     * It waits for its new list from this write, and `task.ready` follows in it when they've all
     * completed; with none it's ready. A held task stays held, and the same set changes nothing.
     */
    async needs(identity: Identity, id: number, refs: readonly string[]): Promise<{ task: MessageView }> {
      const { principal } = identity
      const current = await taskOf(principal.access, id)
      if (!current.task.work) owns(identity, current)
      const root = await changeScoperTask(identity, id, async (found, position, access, now) => {
        const { task } = found
        if (!beforeHandoff(task)) throw invalidStage(found, 'change prerequisites of')
        if (finished(task)) throw conflict('task_finished', `#${id} is ${task.state}`)
        // A claim whose lease ran out is over: its expiry goes first, in the same append.
        const expired = expiredClaim(found, now, await epochAt(position), !(await satisfied(task, position)))
        if (task.state === 'claimed' && !expired.length) throw conflict('task_claimed', `#${id} is claimed until ${task.claim!.until}: what it needs changes once no one holds it`)
        const needs = await needsAt(access, refs, position, id, task.needs)
        if (needs.ids.length === task.needs.length && needs.ids.every((need) => task.needs.includes(need))) return []
        await acyclic(access, id, needs.ids.filter((need) => !task.needs.includes(need)), position)
        const about = { id, thread: found.thread }
        return [
          ...expired,
          { type: 'task.needs_changed', payload: { ...about, needs: needs.ids, by: identity.author } },
          ...(needs.ids.length > 0 && needs.completed && task.state !== 'blocked' && canReady(task) ? [{ type: 'task.ready' as const, payload: about }] : []),
        ]
      })
      return { task: await shown(identity, root) }
    },

    /** Changes an open task's priority without changing its claim, state, or labels. */
    async priority(identity: Identity, id: number, priority: TaskPriority, proof?: Proof): Promise<{ task: MessageView }> {
      await taskOf(identity.principal.access, id)
      const root = await changeTask(identity, id, async (found, position, now) => {
        const { task } = found
        let expired: Events = []
        if (proof) await fenced(found, identity, proof, position, now)
        else {
          owns(identity, found)
          if (task.claim) expired = expiredClaim(found, now, await epochAt(position))
          // A current holder cannot bypass the claim's limit by omitting its proof.
          if (task.claim?.actor === identity.actor.id && !expired.length)
            throw conflict('task_claimed', `#${id} is held by your claim: change priority through it`)
        }
        if (finished(task)) throw conflict('task_finished', `#${id} is ${task.state}`)
        const previous = task.priority ?? DEFAULT_TASK_PRIORITY
        if (proof && priorityRank(priority) > priorityRank(previous))
          throw new HttpError(403, 'priority_raise_forbidden', 'a claim may lower priority, not raise it')
        if (priority === previous) return []
        return [...expired, { type: 'task.priority_changed', payload: { id, thread: found.thread, priority, ...(proof ? { epoch: proof.epoch } : {}), by: identity.author } }]
      })
      return { task: await shown(identity, root) }
    },

    /** Cancels a task that hasn't completed, ending any claim. What waits for it keeps waiting. */
    async cancel(identity: Identity, id: number, reason: string): Promise<{ task: MessageView }> {
      const task = await taskOf(identity.principal.access, id)
      if (!task.task.work) owns(identity, task)
      const root = await changeScoperTask(identity, id, async (found, position, _access, now) => {
        if (found.task.work) {
          if (workTerminal(found.task.work.stage)) throw invalidStage(found, 'cancel')
          return [stageChanged(found, identity, 'canceled', reason)]
        }
        if (found.task.state === 'completed' || found.task.state === 'canceled') throw conflict('task_finished', `#${id} is ${found.task.state}`)
        const expired = found.task.claim ? expiredClaim(found, now, await epochAt(position)) : []
        return [...expired, { type: 'task.canceled', payload: { id, thread: found.thread, reason, by: identity.author } }]
      })
      return { task: await shown(identity, root) }
    },
  }
}
