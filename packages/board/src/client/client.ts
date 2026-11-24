import type {
  ActorView,
  AgentHealth,
  AgentIntent,
  AgentView,
  AttentionAnswerBody,
  BoardEventView,
  BoardStatus,
  ChannelView,
  Discovery,
  EventsPage,
  FiltersInput,
  InboxEntry,
  InboxItem,
  IntentOutcome,
  IssueOpsIntentInput,
  IssueOpsRoleIntentInput,
  ListOpsIntentsInput,
  OpsIntentsIssued,
  OpsIntentsPage,
  OperationalMessage,
  OperationalStatus,
  SendOperationalMessageInput,
  SyncCopiesView,
  SyncFindInput,
  SyncFindView,
  SyncImportInput,
  SyncReceiptInput,
  SyncThreadView,
  SourceJoin,
  SourceRead,
  SyncedView,
  Me,
  PrincipalInput,
  MatchView,
  ChannelMessagesQueryInput,
  ChannelsPage,
  ChannelsQueryInput,
  MessagesPage,
  MessageView,
  RegisterInput,
  RegisterOpsAgentInput,
  RegistrationView,
  RequestAttentionBody,
  ScheduleView,
  SchedulesQueryInput,
  TaskBindingInput,
  TaskClaim,
  TaskHandoffInput,
  TaskHandoffWrite,
  TasksPage,
  TasksQueryInput,
  GrantInput,
  CreateInviteInput,
  CreatedInvite,
  InviteView,
  Joined,
  GrantWriteOptions,
  GrantView,
  UpdateGrantInput,
  Explanation,
  SchemaInput,
  SchemaView,
  ThreadsPage,
  ThreadQueryInput,
  ThreadsQueryInput,
  ThreadSummaryView,
  ThreadView,
  TypingResult,
} from '../api/routes.ts'
import { ACTORS_BY_ID_MAX, readDiscovery } from '../api/routes.ts'
import { boundTaskPaths } from '../api/task-authority.ts'
import type { Protocol } from '../api/protocol.ts'
import type { Actor } from '../contract/folds.ts'
import type { Mentioned } from '../contract/mentions.ts'
import { ATTACHMENT_BYTES_MAX, DIRECT_UPLOAD_BYTES_MAX, typeOf } from '../contract/files.ts'
import type { Attachment, TaskPriority } from '../contract/schemas.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { parseSse } from './sse.ts'
import { formatProfileHeader } from '../contract/profile-header.ts'

/**
 * Where an error came from: `handle`, raised by the handle on this machine (no Vercel login,
 * Deployment Protection), or `board`, a board's answer, whose words are its own whatever code it
 * names.
 */
export type ErrorOrigin = 'handle' | 'board'

/**
 * What went wrong: `message` says what and why, `code` is what to branch on, `hint`, when there's
 * one, what fixes it, and `origin` who said so. Trust a `board` one's message and hint as you would
 * the board.
 */
export class BoardError extends Error {
  readonly code: string
  readonly status: number
  readonly hint: string | undefined
  readonly origin: ErrorOrigin
  /** For a 429, how many seconds the board asked to wait before sending again (its `Retry-After`), when it said. */
  readonly retryAfter: number | undefined
  constructor(code: string, message: string, status: number, options: { hint?: string; origin?: ErrorOrigin; retryAfter?: number } = {}) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.status = status
    this.hint = options.hint
    this.origin = options.origin ?? 'handle'
    this.retryAfter = options.retryAfter
  }
}

/**
 * The responses, made in this process, that carry an error the handle raised: a handle's request
 * to a board in this process keeps its errors the handle's on the way back. Nothing a board sends
 * can be one.
 */
export const handleErrors = new WeakSet<Response>()

export type Resolvable<T> = T | (() => T | Promise<T>)
const resolve = async <T>(value: Resolvable<T>): Promise<T> =>
  typeof value === 'function' ? await (value as () => T | Promise<T>)() : value

/** A profile name, `{ name, avatar }`, or null for no profile. */
export type ProfileOption = string | { name: string; avatar?: string } | null

export type ClientOptions = {
  /** The board's URL, e.g. `https://www.example.com/api/board`. */
  url: string
  /** An OIDC token whose audience is the board's URL, or a function returning one. Without one, `fetch` brings the credentials. */
  token?: Resolvable<string>
  profile?: Resolvable<ProfileOption>
  /** Extra headers on every request. */
  headers?: Resolvable<Record<string, string>>
  fetch?: typeof fetch
  /**
   * How a direct upload's bytes go to the blob store's signed URL: `fetch` by default, never the
   * board's own, which brings the board's credentials and would hand them to the store.
   */
  storeFetch?: typeof fetch
}

/**
 * What a write that took a text answers: what it made, and under `mentions`, what became of each
 * `@handle` the text typed, when it typed any.
 */
export type Written<T> = T & { mentions?: Mentioned[] }

export type PostOptions = {
  text: string
  labels?: Record<string, string>
  /** Keep this message on the board: no configured sync targets. */
  noSync?: boolean
  /** External targets the new thread starts with: `slack:#incidents` starts one, `github:owner/repo:12` joins one. */
  sync?: string[]
  /** Makes retries idempotent: the same id never posts twice. */
  id?: string
  /** Files from `upload`, or their IDs. */
  attachments?: (Attachment | string)[]
}

export type ReplyOptions = Omit<PostOptions, 'sync'> & {
  /**
   * Posts only while this is the thread's newest message: the ID of the last one you read. If
   * another has come after it, nothing is posted, and it throws a 409 `newer_message`.
   */
  after?: string
}

/**
 * When a scheduled message goes out: once `in` a while or `at` a time, or
 * `every` so often (first at `at`, `in`, or one `every` from now), stopping
 * `until` a time, `for` a while after the first send, or after `times` sends.
 * A repeat with no stop runs until it's canceled.
 */
export type ScheduleTiming = {
  in?: string
  at?: Date | string
  every?: string
  until?: Date | string
  for?: string
  times?: number
}

export type ScheduleOptions = Omit<PostOptions, 'sync' | 'id'> & ScheduleTiming

const scheduleBody = (input: ScheduleOptions) => {
  const { at, until, ...rest } = messageBody(input) as ScheduleOptions
  return {
    ...rest,
    ...(at !== undefined ? { at: at instanceof Date ? at.toISOString() : at } : {}),
    ...(until !== undefined ? { until: until instanceof Date ? until.toISOString() : until } : {}),
  }
}

/**
 * What makes a thread a task: the tasks it waits for (`needs`, by their IDs), the one actor of
 * yours that claims it (`for`, `<your principal>+<profile>`), and `claim`, which claims it in the
 * same write, for `lease` seconds, with `token` as its token when you bring one.
 */
export type TaskOptions = {
  priority?: TaskPriority
  needs?: string[]
  for?: string | null
  claim?: boolean
  lease?: number
  token?: string
  binding?: TaskBindingInput
}

type ClaimOptions = Pick<TaskOptions, 'lease' | 'token' | 'binding'> & { hold?: number }
type ClaimNext = ClaimOptions & { channel: string; label?: Record<string, string>; from?: string[]; wait?: number }

/** A new thread that's a task: its root's text, labels, `noSync`, `attachments`, and `id`, as a post takes them, and what makes it a task. */
export type NewTaskOptions = TaskOptions & Pick<PostOptions, 'text' | 'labels' | 'noSync' | 'attachments' | 'id'>

/**
 * One task of several made together: its root's text, labels, `noSync`, and `attachments`, as a
 * post takes them. `key` is a name for it among the others, and `needs` takes a task's ID, or
 * `{ key }` for one made with it, before or after it. `for` is the one actor of yours that claims it.
 */
export type TaskInBatch = Required<Pick<PostOptions, 'text'>> &
  Pick<PostOptions, 'labels' | 'noSync' | 'attachments'> & {
    key?: string
    priority?: TaskPriority
    needs?: (string | { key: string })[]
    for?: string | null
  }

/**
 * What a claim does, each fenced by the claim: once it's over (released, settled, held, taken over,
 * or past its lease), they throw a 409 `claim_lost` and change nothing.
 */
export type HeldTask = {
  /** Extends the lease from now, by `lease` seconds (the board's default without one). Answers the claim with its new `until`. */
  renew(lease?: number): Promise<ClaimedTask>
  /** Gives the task back: it's ready again. */
  release(): Promise<MessageView>
  complete(result?: string): Promise<MessageView>
  fail(reason: string): Promise<MessageView>
  /** Lowers the priority without ending the claim. A claim cannot raise it. */
  priority(priority: TaskPriority): Promise<MessageView>
  /** Holds the task for a person, which ends the claim: `kind` says what for (`needs_input`, `awaiting_approval`). */
  block(reason: string, opts?: { kind?: string }): Promise<MessageView>
  /** Records packet metadata without settling the claim or verifying the packet. */
  handoff(packet: TaskHandoffInput): Promise<MessageView>
}

/**
 * A task you hold until `until`: its root as the claim left it, and the claim's `epoch` and
 * `token`, which `held` takes to act on it from another process.
 */
export type ClaimedTask = HeldTask & TaskClaim & { task: MessageView }

/** What `upload` takes: the bytes, and what to call them. */
export type UploadInput = {
  data: Blob | Uint8Array<ArrayBuffer>
  name: string
  /** A MIME type; a `Blob`'s own type, or one from the name's extension, otherwise. */
  type?: string
}

const messageBody = (input: string | PostOptions | ReplyOptions) => {
  if (typeof input === 'string') return { text: input }
  const { attachments, ...rest } = input
  return attachments?.length ? { ...rest, attachments: attachments.map((a) => (typeof a === 'string' ? a : a.id)) } : rest
}

/** Whether live events are flowing: `live` once the board has answered a request for them, `retrying` once one failed and it's backing off. */
export type EventsState = 'live' | 'retrying'

/**
 * What following events takes: a `signal` that stops it, and `onState`, told each time the feed
 * goes live or starts retrying. It hears nothing before the first answer or failure.
 */
export type EventsOptions = {
  signal?: AbortSignal
  onState?: (state: EventsState) => void
}

/** Tells `onState` each change, once: `live` when the board answers, `retrying` when a request fails. It never guesses. */
export function eventsState(onState: EventsOptions['onState']) {
  let current: EventsState | null = null
  const tell = (next: EventsState) => {
    if (next === current) return
    current = next
    onState?.(next)
  }
  return { answered: () => tell('live'), failed: () => tell('retrying') }
}

export type WaitOptions = {
  /** `'30s'`, `'10m'`, `'1h'`, or milliseconds. Default `'30m'`. */
  timeout?: string | number
  signal?: AbortSignal
}

/** How long one request for a ready task is held, in seconds, as one for the next event is. */
const CLAIM_WAIT_S = 25
/** How soon a claim that waits asks again, when the board answered without holding the request. */
const CLAIM_AGAIN_MS = 1000

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export function duration(value: string | number): number {
  if (typeof value === 'number') return value
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/)
  if (!match) throw new BoardError('invalid_duration', `${value} isn't a duration like 30s, 10m, or 1h.`, 0)
  return Number(match[1]) * UNITS[match[2] ?? 'ms']!
}

/** A ref as a path segment: opaque, so it's encoded as it is. */
const path = (id: string) => encodeURIComponent(id)

function queryString(query: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (key === 'label') {
      const labels = Array.isArray(value)
        ? value
        : typeof value === 'object'
          ? Object.entries(value).map(([k, v]) => `${k}=${String(v)}`)
          : [value]
      for (const label of labels) params.append('label', String(label))
    } else params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export type Filters = Omit<FiltersInput, 'label'> & {
  /** `{ status: 'open' }` or `['status=open']`. */
  label?: Record<string, string> | string[]
}

export type BoardClient = ReturnType<typeof createBoardClient>

/** A `can` as the wire takes it: `'none'` at a pattern is `[]`. */
function wireCan<T>(can: T): T {
  if (can === null || typeof can !== 'object' || Array.isArray(can)) return can
  return Object.fromEntries(Object.entries(can).map(([pattern, grant]) => [pattern, grant === 'none' ? [] : grant])) as T
}

/** A principal to grant as the wire takes it: a project's environments, and every project's, are production when left out. */
const withEnvironments = (principal: PrincipalInput): PrincipalInput =>
  (principal.kind === 'project' || principal.kind === 'all-projects') && principal.environments === undefined ? { ...principal, environments: ['production'] } : principal

/** A grant as the wire takes it. */
const wireGrant = (input: GrantInput) => ({ principals: input.principals.map(withEnvironments), can: wireCan(input.can) })

/** What a grant write's body says to go ahead with a lockout: nothing, unless it was asked to. */
const goAhead = ({ lockMeOut }: GrantWriteOptions): { lockMeOut?: true } => (lockMeOut ? { lockMeOut: true } : {})

/**
 * The principal a private channel lets its creator in as, from what `/me` says it is: a person's
 * user, or a deployment's project in the environment it runs in. Anyone else is refused before
 * anything is written.
 */
function creatorOf(me: Me, path: string): PrincipalInput {
  const [source, kind, id, environment] = me.principal.split(':')
  if ((source === 'vercel' || source === 'local') && kind === 'user' && id) return { kind: 'user', userId: me.principal.split(':').slice(2).join(':') }
  if (source === 'vercel' && kind === 'project' && id && environment) return { kind: 'project', project: id, environments: [environment] }
  throw new BoardError('no_own_principal', `A private channel lets its creator in, as a person or a project's deployment, and ${me.principal} is neither, so ${path} wasn't made.`, 400, {
    hint: 'Make it as a person or a deployment, or make it and its grants yourself.',
  })
}

/** Whom `explain` asks about: nobody for yourself, or one principal as people name it. */
export type ExplainPrincipal = {
  user?: string
  project?: string
  /** Where the project's deployment runs: production when left out. */
  environment?: string
  github?: string
  workflow?: string
  branch?: string
  event?: string
  oidc?: string
  claims?: Record<string, string>
  /** An app on the team, by its slug or client ID. */
  app?: string
}

export function createBoardClient(options: ClientOptions) {
  const base = options.url.replace(/\/+$/, '')
  // Browsers reject a bare `fetch` detached from `window` ("Illegal invocation").
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const storeFetch = options.storeFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))

  async function headers(auth: boolean, as?: ProfileOption): Promise<Record<string, string>> {
    const out: Record<string, string> = { ...(options.headers ? await resolve(options.headers) : {}) }
    if (!auth) return out
    if (options.token !== undefined) out.authorization = `Bearer ${await resolve(options.token)}`
    const profile = as !== undefined ? as : options.profile === undefined ? null : await resolve(options.profile)
    if (profile !== null) out['x-board-profile'] = formatProfileHeader(typeof profile === 'string' ? { name: profile } : profile)
    return out
  }

  async function raw(
    method: string,
    path: string,
    init: { body?: unknown; auth?: boolean; headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestRedirect; claim?: boolean } = {},
  ): Promise<Response> {
    const response = await (init.claim ? claimFetch(doFetch, base) : doFetch)(`${base}${path}`, {
      method,
      headers: {
        ...(await headers(init.auth ?? true)),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    })
    if (!response.ok) throw await toError(response)
    return response
  }

  async function call<T>(
    method: string,
    path: string,
    init?: Parameters<typeof raw>[2],
  ): Promise<T> {
    return (await (await raw(method, path, init)).json()) as T
  }

  const filtersQuery = (filters: Filters = {}) => filters

  async function poll(
    query: Filters & { after?: string; wait?: number; all?: boolean; last?: number } = {},
    signal?: AbortSignal,
  ): Promise<EventsPage> {
    return call<EventsPage>('GET', `/events${queryString(query)}`, signal ? { signal } : {})
  }

  /** One write to task `id`, which answers its root. */
  const taskWrite = async (id: string, verb: string, body: object = {}, claim = false) =>
    (await call<{ task: MessageView }>('POST', `/tasks/${path(id)}/${verb}`, { body, claim })).task

  /** What a claim on task `id` does, with the `epoch` and `token` the claim answered. */
  const held = (id: string, proof: Omit<TaskClaim, 'until'>): HeldTask => {
    const { epoch, token, pauseEpoch } = proof
    return {
      async renew(lease) {
        const { task, until } = await call<{ task: MessageView; until: string }>('POST', `/tasks/${path(id)}/renew`, { body: { epoch, token, ...(lease !== undefined ? { lease } : {}) }, claim: true })
        const binding = task.task?.claim?.binding
        const holdUntil = task.task?.claim?.holdUntil
        return claimed(task, { epoch, token, until, ...(holdUntil ? { holdUntil } : {}), ...(pauseEpoch === undefined ? {} : { pauseEpoch }), ...(binding ? { binding } : {}) })
      },
      release: () => taskWrite(id, 'release', { epoch, token }, true),
      complete: (result) => taskWrite(id, 'complete', { epoch, token, ...(result !== undefined ? { result } : {}) }, true),
      fail: (reason) => taskWrite(id, 'fail', { epoch, token, reason }, true),
      priority: (priority) => taskWrite(id, 'priority', { epoch, token, priority }, true),
      block: (reason, opts = {}) => taskWrite(id, 'block', { epoch, token, reason, ...opts }, true),
      handoff: (packet) => taskWrite(id, 'handoff', { ...packet, epoch, token }, true),
    }
  }

  /** A claim as a handle answers it: the task, the claim, and what the claim does. */
  const claimed = (task: MessageView, claim: TaskClaim): ClaimedTask => ({ task, ...claim, ...held(task.id, claim) })

  async function checkedClaim(task: MessageView, claim: TaskClaim, hold: number | undefined): Promise<ClaimedTask> {
    const result = claimed(task, claim)
    if (hold !== undefined && !claim.holdUntil) {
      // Discovery and the write can land on different versions. Never hand out an uncapped lease.
      await result.release().catch(() => undefined)
      throw new BoardError('no_claim_hold', 'the board did not honor the hard end for the claim', 501, { origin: 'handle' })
    }
    return result
  }

  /**
   * Starts a thread in `target` as a task, or with `{ re }` makes the thread that message roots
   * one, as it is. Starting one needs `post` there, and `label` for its labels; `{ re }` needs
   * `label`. You own it. `claim` comes back when it was made with `claim: true`.
   */
  async function createTask(target: string, input: string | NewTaskOptions): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }>
  async function createTask(target: { re: string }, input?: TaskOptions): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }>
  async function createTask(target: string | { re: string }, input: string | NewTaskOptions | TaskOptions = {}): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }> {
    const where = typeof target === 'string' ? { channel: target } : { re: target.re }
    // A new thread's root takes files as a post does: uploads, or their IDs.
    const made = typeof input === 'string' ? { text: input } : 'attachments' in input && input.attachments?.length ? { ...input, attachments: input.attachments.map((file) => (typeof file === 'string' ? file : file.id)) } : input
    const route = 'binding' in made && made.binding !== undefined ? boundTaskPaths.createTask : '/tasks'
    const { task, claim, mentions } = await call<{ task: MessageView; claim?: TaskClaim; mentions?: Mentioned[] }>('POST', route, { body: { ...where, ...made }, claim: 'token' in made && made.token !== undefined })
    return { task, ...(claim ? { claim: claimed(task, claim) } : {}), ...(mentions ? { mentions } : {}) }
  }

  /**
   * Starts a thread in `channel` for each of `tasks`, as tasks, in one write: all of them or none,
   * and none shows before all have landed. It answers their roots in the order given. A task waits
   * for the ones made with it by their `key`. With `id`, a retry answers the tasks the first call
   * made. A board makes 100 at most, and throws a 400 `batch_too_large` for more, or for more than it
   * holds in one write: `createTasksInChunks` makes a longer plan, in several.
   */
  async function createTasks(channel: string, tasks: TaskInBatch[], opts: { id?: string } = {}): Promise<MessageView[]> {
    const sent = tasks.map((task) => (task.attachments?.length ? { ...task, attachments: task.attachments.map((file) => (typeof file === 'string' ? file : file.id)) } : task))
    return (await call<{ tasks: MessageView[] }>('POST', '/tasks/batch', { body: { channel, tasks: sent, ...(opts.id !== undefined ? { id: opts.id } : {}) } })).tasks
  }

  /**
   * Claims task `target`, or with `{ channel }` the highest priority eligible ready task in that
   * channel (`work`) or subtree (`work/`). At equal priority, it prefers tasks assigned to you,
   * then takes the oldest. It has every label in `label` and is assigned to you, or unassigned
   * and owned by you or an owner `from` names by ID (400 `invalid_from` for a handle, which
   * several can share). It needs `label` where the task is. A task by ID that can't be claimed
   * throws a 409 (`task_claimed`, `task_waiting`, ...); a channel with nothing ready answers
   * null, after waiting up to `wait` seconds for one. `lease` is how long you hold it, in seconds,
   * the board's default without one: a board says how short and how long one may be, and the
   * claim's `until` says what it gave. `hold` caps the initial lease and all renewals at a fixed end.
   */
  async function claimTask(target: string, opts?: ClaimOptions & { signal?: AbortSignal }): Promise<ClaimedTask>
  async function claimTask(target: ClaimNext, opts?: { signal?: AbortSignal }): Promise<ClaimedTask | null>
  async function claimTask(
    target: string | ClaimNext,
    opts: ClaimOptions & { signal?: AbortSignal } = {},
  ): Promise<ClaimedTask | null> {
    const { signal: abort, ...body } = opts
    const signal = abort ? { signal: abort } : {}
    if (typeof target === 'string') {
      const route = body.binding !== undefined ? boundTaskPaths.claimTask.replace(':id', () => path(target)) : `/tasks/${path(target)}/claim`
      const { task, claim } = await call<{ task: MessageView; claim: TaskClaim }>('POST', route, { body, ...signal, claim: body.token !== undefined })
      return checkedClaim(task, claim, body.hold)
    }
    const { wait, ...ready } = target
    const route = ready.binding !== undefined ? boundTaskPaths.claimReadyTask : '/tasks/claim'
    const deadline = Date.now() + (wait ?? 0) * 1000
    for (;;) {
      const asked = Date.now()
      // The board holds each request up to its own limit: it asks again until `wait` runs out.
      const hold = Math.max(0, Math.min(CLAIM_WAIT_S, (deadline - asked) / 1000))
      const answer = await call<{ task: MessageView; claim: TaskClaim } | { task: null }>('POST', route, { body: { ...ready, ...(hold > 0 ? { wait: hold } : {}) }, ...signal, claim: ready.token !== undefined })
      if (answer.task) return checkedClaim(answer.task, answer.claim, ready.hold)
      if (Date.now() >= deadline || opts.signal?.aborted) return null
      // A board that answered at once instead of holding isn't asked again right away.
      const pause = Math.min(CLAIM_AGAIN_MS - (Date.now() - asked), deadline - Date.now())
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause))
    }
  }

  return {
    url: base,
    /**
     * The board's HTTP API with this client's credentials, and the response as
     * the board sent it, errors included: for proxies like `vb inspect`.
     */
    request: async (
      path: string,
      init: {
        method?: string
        body?: Uint8Array<ArrayBuffer>
        headers?: Record<string, string>
        signal?: AbortSignal
        /** Act as this profile (`null` for yourself) instead of the client's. */
        as?: ProfileOption
        /** The request carries a claim's token or proof: it goes to this board's URL and nowhere else, and a redirect is refused (`redirect_refused`), never followed. */
        claim?: boolean
      } = {},
    ): Promise<Response> =>
      (init.claim ? claimFetch(doFetch, base) : doFetch)(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { ...init.headers, ...(await headers(true, init.as)) },
        ...(init.body ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      }),
    discovery: async () => readDiscovery(await raw('GET', '/', { auth: false })),
    me: () => call<Me>('GET', '/me'),
    /** Whether the board is admitting work, and its current pause epoch. */
    status: () => call<BoardStatus>('GET', '/control'),
    /** Stop new work admission and fence earlier claims. Requires a person with global manage. */
    pause: (reason: string) => call<BoardStatus>('POST', '/control/pause', { body: { reason } }),
    /** Reopen work admission. Does not restore fenced claims. Requires a person with global manage. */
    resume: (reason: string) => call<BoardStatus>('POST', '/control/resume', { body: { reason } }),
    /**
     * A page of the board's channels: `prefix` keeps the ones whose path starts with it (`dev/`), `limit` is how many
     * (100 unless it says, 500 at most), and `after` takes a page's `next`, which is null on the last.
     */
    channels: async (query: ChannelsQueryInput = {}) => {
      const page = await call<Omit<ChannelsPage, 'next'> & { next?: string | null }>('GET', `/channels${queryString(query)}`)
      // A board from before pages answers them all, and no `next`.
      return { ...page, next: page.next ?? null }
    },
    /**
     * Makes a channel before anything posts to it, as a first post would. Needs `read` and `post`
     * there. `created` is false when it was there already; it's left as it is.
     *
     * `private` makes it closed to everyone but you, from the protocol's own methods: a grant
     * letting you in at `<path>/`, then one closing `<path>/` to everyone else, then the channel,
     * answering the two grants as `grants`. A failure part way leaves the channel open with a grant
     * too many, or closed and not made yet, and never shuts you out. Before it writes anything, it
     * refuses a caller that's neither a person nor a project's deployment (400 `no_own_principal`),
     * one that can't list grants, a path a grant other than `*`'s reaches already (409
     * `channel_granted`: the channel, `<path>/`, or a pattern under it, whose grants would still let
     * in whoever they name), and a path where it or a channel under it is there already (409
     * `channel_exists`), since closing `security/` closes `security/incidents` too. A board that
     * keeps no grants fails on the listing, with nothing made. Once its own grant is made it lists
     * them again, and takes its own back when another reaches the path, so of two callers making
     * the same channel at once, at most one keeps a way in; and once the lock is made, it lists them
     * a last time, and takes both back when a grant made in between still reaches the path, or its
     * own two aren't as it made them (someone added themselves to its grant, or opened the lock).
     */
    createChannel: async (path: string, options: { private?: boolean } = {}): Promise<{ channel: ChannelView; created: boolean; grants?: GrantView[] }> => {
      if (!options.private) return call<{ channel: ChannelView; created: boolean }>('POST', '/channels', { body: { path } })
      const creator = creatorOf(await call<Me>('GET', '/me'), path)
      const pattern = `${path}/`
      // A grant that already reaches it would still let in whoever it names, past the lock.
      const reaching = async () =>
        (await call<{ grants: GrantView[] }>('GET', '/grants')).grants.filter((grant) => Object.keys(grant.can).some((at) => at === path || at.startsWith(pattern)))
      const granted = (grants: GrantView[], mine: GrantView[] = []) => {
        // Its own grants, changed while it was made, are revoked by now: there's nothing to revoke.
        const changed = grants.filter((grant) => mine.some((ours) => ours.id === grant.id)).map((grant) => grant.id)
        if (changed.length === grants.length)
          return new BoardError('channel_granted', `${changed.join(' and ')} changed while ${path} was being made, so a private ${path} wouldn't be yours alone: nothing was made.`, 409)
        const named = grants.filter((grant) => !changed.includes(grant.id)).map((grant) => grant.id)
        const list = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
        return new BoardError('channel_granted', `${list} already ${named.length === 1 ? 'grants' : 'grant'} in ${path}, so a private ${path} wouldn't be yours alone: nothing was made.`, 409, {
          // The message names them all; one command fits only one.
          hint: named.length === 1 ? `Revoke it first: vb grants revoke ${named[0]}` : 'Revoke them first, each with vb grants revoke <id>.',
        })
      }
      const before = await reaching()
      if (before.length > 0) throw granted(before)
      // Only what the lock would close is asked for, a channel each: the path itself, which lists first of the names
      // that start with it, and the first channel under it. Its siblings (`vault-old` beside `vault`) are never read.
      // A board from before pages answers every channel to either, and is searched the same.
      const first = async (prefix: string) =>
        (await call<{ channels: ChannelView[] }>('GET', `/channels${queryString({ prefix, limit: 1 })}`)).channels.find((channel) => channel.path === path || channel.path.startsWith(pattern))
      const there = (await first(path)) ?? (await first(pattern))
      if (there)
        throw new BoardError(
          'channel_exists',
          there.path === path ? `${path} is a channel already, so it stays as it is.` : `${there.path} is a channel already, and a private ${path} would close it too, so nothing was made.`,
          409,
          { hint: `Close it with a grant: everyone at ${pattern} with 'none'.` },
        )
      const own = await call<{ grant: GrantView }>('POST', '/grants', { body: { principals: [creator], can: { [pattern]: 'all' } } })
      // Taking back a grant it made, when the channel isn't to be its own after all. Where someone
      // else's lock has landed, that's its last manage there, a lockout: it means it, and says so.
      const takeBack = (id: string) => {
        const revoke = (body: { lockMeOut?: true }) => call<{ revoked: boolean }>('POST', `/grants/${encodeURIComponent(id)}/revoke`, { body })
        return revoke({}).catch((error: unknown) => {
          if (error instanceof BoardError && error.code === 'grant_lockout') return revoke({ lockMeOut: true })
          throw error
        })
      }
      // What reaches the path besides its own grants as it made them: one someone changed (adding
      // themselves to it, or opening the lock) lets them in as much as a grant of their own would.
      const others = (grants: GrantView[], mine: GrantView[]) =>
        grants.filter((grant) => {
          const made = mine.find((ours) => ours.id === grant.id)
          return made === undefined || JSON.stringify([grant.principals, grant.can]) !== JSON.stringify([made.principals, made.can])
        })
      // Someone making it at the same time: whoever finds the other's grant takes its own back, so at
      // most one of them keeps a way in, and if each finds the other, neither does.
      const raced = others(await reaching(), [own.grant])
      if (raced.length > 0) {
        await takeBack(own.grant.id)
        throw granted(raced, [own.grant])
      }
      const closed = await call<{ grant: GrantView }>('POST', '/grants', { body: { principals: [{ kind: 'everyone' }], can: { [pattern]: [] } } })
      // Once the lock is there, no one it shuts out can grant themselves past it, so this listing is
      // the last word: a grant made or changed before the lock landed would still let someone in, so
      // it isn't private, and both of its grants go, the lock first.
      const late = others(await reaching(), [own.grant, closed.grant])
      if (late.length > 0) {
        for (const id of [closed.grant.id, own.grant.id]) await takeBack(id)
        throw granted(late, [own.grant, closed.grant])
      }
      const made = await call<{ channel: ChannelView; created: boolean }>('POST', '/channels', { body: { path } })
      return { ...made, grants: [own.grant, closed.grant] }
    },
    /**
     * The board's actors, or with `id`, only the ones it names, in a request a hundred: someone the board doesn't
     * have, or you may not see, is left out. A board from before `id` answers everyone.
     */
    actors: async (query: { id?: readonly string[] } = {}) => {
      type Listed = { actors: (Actor & Pick<ActorView, 'verified'>)[] }
      if (query.id === undefined) return (await call<Listed>('GET', '/actors')).actors
      const ids = [...new Set(query.id)]
      const batches = Array.from({ length: Math.ceil(ids.length / ACTORS_BY_ID_MAX) }, (_, n) => ids.slice(n * ACTORS_BY_ID_MAX, (n + 1) * ACTORS_BY_ID_MAX))
      const named = (batch: string[]) => call<Listed>('GET', `/actors?${new URLSearchParams(batch.map((id) => ['id', id]))}`).then((page) => page.actors)
      // The first answer says whether the board narrows by ID: one that named someone it wasn't asked for answers
      // everyone, so it's the whole answer, and the rest aren't asked for.
      const first = batches.length > 0 ? await named(batches[0]!) : []
      const asked = new Set(batches[0])
      const narrows = first.every((actor) => asked.has(actor.id))
      const found = narrows ? [...first, ...(await Promise.all(batches.slice(1).map(named))).flat()] : first
      const wanted = new Set(ids)
      const seen = new Set<string>()
      return found.filter((actor) => wanted.has(actor.id) && !seen.has(actor.id) && Boolean(seen.add(actor.id)))
    },

    /**
     * One channel, by its whole name: a board lists messages a channel at a time, never across channels. Its
     * `messages()` are the channel's across its threads, oldest first: the newest `limit` (50 without one), or with
     * `after`, a cursor a read of this channel answered, the ones posted since.
     */
    channel: (name: string) => ({
      messages: (query: Omit<ChannelMessagesQueryInput, 'channel'> = {}) =>
        call<MessagesPage>('GET', `/messages${queryString({ channel: name, ...query })}`),
    }),
    /**
     * A thread: its root and its replies. `after`, one of its messages, answers the replies after it, and `limit` that
     * many of them: with `after` the first after it, to read on from, and without, the newest.
     */
    thread: (id: string, range: ThreadQueryInput = {}) => call<ThreadView>('GET', `/messages/${path(id)}${queryString(range)}`),
    /** Your own post with the client ID you gave it, as posting it answered: 404 `post_not_found` when there's none. */
    posted: async (id: string) => (await call<{ message: MessageView }>('GET', `/posts/${path(id)}`)).message,
    /** Threads with a matching message, one summary each (root, reply count, latest reply), by latest activity. `limit` counts threads; `before` takes a page's `older`. */
    threads: (query: Filters & Omit<ThreadsQueryInput, keyof FiltersInput> = {}) =>
      call<ThreadsPage>('GET', `/threads${queryString(query)}`),

    /**
     * Starts a thread. An `@handle` in the text that names exactly one actor you can see is stored as
     * `@[actor-id]`, a mention of them; one that names none or several stays as typed, a mention of
     * no one. `mentions` on what comes back says what became of each, when the text typed any.
     */
    async post(channel: string, input: string | PostOptions): Promise<Written<MessageView>> {
      const { message, mentions } = await call<{ message: MessageView; mentions?: Mentioned[] }>('POST', '/messages', { body: { channel, ...messageBody(input) } })
      return mentions ? { ...message, mentions } : message
    },
    /** Replies in a thread. Its `@handle`s are settled as `post`'s are: of several who share one, it's the one who wrote in the thread. */
    async reply(id: string, input: string | ReplyOptions): Promise<Written<MessageView>> {
      const { message, mentions } = await call<{ message: MessageView; mentions?: Mentioned[] }>('POST', '/messages', { body: { re: id, ...messageBody(input) } })
      return mentions ? { ...message, mentions } : message
    },
    /**
     * Posts later, as you: a new thread when `target` is a channel, a reply when it's
     * `{ re }`, any message's ID in the thread. Each message it posts carries
     * `schedule: { id, n }`. Needs a board with a scheduler.
     */
    async schedule(target: string | { re: string }, input: ScheduleOptions): Promise<Written<ScheduleView>> {
      const where = typeof target === 'string' ? { channel: target } : { re: target.re }
      const { schedule, mentions } = await call<{ schedule: ScheduleView; mentions?: Mentioned[] }>('POST', '/schedules', { body: { ...where, ...scheduleBody(input) } })
      return mentions ? { ...schedule, mentions } : schedule
    },
    /** Pending schedules (`all` for done and canceled too), oldest first. `re` is any message in a thread. */
    schedules: async (query: Omit<SchedulesQueryInput, 'all'> & { all?: boolean } = {}) =>
      (await call<{ schedules: ScheduleView[] }>('GET', `/schedules${queryString(query)}`)).schedules,
    /** Stops a schedule: yours, or any with manage in its channel. `canceled` is false when it was already done or canceled. */
    cancelSchedule: (id: string) =>
      call<{ schedule: ScheduleView; canceled: boolean }>('POST', `/schedules/${path(id)}/cancel`, { body: {} }),
    /** The fork's agent registry, command intents, and task health. Boards that don't opt in answer 501 `no_agent_ops`. */
    agents: {
      list: (channel: string) => call<{ agents: AgentView[] }>('GET', `/ops/agents${queryString({ channel })}`),
      register: (input: RegisterOpsAgentInput) => call<AgentView>('POST', '/ops/agents', { body: input }),
      heartbeat: (id: string, generation: number) => call<AgentView>('POST', `/ops/agents/${path(id)}/heartbeat`, { body: { generation } }),
      retire: (id: string, generation: number) => call<AgentView>('POST', `/ops/agents/${path(id)}/retire`, { body: { generation } }),
      issueIntent: (agent: string, input: IssueOpsIntentInput) => call<OpsIntentsIssued>('POST', `/ops/agents/${path(agent)}/intents`, { body: input }),
      issueRoleIntent: (input: IssueOpsRoleIntentInput) => call<OpsIntentsIssued>('POST', '/ops/intents', { body: input }),
      /** The agent's pending intents, oldest first. Pass the returned `next` as `after` to read on. */
      intents: (agent: string, query: ListOpsIntentsInput = {}) => call<OpsIntentsPage>('GET', `/ops/agents/${path(agent)}/intents${queryString(query)}`),
      takeIntent: (id: string, generation: number) => call<AgentIntent>('POST', `/ops/intents/${path(id)}/take`, { body: { generation } }),
      reportIntent: (id: string, generation: number, outcome: IntentOutcome) => call<AgentIntent>('POST', `/ops/intents/${path(id)}/report`, { body: { generation, outcome } }),
      /** Whether a fresh run probe reported that this task's current claim is working. */
      health: (task: string) => call<AgentHealth>('GET', `/ops/health/${path(task)}`),
    },
    /**
     * Tasks: threads someone's agents are to do, with a state the board keeps. A task's ID is its
     * root's, and its root's `task` says its state, whose it is, what it waits for, and who holds
     * it. A board that keeps no tasks answers 501 `no_tasks`, or `no_task_attention` for structured requests.
     */
    tasks: {
      /**
       * Tasks, oldest first, each as its thread's summary: open ones (`waiting`, `ready`, `claimed`,
       * `blocked`) unless `state` says `all` or names one. `owner` and `for` take a handle or an ID,
       * `needs` a task's ID, for the tasks that wait for it. `cursor`, as `after`, reads the next page.
       * `latest` answers the `limit` last active instead, the latest active last: the board reads every
       * task to find them, and builds only those.
       */
      list: (query: Omit<TasksQueryInput, 'label' | 'latest'> & { label?: Record<string, string> | string[]; latest?: boolean } = {}) => call<TasksPage>('GET', `/tasks${queryString(query)}`),
      create: createTask,
      createMany: createTasks,
      claim: claimTask,
      /** What a claim you hold does, from the `epoch` and `token` it answered: for a process that kept them, as `vb` does between commands. */
      held,
      /** Holds a task no one has claimed for a person: yours, or any with manage in its channel. A claimed one's hold is its claim's (`claim.block`). */
      block: (id: string, reason: string, opts: { kind?: string } = {}) => taskWrite(id, 'block', { reason, ...opts }, 'epoch' in opts || 'token' in opts),
      /** Holds a task for a decision on the given snapshot. A claimed task needs its live claim proof. */
      ask: (id: string, request: RequestAttentionBody) =>
        call<Protocol['requestTaskAttention']['output']>('POST', `/tasks/${path(id)}/attention`, { body: request, claim: request.claim !== undefined }),
      /** Reads the current request, if any. */
      attention: (id: string) => call<Protocol['taskAttention']['output']>('GET', `/tasks/${path(id)}/attention`),
      /** Records a responder's choice and routes the task together. */
      answer: (id: string, requestId: string, answer: AttentionAnswerBody) =>
        call<Protocol['answerTaskAttention']['output']>('POST', `/tasks/${path(id)}/attention/${path(requestId)}/answer`, { body: answer }),
      /** Lifts a plain hold: the task is ready again, or waiting while a task it needs hasn't completed. */
      unblock: (id: string) => taskWrite(id, 'unblock'),
      /** A verified person with manage parks the task, ending any claim. */
      park: (id: string, reason: string) => taskWrite(id, 'park', { reason }),
      /** Lifts an operator park without restoring its former claim. */
      unpark: (id: string, reason: string) => taskWrite(id, 'unpark', { reason }),
      /** Records packet metadata using explicit claim proof. */
      handoff: (id: string, input: TaskHandoffWrite) => taskWrite(id, 'handoff', input, true),
      /** Makes a failed task ready again, in place: what waits for it still does. */
      reopen: (id: string) => taskWrite(id, 'reopen'),
      /** Assigns a task to one of its owner's actors (`<owner>+<profile>`), the only one that claims it then, or with null to anyone who may. */
      assign: (id: string, actor: string | null) => taskWrite(id, 'assign', { for: actor }),
      /**
       * Replaces what a task waits for, by their IDs: it waits for those now, and is ready once they've all completed, or
       * at once with none. For its owner, while no one holds it and it isn't finished. One that would make it wait for
       * itself, through however many tasks, throws a 400 `invalid_needs`.
       */
      needs: (id: string, needs: string[]) => taskWrite(id, 'needs', { needs }),
      /** Sets priority as the task's owner or with manage. Use the live claim if you hold it. */
      priority: (id: string, priority: TaskPriority) => taskWrite(id, 'priority', { priority }),
      /** Cancels a task that hasn't completed, ending any claim. What waits for it keeps waiting. */
      cancel: (id: string, reason: string) => taskWrite(id, 'cancel', { reason }),
    },
    /**
     * A new grant: `principals` may do what `can` says, a map from channel pattern to permissions
     * (`[]` for none). The same principals again are another grant. At each channel, the most
     * specific pattern among the grants that name a caller decides, then the closest principal,
     * and grants tied there add up. Needs manage at each pattern `can` names.
     *
     * One you couldn't take back, since it takes your own manage at a pattern it names (closing
     * `security/` to `everyone` closes it to you), is 409 `grant_lockout`: keep yourself in with
     * `createGrants`, or pass `lockMeOut` to make it anyway. Every grant write takes it.
     */
    createGrant: (input: GrantInput, options: GrantWriteOptions = {}) => call<{ grant: GrantView }>('POST', '/grants', { body: { ...wireGrant(input), ...goAhead(options) } }),
    /**
     * Several grants in one write, all of them or none, judged together: each needs what
     * `createGrant` does on the grants as they are, and what they leave you with is judged with
     * all of them made. So a lock and the grant that keeps you in go together, in any order.
     */
    createGrants: (inputs: readonly GrantInput[], options: GrantWriteOptions = {}) => call<{ grants: GrantView[] }>('POST', '/grants/batch', { body: { grants: inputs.map(wireGrant), ...goAhead(options) } }),
    /** Adds and removes principals (by who they are, environments aside), or replaces its `can`. Needs what `checkGrantChange` says, for the grant as it was and as it'd be. */
    updateGrant: (id: string, { add, remove, can }: UpdateGrantInput, options: GrantWriteOptions = {}) =>
      call<{ grant: GrantView }>('PATCH', `/grants/${path(id)}`, {
        body: { ...(add ? { add: add.map(withEnvironments) } : {}), ...(remove ? { remove } : {}), ...(can ? { can: wireCan(can) } : {}), ...goAhead(options) },
      }),
    /**
     * Which grants decide `channel`, and what they give: for you, or with manage at `*`, for the
     * principal `principal` names (`{ user }`, `{ project, environment }`, `{ github, workflow,
     * branch, event }`, or `{ oidc, claims }`).
     */
    explain: (channel: string, principal: ExplainPrincipal = {}) => {
      const { claims, ...rest } = principal
      const params = new URLSearchParams({ channel })
      for (const [name, value] of Object.entries(rest)) if (value !== undefined) params.set(name, value)
      for (const [name, value] of Object.entries(claims ?? {})) params.append('claim', `${name}=${value}`)
      return call<Explanation>('GET', `/grants/explain?${params}`)
    },
    /** The board's grants. Needs manage at `*`, or a team owner. */
    grants: async () => (await call<{ grants: GrantView[] }>('GET', '/grants')).grants,
    /** Creates a single-use invite. Deliver `secret` privately; it never comes back in a list. */
    createInvite: ({ can, ...input }: CreateInviteInput) => call<CreatedInvite>('POST', '/invites', { body: { ...input, ...(can !== undefined ? { can: wireCan(can) } : {}) } }),
    invites: async () => (await call<{ invites: InviteView[] }>('GET', '/invites')).invites,
    revokeInvite: (id: string) => call<{ revoked: boolean }>('POST', `/invites/${path(id)}/revoke`),
    /** Redeems an invite on this board. Keep the returned bearer token private. */
    join: (secret: string) => call<Joined>('POST', '/invites/redeem', { body: { secret }, auth: false, redirect: 'error' }),
    /** `revoked` is false when it was already gone. Its principals' next requests are refused. */
    revokeGrant: (id: string, options: GrantWriteOptions = {}) => call<{ revoked: boolean }>('POST', `/grants/${path(id)}/revoke`, { body: goAhead(options) }),
    /** Every schema: the built-ins, then the board's own, by name and version. */
    schemas: async () => (await call<{ schemas: SchemaView[] }>('GET', '/schemas')).schemas,
    /** One schema version, by its ID: `sandbox@1`. */
    schema: async (id: string) => (await call<{ schema: SchemaView }>('GET', `/schemas/${path(id)}`)).schema,
    /**
     * Registers a schema version, for good: `schema` is a JSON Schema for an object, in structural
     * keywords only. Needs manage at `*`. `created` is false for one that's there with the same
     * definition; another definition is refused, since a version never changes.
     */
    createSchema: (input: SchemaInput) => call<{ schema: SchemaView; created: boolean }>('POST', '/schemas', { body: input }),
    /**
     * Stores a file on the board, for a post or reply's `attachments`. Up to 4 MB goes in one
     * request; bigger, up to 100 MB, goes straight to the board's blob store on a URL the board
     * signs, where its store can (`no_direct_uploads` where it can't).
     */
    async upload(input: UploadInput): Promise<Attachment> {
      const type = input.type || (input.data instanceof Blob ? input.data.type : '') || typeOf(input.name)
      const size = input.data instanceof Blob ? input.data.size : input.data.byteLength
      if (size > ATTACHMENT_BYTES_MAX) {
        if (size > DIRECT_UPLOAD_BYTES_MAX) throw new BoardError('too_large', `Attachments are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB.`, 413)
        const bytes = input.data instanceof Blob ? await input.data.arrayBuffer() : input.data
        const sha256 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))
        const ticket = await call<{ id: string; url: string; headers: Record<string, string> }>('POST', '/attachments/uploads', { body: { name: input.name, type, size, sha256 } }).catch((error: unknown) => {
          // A board from before direct uploads has no such route.
          if (error instanceof BoardError && error.status === 404 && error.code === 'not_found')
            throw new BoardError('too_large', `This board takes files of at most ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB.`, 413)
          throw error
        })
        // The store's URL carries its own signature: the board's token stays with the board.
        const put = await storeFetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: input.data })
        if (!put.ok) throw new BoardError('upload_failed', `The blob store refused the file: ${put.status} ${(await put.text().catch(() => '')).slice(0, 300) || put.statusText}`, put.status)
        return (await call<{ attachment: Attachment }>('POST', `/attachments/uploads/${encodeURIComponent(ticket.id)}`, { body: {} })).attachment
      }
      const response = await doFetch(`${base}/attachments`, {
        method: 'POST',
        headers: { ...(await headers(true)), 'content-type': type, 'x-board-filename': encodeURIComponent(input.name) },
        body: input.data,
      })
      if (!response.ok) throw await toError(response)
      return ((await response.json()) as { attachment: Attachment }).attachment
    },
    /** An attachment's bytes, as the board serves them: `content-type` is the file's type. */
    download: (id: string, opts: { signal?: AbortSignal } = {}) =>
      raw('GET', `/attachments/${encodeURIComponent(id)}`, opts.signal ? { signal: opts.signal } : {}),
    /**
     * `revision` is the message's as you read it: if it's been edited or deleted since, nothing
     * changes, and it throws a 409 `revision_conflict`.
     */
    edit: (id: string, text: string, opts: { revision?: number } = {}) =>
      call<{ ok: true; mentions?: Mentioned[] }>('POST', `/messages/${path(id)}/edit`, { body: { text, ...opts } }),
    delete: (id: string, opts: { revision?: number } = {}) => call<{ ok: true }>('POST', `/messages/${path(id)}/delete`, { body: { ...opts } }),
    /** `emoji` is a short name, `:name:`, or the character itself. */
    react: (id: string, emoji: string, opts: { remove?: boolean } = {}) =>
      call<{ ok: true }>('POST', `/messages/${path(id)}/reactions`, {
        body: { emoji: normalizeEmoji(emoji), ...opts },
      }),
    /**
     * `if` is what the labels must be now, a value or null for one that mustn't be set: if one
     * isn't, nothing changes, and it throws a 409 `label_conflict`.
     */
    label: (id: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }) =>
      call<{ ok: true }>('POST', `/messages/${path(id)}/labels`, { body: change }),
    /**
     * Shows typing in the platform threads the message's thread is synced to.
     * Ephemeral: nothing goes in the log. Answers the external threads that took it.
     * `status` replaces "Typing…" on Slack ("running tests…").
     */
    typing: async (id: string, status?: string) =>
      (await call<TypingResult>('POST', `/messages/${path(id)}/typing`, { body: status ? { status } : {} })).targets,
    /**
     * With a target, attaches the message's thread to it, backfilling it: attaching twice is a no-op.
     * Without one, where the thread is synced, and this message's copy on each target, with its link.
     */
    sync: ((id: string, target?: string) =>
      target === undefined
        ? call<SyncedView>('GET', `/messages/${path(id)}/sync`)
        : call<{ target: string; attached: boolean }>('POST', `/messages/${path(id)}/sync`, { body: { target } })) as {
      (id: string): Promise<SyncedView>
      (id: string, target: string): Promise<{ target: string; attached: boolean }>
    },
    /**
     * The thread of the board message a platform link names (a Slack permalink, a GitHub comment's
     * URL), from what the board synced: the platform is never asked. 404 for one it didn't sync.
     */
    linked: (url: string) => call<ThreadView>('GET', `/links${queryString({ url })}`),
    /** Raw platform events for a sync entry, newest first. */
    inbox: async (key: string, opts: { channel?: string; limit?: number } = {}) =>
      (await call<{ events: InboxEntry[] }>('GET', `/inbox/${key}${queryString(opts)}`)).events,
    /** Private operational messages, separate from the raw sync inbox. */
    operationalInbox: {
      send: (input: SendOperationalMessageInput) =>
        call<{ message: OperationalMessage }>('POST', '/operational-inbox', { body: input }),
      read: () => call<{ messages: OperationalMessage[] }>('GET', '/operational-inbox'),
      ack: (id: string, status: OperationalStatus) =>
        call<{ message: OperationalMessage }>('POST', `/operational-inbox/${path(id)}/ack`, { body: { status } }),
      archive: (id: string) =>
        call<{ message: OperationalMessage }>('POST', `/operational-inbox/${path(id)}/archive`),
    },
    /** Registers the caller's watchers, replacing its last registration: what a board on `http()` does. */
    register: (input: RegisterInput) =>
      call<RegistrationView>('POST', '/watchers', { body: input }),
    /** Registered watchers: every one to `manage` everywhere, the caller's own to anyone else. */
    watchers: async () => (await call<{ watchers: RegistrationView[] }>('GET', '/watchers')).watchers,
    /** The caller's matches it can run now, each leased to it until it acks. `wait` holds the request up to that many seconds for one. */
    matches: async (opts: { limit?: number; wait?: number; signal?: AbortSignal } = {}) => {
      const { signal, ...query } = opts
      return (await call<{ matches: MatchView[] }>('GET', `/watchers/matches${queryString(query)}`, signal ? { signal } : {})).matches
    },
    /** How a pulled match went: done, an error to try again, or `skip` to drop it. */
    ack: (id: string, body: { lease: string; error?: string; skip?: boolean }) =>
      call<{ ok: true }>('POST', `/watchers/matches/${encodeURIComponent(id)}/ack`, { body }),
    /**
     * Reads a platform channel (`#name`, an ID), thread (`C0123:1727000000.123456`),
     * or message permalink on demand, without syncing or storing it. Full access only.
     */
    readSource: (key: string, target: string, opts: { limit?: number; after?: string } = {}) =>
      call<SourceRead>('GET', `/sources/${key}/read${queryString({ target, ...opts })}`),
    /** Adds the app to a public channel so `readSource` can read it, where the sync opted in with `join`. Full access only. */
    joinSource: (key: string, target: string) =>
      call<SourceJoin>('POST', `/sources/${key}/join`, { body: { target } }),

    poll,

    // Sync's records: what a sync running elsewhere reads and writes here. Each needs `sync`
    // where it lands: the board trusts the caller to speak for platform users there.

    /** A platform's write, as its platform author: idempotent per platform event for a post, found from its origin otherwise. */
    syncImport: (body: SyncImportInput) => call<{ message: string | null; dropped?: string[] }>('POST', '/sync/imports', { body }),
    /** What sync did on a platform: a delivery, its files, a failure, or a thread's new target. */
    syncReceipt: (body: SyncReceiptInput) => call<{ ok: true; attached?: boolean }>('POST', '/sync/receipts', { body }),
    /** A board thread's sync, by its key. */
    syncThread: (thread: string) => call<SyncThreadView>('GET', `/sync/threads/${path(thread)}`),
    /** What platform IDs are on the board: a thread, or a message. */
    syncFind: (query: SyncFindInput, opts: { signal?: AbortSignal } = {}) =>
      call<SyncFindView>('GET', `/sync/find${queryString(query)}`, opts.signal ? { signal: opts.signal } : {}),
    /** Messages' copies on platforms, by message and target. */
    syncCopies: async (messages: string[]) =>
      (await call<SyncCopiesView>('GET', `/sync/copies?${messages.map((id) => `message=${encodeURIComponent(id)}`).join('&')}`)).copies,
    /** Pushes platform events into your inbox for sync key `key`; each platform ID lands once. */
    inboxPush: (key: string, events: { id: string; event: InboxItem['event']; raw: unknown }[]) =>
      call<{ ok: true }>('POST', `/inbox/${path(key)}`, { body: { events } }),
    /** Your next inbox events for `key`, leased to you until you ack them, one platform thread at a time. */
    inboxNext: async (key: string, opts: { limit?: number } = {}) =>
      (await call<{ items: InboxItem[] }>('GET', `/inbox/${path(key)}/next${queryString(opts)}`)).items,
    /** How an inbox event went: done, or an error to try it again. */
    inboxAck: (key: string, id: string, body: { lease: string; error?: string }) =>
      call<{ ok: true }>('POST', `/inbox/${path(key)}/${path(id)}/ack`, { body }),

    /** Live events. Reconnects from the last seen index whenever the stream closes, and tells `onState` whether it's live or retrying. */
    async *events(
      query: Filters & { after?: string; all?: boolean; last?: number } = {},
      opts: EventsOptions = {},
    ): AsyncGenerator<BoardEventView> {
      // The feed's newest events (`last`) come first, once: a stream that reconnects goes on from where it was.
      const { last, ...rest } = query
      let after = query.after
      let failures = 0
      const state = eventsState(opts.onState)
      while (!opts.signal?.aborted) {
        let response: Response
        try {
          response = await raw('GET', `/events${queryString({ ...filtersQuery(rest), ...(after === undefined && last !== undefined ? { last } : {}), after })}`, {
            headers: { accept: 'text/event-stream' },
            ...(opts.signal ? { signal: opts.signal } : {}),
          })
        } catch (error) {
          if (opts.signal?.aborted) return
          // A refusal isn't an outage: what the board doesn't do (501) is said, as what the caller got wrong is, and not retried.
      if (error instanceof BoardError && (error.status === 501 || (error.status >= 400 && error.status < 500))) throw error
          state.failed()
          await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** failures++)))
          continue
        }
        failures = 0
        state.answered()
        try {
          for await (const message of parseSse(response.body!, opts.signal)) {
            if (message.id !== undefined) after = message.id
            if (message.event === 'board' && message.data) yield JSON.parse(message.data) as BoardEventView
          }
        } catch (error) {
          if (opts.signal?.aborted) return
          state.failed()
          await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** failures++)))
        }
      }
    },

    /** The next matching event after `after` (default: now), or null on timeout. */
    async wait(
      query: Filters & { after?: string } = {},
      opts: WaitOptions = {},
    ): Promise<BoardEventView | null> {
      const deadline = Date.now() + duration(opts.timeout ?? '30m')
      let after = query.after ?? (await poll({ ...query, after: undefined, wait: 0 }, opts.signal)).cursor
      while (Date.now() < deadline && !opts.signal?.aborted) {
        const wait = Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)))
        const page = await poll({ ...query, after, wait }, opts.signal)
        if (page.events.length > 0) return page.events[0]!
        after = page.cursor
      }
      return null
    },
  }
}

export type { ActorView, BoardEventView, ChannelView, Discovery, EventsPage, Me, MessagesPage, MessageView, ScheduleView, ThreadsPage, ThreadSummaryView, ThreadView }

/**
 * `doFetch` for a request the caller flagged as carrying a claim's token: it goes to the board's
 * own URL and nowhere else. It follows no redirect (a 307 or 308 would send the body, token and
 * all, to wherever the board's answer points), and one is refused as the handle's own error. The
 * flag is the caller's: nothing here reads a request's headers or body to guess.
 */
function claimFetch(doFetch: typeof fetch, url: string): typeof fetch {
  return async (input, init) => {
    const response = await doFetch(input, { ...init, redirect: 'manual' })
    // A browser's manual redirect is opaque (status 0); 304 sends nowhere.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
      await response.body?.cancel().catch(() => {})
      throw new BoardError('redirect_refused', `The board at ${url} answered a claim's request with a redirect, and a claim's token goes nowhere else.`, response.status, {
        hint: "Use the board's own URL.",
      })
    }
    return response
  }
}

async function toError(response: Response): Promise<BoardError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; hint?: unknown } }
    // Retry-After in seconds, as a 429 says it: its date form isn't one a board sends.
    const retryAfter = response.status === 429 ? /^\d{1,6}$/.exec(response.headers.get('retry-after') ?? '')?.[0] : undefined
    if (body.error?.message)
      return new BoardError(body.error.code ?? 'error', body.error.message, response.status, {
        ...(typeof body.error.hint === 'string' ? { hint: body.error.hint } : {}),
        origin: handleErrors.has(response) ? 'handle' : 'board',
        ...(retryAfter !== undefined ? { retryAfter: Number(retryAfter) } : {}),
      })
  } catch {}
  return new BoardError('http_error', `The board answered ${`${response.status} ${response.statusText}`.trim()}.`, response.status)
}
