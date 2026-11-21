import { useSyncExternalStore } from 'react'
import type { AttentionView, BoardEventView, Explanation, GrantInput, GrantWriteOptions, InboxEntry, Me, MessageView, SchemaInput, SyncedView, TaskView } from '../../api/routes.ts'
// `@vercel/board/access`, in an app of yours.
import { compileAccess } from '../../server/access.ts'
import { board, BoardError, type Attachment, type EventsState, type ExplainPrincipal, type PostOptions, type ScheduleTiming } from '../../server/index.default.ts'
// The one import an app of yours can't make, and doesn't need. There, this file starts with
// `const team = board()` in server code (a route handler, a server action), which finds the team's
// board and your credentials itself. This page's server is the CLI on your machine, which keeps
// your credentials behind a proxy at /board, and `http()` is how a handle in the page reaches it.
// Everything under that line reads as it would in your app: plain `team.*` calls.
import { http } from '../../backend-http/index.default.ts'
import { everyChannel } from '../../client/channels.ts'
import { toast } from './chrome.ts'
import { listing } from './listing.ts'
import { base } from './nav.tsx'
import * as store from './store.ts'
import { RECENT_COMPLETED, swarmRoots, swarmState, type SwarmScope } from './swarm.ts'
import { refusal, said } from './words.ts'

// The page's data: one handle on the board, and every read and write the page makes through it.

const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? ''

/**
 * Served from an app (`@vercel/board/inspect`), the page acts as the app's handle, which isn't
 * whoever's visiting, so it writes only as a profile you name: never as yourself.
 */
export const named = meta('inspect-named') === '1'

/** A profile you post as: its name, and the avatar you gave it (an https URL), if any. */
export type Profile = { name: string; avatar?: string }

/** You, as no profile. Its `fetch` sends the page's credential for the proxy: a token only this run's page has. */
const yourself = board({
  backend: http(`${location.origin}${base}/board`, {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-inspect-token', meta('inspect-token'))
      return fetch(input, { ...init, headers })
    },
  }),
})

// --- who you post as: `team.as(profile)` ------------------------------------------------

const PROFILE_KEY = 'board.profile'
const AVATARS_KEY = 'board.avatars'

const stored = <T>(key: string): T | undefined => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? undefined : (JSON.parse(value) as T)
  } catch {
    return undefined
  }
}

/** The profile `vb inspect` started as (`--as claude`), which the page is told beside its token. */
const started: Profile | null = (() => {
  try {
    return JSON.parse(meta('inspect-profile') || 'null') as Profile | null
  } catch {
    return null
  }
})()

/** `undefined`: as inspect started. `null`: yourself. Else that profile (stored by its name alone, before avatars). */
let profile: Profile | null | undefined = (() => {
  const value = stored<string | Profile | null>(PROFILE_KEY)
  return typeof value === 'string' ? { name: value } : value
})()

/** The avatar you last gave each profile, so picking it again brings it back. */
const avatars: Record<string, string> = stored<Record<string, string>>(AVATARS_KEY) ?? {}

export const getProfile = () => profile

/**
 * Whether the page waits for a profile before it reads anything: served from an app, with none picked
 * yet. The handle's own profile doesn't count there: it's the app's name, not the visitor's.
 */
export const needsName = () => named && (profile === undefined || profile === null)
export const avatarOf = (name: string): string | undefined => avatars[name]

const handleFor = (choice: Profile | null | undefined) => {
  const as = choice === undefined && !named ? started : (choice ?? null)
  return as === null ? yourself : yourself.as(as)
}

/** The handle every call below goes through: you, or you as the profile you picked. */
let team = handleFor(profile)
let profileVersion = 0
let profileSelection = 0

/** Learns who you post as, and switches only when the board takes the current selection. */
export async function setProfile(next: Profile | null | undefined): Promise<boolean> {
  const handle = handleFor(next)
  const selection = ++profileSelection
  const accept = onArrival('access', () => selection === profileSelection)
  try {
    const me = await handle.me()
    if (!accept((s) => {
      team = handle
      profile = next
      // Reselecting the same actor does not invalidate that actor's in-flight reads.
      if (s.me?.actor === me.actor) return store.noteSwarmRead({ ...s, me }, 'access', null)
      profileVersion++
      const answers = Object.fromEntries(Object.entries(s.swarm.answers).filter(([, answer]) => answer.is === 'sending'))
      return { ...s, me, swarm: { ...s.swarm, reads: { access: null }, attention: {}, answers } }
    })) return false
  } catch (error) {
    if (selection === profileSelection) toast(`couldn't switch: ${said(error)}`)
    return false
  }
  if (next) {
    if (next.avatar) avatars[next.name] = next.avatar
    else delete avatars[next.name]
  }
  try {
    if (next === undefined) localStorage.removeItem(PROFILE_KEY)
    else localStorage.setItem(PROFILE_KEY, JSON.stringify(next))
    localStorage.setItem(AVATARS_KEY, JSON.stringify(avatars))
  } catch {}
  return true
}

/** What you may do where: `me.can` is each channel pattern's permissions, and `compileAccess` answers for a channel. */
export function viewerOf(me: Me): store.Viewer {
  const access = compileAccess(me.can)
  return { actor: me.actor, principal: me.principal, profile: me.profile, may: (permission, channel) => access.can(permission, channel), manages: access.at('manage', '*') }
}

// --- the page's state: what the board said, folded by store.ts --------------------------------

let state = store.initialState
const listeners = new Set<() => void>()

function set(next: (state: store.State) => store.State) {
  const updated = next(state)
  if (updated === state) return
  state = updated
  for (const listener of listeners) listener()
}

export function useBoard(): store.State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

export const getState = () => state

let nextRead = 0
const appliedReads = new Map<string, number>()

/** Each source settles independently. Only a newer settled read can supersede one on its way. */
function onArrival(key: string, active = () => true) {
  const id = ++nextRead
  const profile = profileVersion
  return (update: (s: store.State) => store.State): boolean => {
    if (profile !== profileVersion || !active() || id < (appliedReads.get(key) ?? 0)) return false
    appliedReads.set(key, id)
    set(update)
    return true
  }
}

const loaded = new Map<string, Promise<store.ReadFailure | null>>()

const readFailure = (error: unknown): store.ReadFailure =>
  error instanceof BoardError ? { why: error.message, code: error.code, status: error.status } : { why: said(error) }

/** Loads once per key; a failure can be retried. */
function once(key: string, load: () => Promise<void>, notify = true): Promise<store.ReadFailure | null> {
  let promise = loaded.get(key)
  if (!promise) {
    promise = load().then(() => null, (error: unknown) => {
      loaded.delete(key)
      const failed = readFailure(error)
      if (notify) toast(failed.why)
      return failed
    })
    loaded.set(key, promise)
  }
  return promise
}

// --- reading -----------------------------------------------------------------------

/** How many of the feed's newest events fill the activity view: the most one read of them answers. */
const RECENT = 100
// An open stream keeps the access it opened with, even if the next /me grants more.
let feedReadAll = true

/**
 * The page shows once it knows who you are and the channels. The feed's newest events across them fill the
 * activity view, in one read, and the feed goes on from that read's cursor. A board that can't read them
 * across channels says so: its words show there, and the feed starts from now.
 */
export async function boot() {
  // Settled either way: a refusal is what the view shows, not a failed boot.
  const recent = team.poll({ all: true, last: RECENT }).then(
    (page) => ({ page }),
    (error: unknown) => ({ refused: refusal(error) }),
  )
  // Every channel, a page at a time: the sidebar lists them all.
  const accept = onArrival('access')
  const [me, discovery, channels] = await Promise.all([team.me(), team.discovery().catch(() => null), everyChannel(team)])
  accept((s) => store.noteSwarmRead({ ...s, me }, 'access', null))
  set((s) => ({ ...s, discovery, channels: Object.fromEntries(channels.map((c) => [c.path, c])) }))
  const latest = await recent
  // Folded as live events are, oldest first, so an edit or a delete among them leaves its message as it is now.
  if ('page' in latest) {
    listed.apply(latest.page.events)
    set((s) => ({ ...s, cursor: latest.page.cursor }))
  } else set((s) => ({ ...s, activityRefused: latest.refused }))
  // A burst of events is one render: they're folded in a frame at a time.
  let queue: BoardEventView[] = []
  const flush = () => {
    const events = queue
    queue = []
    void applyLiveEvents(events)
    // A schedule's own state isn't in the feed, but its sends are: one that landed means the list moved.
    if (events.some((event) => event.message?.schedule !== undefined)) void loadSchedules()
  }
  feedReadAll = store.readAccess(state).readsAll
  follow(
    'page' in latest ? latest.page.cursor : undefined,
    (event) => {
      if (queue.push(event) === 1) requestAnimationFrame(flush)
    },
    (feed) => set((s) => ({ ...s, live: feed === 'live' ? 'live' : 'reconnecting' })),
  ).catch((error) => {
    const failed = readFailure(error)
    if (store.accessDenied(failed)) onArrival('access')((s) => store.noteSwarmRead(s, 'access', failed))
    toast(`live updates stopped: ${failed.why}`)
  })
  // Who's who, for the names of a task's owner and holder; and the open tasks, for their count.
  void team.actors().then((actors) => set((s) => ({ ...s, actors: { ...Object.fromEntries(actors.map((actor) => [actor.id, actor])), ...s.actors } })), () => {})
  void loadSchemas()
  void loadSchedules()
  void loadTasks({ state: 'open', label: [] }).then((listed) => 'cursor' in listed && !listed.more && set((s) => ({ ...s, tasksCounted: true })))
}

// #region guide inspector/live.ts
/**
 * Follows the board's feed from `after`, a read's cursor, or from now without one: every event since,
 * as it happens. `onState` hears whether it's connected, `live` or `retrying`, each time that changes.
 * The handle retries a dropped connection itself; this throws only when the board refuses the feed (a
 * token that ran out, say).
 */
async function follow(after: string | undefined, each: (event: BoardEventView) => void, onState: (state: EventsState) => void) {
  for await (const event of team.events({ all: true, ...(after !== undefined ? { after } : {}) }, { onState })) each(event)
}
// #endregion

// #region guide inspector/read.ts
const PAGE = 200

/** One channel's newest messages across its threads, roots and replies alike, oldest first. */
const readChannel = (channel: string) => team.channel(channel).messages({ limit: PAGE })

/** A thread: its root, its replies oldest first, and the cursor to follow it from. */
const readThread = (id: string) => team.thread(id)
// #endregion

/**
 * Each channel's view, a page of its threads at a time (by messages on a board from before `older`), through
 * whichever handle you post as now.
 */
const listed = listing(
  { threads: (query) => team.threads(query), messages: (channel) => readChannel(channel) },
  () => state,
  set,
)

export const loadChannel = (channel: string) => once(`channel:${channel}`, () => listed.load(channel))

export async function loadOlder(channel: string): Promise<boolean> {
  try {
    return await listed.older(channel)
  } catch (error) {
    toast(said(error))
    return true
  }
}

export const loadThread = (id: string) =>
  once(`thread:${id}`, async () => {
    const { message: root, replies } = await readThread(id)
    set((s) => store.merge(s, [root, ...replies]))
  }, false)

export const loadInbox = (key: string): Promise<InboxEntry[]> => team.inbox(key, { limit: 100 })

/** Threads a filtered view asks the board for, and how many of them it reads whole. */
const FILTERED = 50
const FILTERED_WHOLE = 30

/** The kinds of filtered read the board refused, each asked once: where, and by what. */
const unsupported = new Set<string>()

/**
 * History that matches a view's filters, from the board, so a filter finds older messages too; the
 * feed keeps it current. The board lists the threads with a match, and each longer one is read whole,
 * since the match may be any message of it. A board that can't find threads that way says so once,
 * and the filter then shows what matches among what's loaded.
 */
export const loadFiltered = (channel: string | undefined, filter: store.Filter) => {
  const kind = `${channel ? 'channel' : 'board'}:${filter.from ? 'from' : ''}:${filter.text ? 'text' : ''}:${filter.label.length > 0 ? 'label' : ''}`
  if (unsupported.has(kind)) return Promise.resolve()
  return once(`filtered:${channel ?? '*'}:${JSON.stringify(filter)}`, async () => {
    const page = await team
      .threads({
        ...(channel ? { channel } : {}),
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.text ? { text: filter.text } : {}),
        ...(filter.label.length > 0 ? { label: filter.label } : {}),
        limit: FILTERED,
      })
      .catch((error: unknown) => {
        if ((error as { status?: unknown } | null)?.status === 501) unsupported.add(kind)
        throw error
      })
    set((s) => store.merge(s, page.threads.flatMap((thread) => (thread.last ? [thread.message, thread.last] : [thread.message]))))
    await Promise.all(page.threads.filter((thread) => thread.replies > 1).slice(0, FILTERED_WHOLE).map((thread) => loadThread(thread.message.id)))
  })
}

// --- writing -----------------------------------------------------------------------

// #region guide inspector/write.ts
/**
 * Posts a thread, or a reply in one. `id` is yours for this post: the same `id` never posts twice,
 * so sending it again after a dropped connection is safe.
 */
const write = (to: { channel: string } | { re: string }, message: PostOptions & { id: string }) => ('re' in to ? team.reply(to.re, message) : team.post(to.channel, message))

/** A reaction, by its short name (`eyes`), `:eyes:`, or the character; `remove` takes yours back. */
const setReaction = (id: string, emoji: string, remove: boolean) => team.react(id, emoji, { remove })

/** Sets and unsets labels on a message. */
const setLabels = (id: string, set: Record<string, string>, unset: string[]) => team.label(id, { set, unset })
// #endregion

/** A post's files, kept until it lands so a retry can send them again. */
const outgoing = new Map<string, File[]>()

/**
 * Shows a post at once; the board's answer replaces it. Files upload first. One to send later is
 * kept the same way until the board has its schedule: a refusal stays as the post with why, and
 * retry schedules it again, so nothing typed is lost.
 */
export async function send(
  post: { channel: string; re: string | null; text: string; noSync: boolean; labels: Record<string, string>; files?: File[]; task?: store.Pending['task']; later?: ScheduleTiming },
  key: string = crypto.randomUUID(),
) {
  const files = post.files ?? outgoing.get(key) ?? []
  outgoing.set(key, files)
  const pending: store.Pending = {
    channel: post.channel,
    re: post.re,
    text: post.text,
    noSync: post.noSync,
    labels: post.labels,
    ...(files.length ? { files: files.map((f) => ({ name: f.name, size: f.size })) } : {}),
    ...(post.later ? { later: post.later } : {}),
    ...(post.task ? { task: post.task } : {}),
    key,
    createdAt: new Date().toISOString(),
    error: null,
  }
  set((s) => ({ ...s, pending: [...s.pending.filter((p) => p.key !== key), pending] }))
  try {
    const attachments = await Promise.all(files.map((file) => team.upload({ data: file, name: file.name })))
    const content = {
      text: post.text,
      ...(attachments.length ? { attachments } : {}),
      ...(post.noSync ? { noSync: true } : {}),
      ...(Object.keys(post.labels).length > 0 ? { labels: post.labels } : {}),
    }
    if (post.later) {
      // Posts later, as you: a new thread in a channel, or a reply in a thread. Its files go with every send.
      const scheduled = await team.schedule(post.re === null ? post.channel : { re: post.re }, { ...content, ...post.later })
      outgoing.delete(key)
      set((s) => ({ ...s, pending: s.pending.filter((p) => p.key !== key) }))
      toast(`scheduled for ${new Date(scheduled.next ?? scheduled.first).toLocaleString()}`)
      void loadSchedules()
      return
    }
    // The same `id` never posts twice, so a retry is safe.
    const options = { ...content, id: key }
    // A thread that starts as a task is one write: its root, files and all, and what makes it a task.
    const sent = post.task
      ? (await team.tasks.create(post.channel, { ...options, needs: post.task.needs, for: post.task.for })).task
      : await write(post.re === null ? { channel: post.channel } : { re: post.re }, options)
    outgoing.delete(key)
    set((s) => store.sent(s, key, sent))
  } catch (error) {
    set((s) => ({ ...s, pending: s.pending.map((p) => (p.key === key ? { ...p, error: refusal(error) } : p)) }))
  }
}

export const retry = ({ files: _shown, ...pending }: store.Pending) => send(pending, pending.key)

export const discard = (key: string) => {
  outgoing.delete(key)
  set((s) => ({ ...s, pending: s.pending.filter((p) => p.key !== key) }))
}

/**
 * Applies a change at once and sends it. The board's next view of the message
 * confirms it; if that never comes, the overlay drops after a while and the
 * board's view stands.
 */
async function change(id: string, op: store.Op, run: () => Promise<unknown>) {
  const opId = crypto.randomUUID()
  set((s) => store.addOp(s, id, opId, op))
  try {
    await run()
    setTimeout(() => set((s) => store.dropOp(s, id, opId)), 8000)
  } catch (error) {
    set((s) => store.dropOp(s, id, opId))
    toast(said(error))
  }
}

export const react = (id: string, emoji: string, remove: boolean) => change(id, { kind: 'react', emoji, remove }, () => setReaction(id, emoji, remove))

export const edit = (id: string, text: string) => change(id, { kind: 'edit', text }, () => team.edit(id, text))

export const remove = (id: string) => change(id, { kind: 'delete' }, () => team.delete(id))

export const label = (id: string, put: Record<string, string>, unset: string[]) =>
  change(id, { kind: 'label', set: put, unset }, () => setLabels(id, put, unset))

// --- attachments -----------------------------------------------------------------

const objectUrls = new Map<string, Promise<string>>()

/** An attachment as a `blob:` URL. The page fetches it through its handle: an `<img>` can't send the page's token. */
export function attachmentUrl(id: string): Promise<string> {
  let url = objectUrls.get(id)
  if (!url) {
    url = team.download(id).then(async (response) => URL.createObjectURL(await response.blob()))
    url.catch(() => objectUrls.delete(id))
    objectUrls.set(id, url)
  }
  return url
}

/** Saves an attachment under its own name. */
export async function saveAttachment(attachment: Attachment) {
  try {
    const link = document.createElement('a')
    link.href = await attachmentUrl(attachment.id)
    link.download = attachment.name
    link.click()
  } catch (error) {
    toast(`couldn't download ${attachment.name}: ${said(error)}`)
  }
}

// --- tasks: threads with a state ---------------------------------------------------

// #region guide inspector/tasks.ts
/**
 * Tasks, oldest first: the order a queue works them in. Each comes as its thread's summary, and
 * its root's `task` says its state, whose it is, what it waits for, and who holds it. Open ones
 * unless `state` asks for more; `channel` is a channel, or with a trailing `/` it and what's under
 * it; `after` is the `cursor` of the page before.
 */
const listTasks = (query: { state?: 'open' | 'all' | TaskView['state']; channel?: string; label?: string[]; owner?: string; for?: string; after?: string }) =>
  team.tasks.list({ ...query, limit: PAGE })
// #endregion

// #region guide inspector/claims.ts
/**
 * The claims this tab holds, by task: each claim's `epoch` and `token`, which its writes carry.
 * The token is a secret, so it lives in memory and nowhere else: never in storage, where a script
 * on the page or another tab could read it. A reload gives the claims up, and their leases run out.
 */
const claims = new Map<string, { epoch: number; token: string }>()

/** Claims a task, and keeps the claim. A task that can't be claimed now throws a 409: `task_claimed`, `task_waiting`, `task_assigned`. */
async function claim(id: string): Promise<MessageView> {
  const claimed = await team.tasks.claim(id)
  claims.set(id, { epoch: claimed.epoch, token: claimed.token })
  return claimed.task
}

/** What this tab's claim on a task does: `renew`, `release`, `complete`, `fail`, and `block`. Once the claim is over, each throws a 409 `claim_lost` and changes nothing. */
function held(id: string) {
  const mine = claims.get(id)
  if (!mine) throw new BoardError('claim_lost', 'this tab holds no claim on it', 409)
  return team.tasks.held(id, mine)
}
// #endregion

// The store knows which claims are live, from what the board shows; once it drops one it had,
// its token goes too. One the store hasn't taken in yet is kept: a claim's token is here a
// moment before the store hears of it, and anything that changes the store in between runs this.
const recorded = new Set<string>()
listeners.add(() => {
  for (const id of claims.keys()) {
    if (state.claims[id]) recorded.add(id)
    else if (recorded.delete(id)) claims.delete(id)
  }
})

/**
 * The tasks a filter keeps, a page at a time, into the store. Answers where the list ends for
 * now, or what the board refused it for: `tooWide` when the filter's tree holds more channels than
 * one list reads, as Vercel's board says for a caller who doesn't read every channel.
 */
export async function loadTasks(filter: store.TaskFilter, after?: string): Promise<{ cursor: string; last: MessageView | undefined; more: boolean } | { refused: string; tooWide: boolean }> {
  try {
    const page = await listTasks({
      state: filter.state,
      ...(filter.channel ? { channel: filter.channel } : {}),
      ...(filter.label.length > 0 ? { label: filter.label } : {}),
      ...(filter.owner ? { owner: filter.owner } : {}),
      ...(filter.for ? { for: filter.for } : {}),
      ...(after ? { after } : {}),
    })
    set((s) => store.mergeTasks(s, page))
    return { cursor: page.cursor, last: page.tasks.at(-1)?.message, more: page.tasks.length === PAGE }
  } catch (error) {
    return { refused: refusal(error), tooWide: (error as { code?: unknown } | null)?.code === 'channel_tree_too_large' }
  }
}

/** A task write: the root it answers goes in the store, and a refusal is said in the page's words. */
async function work(id: string, write: () => Promise<MessageView>): Promise<boolean> {
  try {
    const root = await write()
    set((s) => store.merge(s, [root]))
    return true
  } catch (error) {
    // The board never says who holds it now, only that this claim doesn't.
    if (error instanceof BoardError && error.code === 'claim_lost') set((s) => store.unclaimed(s, id))
    toast(refusal(error))
    return false
  }
}

/** Claims a task for the board's default lease, and tells the store which claim this tab now holds. */
export async function claimTask(id: string): Promise<boolean> {
  try {
    const root = await claim(id)
    set((s) => store.claimed(s, root, { epoch: claims.get(id)!.epoch }))
    // The feed was ahead and the task has moved on: the store never held this claim, so its token goes here.
    if (!state.claims[id]) claims.delete(id)
    return true
  } catch (error) {
    toast(refusal(error))
    return false
  }
}

export const renewTask = (id: string) => work(id, async () => (await held(id).renew()).task)
export const releaseTask = (id: string) => work(id, async () => held(id).release())
export const completeTask = (id: string, result?: string) => work(id, async () => held(id).complete(result))
export const failTask = (id: string, reason: string) => work(id, async () => held(id).fail(reason))
/** Holds a task for a person: through this tab's claim while it has one, which ends the claim, or else as its owner. */
export const blockTask = (id: string, reason: string, kind?: string) =>
  work(id, async () => {
    const root = state.messages[id]
    const mine = store.isTask(root) && store.holding(state, root, Date.now()) !== undefined
    return mine ? held(id).block(reason, kind ? { kind } : {}) : team.tasks.block(id, reason, kind ? { kind } : {})
  })
export const unblockTask = (id: string) => work(id, () => team.tasks.unblock(id))
export const reopenTask = (id: string) => work(id, () => team.tasks.reopen(id))
/** `actor` is one of the owner's (`<owner>+<profile>`), or null for anyone who may claim it. */
export const assignTask = (id: string, actor: string | null) => work(id, () => team.tasks.assign(id, actor))
export const cancelTask = (id: string, reason: string) => work(id, () => team.tasks.cancel(id, reason))

/** Makes the thread `re` roots a task, as it is. */
export const makeTask = (re: string, options: { needs: string[]; for: string | null }) => work(re, async () => (await team.tasks.create({ re }, options)).task)

// A claim's token is only in this tab: leaving the page gives up what it holds, so the browser asks first.
addEventListener('beforeunload', (event) => {
  if (Object.keys(state.claims).length > 0) event.preventDefault()
})

// --- swarm: task lists and decisions ------------------------------------------------------

type Active = () => boolean

async function swarmRead(kind: store.SwarmRead, active: Active, read: () => Promise<(s: store.State) => store.State>) {
  const accept = onArrival(kind, active)
  try {
    const update = await read()
    accept((s) => update(store.noteSwarmRead(s, kind, null)))
  } catch (error) {
    accept((s) => store.noteSwarmRead(s, kind, readFailure(error)))
  }
}

/** Use the same task cache as Tasks, paging in server order. Filtered lists also attest to the leases they return. */
async function scanSwarm(kind: 'open' | 'completed' | 'ready' | 'claims', scope: SwarmScope, active: Active) {
  const handle = team
  const accept = onArrival(kind, active)
  const pauseEpoch = state.swarm.control?.pauseEpoch ?? 0
  const check = kind === 'ready' ? 'readyCheck' : kind === 'claims' ? 'claimCheck' : null
  const leases = new Map<string, { epoch: number; until: string }>()
  try {
    let after: string | undefined
    while (active()) {
      const page = await handle.tasks.list(kind === 'completed'
        ? { ...scope, state: 'completed', latest: true, limit: RECENT_COMPLETED }
        : { ...scope, state: kind === 'claims' ? 'claimed' : kind, limit: PAGE, after })
      const done = kind === 'completed' || page.tasks.length < PAGE || page.cursor === after
      if (check) {
        for (const { message: { id, task } } of page.tasks) {
          if (task?.state === 'claimed' && task.claim) leases.set(id, { epoch: task.epoch, until: task.claim.until })
        }
      }
      if (!accept((s) => {
        const next = store.mergeTasks(s, page)
        if (!done) return next
        const checked = check ? { ...next, swarm: { ...next.swarm, [check]: { pauseEpoch, leases } } } : next
        return store.noteSwarmRead(checked, kind, null)
      }) || done) return
      after = page.cursor
    }
  } catch (error) {
    accept((s) => store.noteSwarmRead(s, kind, readFailure(error)))
  }
}

let refreshSwarm: ((events?: BoardEventView[]) => Promise<unknown>) | undefined

export function watchSwarm(section: 'queue' | 'mobs', scope: SwarmScope) {
  const profile = profileVersion
  const active: Active = () => refreshSwarm === refresh && profile === profileVersion
  const refresh = (events?: BoardEventView[]): Promise<unknown> => {
    if (!active()) return Promise.resolve()
    const navigation = events === undefined
    const controlEvent = events?.some(({ type }) => type === 'work.control') ?? false
    const touched = navigation || controlEvent || events?.some(({ message, type }) =>
      type.startsWith('task.') || !!message?.task || (message?.re != null && !!state.messages[message.re]?.task))
    const { reads, control } = state.swarm
    if (!touched && !events?.length) return Promise.resolve()
    let checking: { pauseEpoch: number; result: Promise<unknown> } | undefined
    const check = () => {
      const pauseEpoch = state.swarm.control?.pauseEpoch
      if (!active() || !pauseEpoch) return
      if (checking?.pauseEpoch === pauseEpoch) return checking.result
      const now = Date.now()
      if (!swarmRoots(state, scope, now).some((root) => swarmState(state, root, now) === null)) return
      const result = Promise.all([scanSwarm('ready', scope, active), scanSwarm('claims', scope, active)])
      checking = { pauseEpoch, result }
      return result
    }
    // A full reader gets work.control on the existing feed. Bootstrap if it isn't in history;
    // scoped readers don't get it, so sample /control once per navigation or task-event batch.
    const readStatus = () => {
      if (!active() || controlEvent || (!navigation && reads.control?.status === 501)) return
      return swarmRead('control', active, async () => {
        const status = await team.status()
        return (s) => store.mergeControl(s, status)
      }).then(check)
    }
    const status = touched && (!control || reads.control || !feedReadAll || !store.readAccess(state).readsAll) && readStatus()
    // Grants change off-feed. Any live batch is an opportunity to check them.
    const access = swarmRead('access', active, async () => {
      const me = await team.me()
      return (s) => ({ ...s, me })
    }).then(() => {
      // The next request may have lost the wide access that the feed opened with.
      if (touched && !status && !state.swarm.reads.access && !store.readAccess(state).readsAll) return readStatus()
    })
    const open = (navigation || reads.open) && scanSwarm('open', scope, active).then(check)
    const completed = section === 'mobs' && (navigation || reads.completed) && scanSwarm('completed', scope, active)
    return Promise.all([access, completed, status, open, touched && !open && !status && check()])
  }
  const { access, control } = state.swarm.reads
  set((s) => ({ ...s, swarm: { ...s.swarm, reads: { access, control } } }))
  refreshSwarm = refresh
  const ready = refresh()
  return {
    ready,
    stop: () => {
      if (refreshSwarm === refresh) refreshSwarm = undefined
    },
  }
}

export async function applyLiveEvents(events: BoardEventView[]) {
  listed.apply(events)
  await refreshSwarm?.(events)
}

export async function loadSwarmAttention(root: store.TaskRoot) {
  if (!root.task.attentionId || state.messages[root.id]?.version !== root.version) return
  const handle = team
  const accept = onArrival(`attention:${root.id}`)
  try {
    const { attention } = await handle.tasks.attention(root.id)
    // A replacement (or no decision) isn't a result for this root version. Keep the old decision
    // until the feed or a task page brings the newer root, and read again for that root.
    accept((s) => store.mergeAttention(s, root, attention))
  } catch (error) {
    const failed = readFailure(error)
    if (!accept((s) => store.mergeAttention(s, root, failed)) || state.messages[root.id]?.version !== root.version ||
        !store.blocksOnAttention(state, root) || !store.readAccess(state).readable(root.channel) || failed.status === 401 || failed.status === 404) return
    // A plain hold can retain the same request ID, kind and question. Look for its answer in
    // one read of the thread's recent events, without replaying history into the live feed.
    const history = await handle.poll({ re: root.id, last: RECENT, all: true }).catch(() => null)
    if (history?.events.some((event) => event.type === 'task.attention_answered' && event.payload.id === root.id &&
      event.payload.requestId === root.task.attentionId && event.message?.version === root.version)) {
      accept((s) => store.mergeAttention(s, root, 'closed'))
    }
  }
}

/** The board checks the responder and the snapshot. Send exactly the decision the viewer saw. */
export async function answerSwarmAttention(root: store.TaskRoot, attention: AttentionView, option: string) {
  const actor = state.me?.actor
  if (!actor) return
  const key = store.answerKey(actor, root.id, attention.id)
  if (state.swarm.answers[key]?.is === 'sending') return
  const profile = profileVersion
  const answerState = (entry: store.SwarmState['answers'][string] | null) => set((s) => {
    const answers = { ...s.swarm.answers }
    if (entry) answers[key] = entry
    else delete answers[key]
    return { ...s, swarm: { ...s.swarm, answers } }
  })
  let failed: store.ReadFailure | undefined
  answerState({ is: 'sending' })
  try {
    const result = await team.tasks.answer(root.id, attention.id, { option, commit: attention.commit })
    if (profile !== profileVersion) return
    set((s) => store.mergeAttention(store.merge(s, [result.task]), result.task, result.attention))
    if (result.attention.status === 'answered') toast(`decision answered · task ${result.attention.receipt.routedTo}`)
  } catch (error) {
    failed = readFailure(error)
  } finally {
    answerState(failed && profile === profileVersion ? { is: 'failed', ...failed } : null)
  }
}

// --- schemas: what a message's blocks hold -------------------------------------------------

/** The board's registry: the built-ins, then its own. It says what each block's fields mean. */
export async function loadSchemas() {
  try {
    const schemas = await team.schemas()
    set((s) => ({ ...s, schemas, schemasRefused: null }))
  } catch (error) {
    // Blocks still show, by their data alone; the registry's view says what the board answered.
    set((s) => ({ ...s, schemasRefused: said(error) }))
  }
}

/** Reads the registry again for a schema it doesn't hold: someone may have registered it since, and nothing in the feed says so. Once per schema. */
export const findSchema = (id: string) => once(`schema:${id}`, loadSchemas)

/** Registers a schema version, for good. Answers what the board refused it for, in its words, or null once it's kept. */
export async function registerSchema(input: SchemaInput): Promise<string | null> {
  try {
    const { schema } = await team.createSchema(input)
    set((s) => store.addSchema(s, schema))
    return null
  } catch (error) {
    return said(error)
  }
}

// --- access: who is let in, and what each may do ---------------------------------------------

/** The board's grants. Listing them needs `manage` at `*`: for anyone else the board says so, and the page shows that. */
export async function loadGrants() {
  set((s) => (s.grants.is === 'here' ? s : { ...s, grants: { is: 'loading' } }))
  try {
    const grants = await team.grants()
    set((s) => ({ ...s, grants: { is: 'here', items: grants } }))
  } catch (error) {
    set((s) => ({ ...s, grants: { is: 'failed', why: said(error) } }))
  }
}

/** Whether the board refused a grant change as one its caller couldn't take back: it takes their own `manage` where it reaches. */
const lockout = (error: unknown) => error instanceof BoardError && error.code === 'grant_lockout'

/**
 * A grant change, asked about first when the board refuses it as a lockout: it's sent again with
 * `lockMeOut` on a yes, and a no leaves the board's refusal as it was.
 */
async function askingFirst<T>(write: (options: GrantWriteOptions) => Promise<T>): Promise<T> {
  try {
    return await write({})
  } catch (error) {
    if (!lockout(error) || !confirm(`${said(error)}: only someone who still manages grants there could change it then. Go ahead?`)) throw error
    return write({ lockMeOut: true })
  }
}

/** A new grant. Answers what the board refused it for, in its words, or null once it's made. */
export async function createGrant(input: GrantInput): Promise<string | null> {
  try {
    await askingFirst((options) => team.createGrant(input, options))
    await loadGrants()
    return null
  } catch (error) {
    // Kept open on a lockout they said no to, with what would avoid it.
    return lockout(error) ? `${said(error)}. Make a grant that names you there first.` : said(error)
  }
}

/** Revokes a grant: its principals' next requests are refused. */
export async function revokeGrant(id: string) {
  try {
    await askingFirst((options) => team.revokeGrant(id, options))
  } catch (error) {
    // A lockout they said no to is no failure: nothing was asked of the board again.
    if (!lockout(error)) toast(`couldn't revoke ${id}: ${said(error)}`)
  }
  await loadGrants()
}

/** Which grants decide a channel, and what they give: the board's own answer, for you or for the principal `whom` names. */
export const explain = (channel: string, whom: ExplainPrincipal = {}): Promise<Explanation> => team.explain(channel, whom)

// --- schedules: messages that post later --------------------------------------------------------

/** What's scheduled: pending ones, or with `all`, done and canceled ones too. */
export async function loadSchedules(all = state.everySchedule) {
  set((s) => ({ ...s, everySchedule: all, schedules: s.schedules.is === 'here' ? s.schedules : { is: 'loading' } }))
  try {
    const schedules = await team.schedules({ all })
    set((s) => ({ ...s, schedules: { is: 'here', items: schedules } }))
  } catch (error) {
    set((s) => ({ ...s, schedules: { is: 'failed', why: said(error) } }))
  }
}

/** Stops a schedule: yours, or any where you have `manage`. */
export async function cancelSchedule(id: string) {
  try {
    await team.cancelSchedule(id)
  } catch (error) {
    toast(`couldn't cancel ${id}: ${said(error)}`)
  }
  await loadSchedules()
}

// --- watchers, sync, and channels ------------------------------------------------------------

/** The watchers boards elsewhere registered here, and what each tails: all of them with `manage` everywhere, or else your own. */
export async function loadWatchers() {
  set((s) => (s.watchers.is === 'here' ? s : { ...s, watchers: { is: 'loading' } }))
  try {
    const watchers = await team.watchers()
    set((s) => ({ ...s, watchers: { is: 'here', items: watchers } }))
  } catch (error) {
    set((s) => ({ ...s, watchers: { is: 'failed', why: said(error) } }))
  }
}

/** Where a thread is synced: each target, and the platform's link to its copy there. Nothing, on a board that syncs nothing. */
export async function loadSynced(id: string): Promise<SyncedView['targets']> {
  if ((state.discovery?.sync ?? []).length === 0) return []
  try {
    return (await team.sync(id)).targets
  } catch {
    return []
  }
}

/** Makes a channel before anything posts to it; `private` closes it to everyone but you, with two grants. Answers whether it's there to open. */
export async function createChannel(path: string, options: { private?: boolean } = {}): Promise<boolean> {
  try {
    const { channel, created } = await team.createChannel(path, options)
    set((s) => (s.channels[channel.path] ? s : { ...s, channels: { ...s.channels, [channel.path]: channel } }))
    if (!created) toast(`#${path} is there already`)
    return true
  } catch (error) {
    toast(`couldn't make #${path}: ${said(error)}`)
    return false
  }
}
