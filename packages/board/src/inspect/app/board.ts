import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { AttentionAnswerBody, BoardEventView, Explanation, GrantInput, GrantWriteOptions, InboxEntry, Me, MessageView, SchemaInput, SyncedView, TaskView } from '../../api/routes.ts'
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
import type { TaskPriority } from '../../contract/schemas.ts'
import * as attentionStore from './attention-store.ts'
import { toast } from './chrome.ts'
import { listing } from './listing.ts'
import { base, currentPath, route } from './nav.tsx'
import * as store from './store.ts'
import { refusal, said } from './words.ts'
import { fixtureRecords } from './work-fixtures.ts'
import type { SwarmRecords } from './work.ts'

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
    const value = JSON.parse(meta('inspect-profile') || 'null') as string | Profile | null
    return typeof value === 'string' ? { name: value } : value
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
let identity = 0
let profileChoice = 0
let feedFollow: AbortController | undefined
let bootStarted = false

export const getIdentity = () => identity

/** Switches who you post as, then learns the identity that is, and remembers it once the board takes it. */
export async function setProfile(next: Profile | null | undefined): Promise<boolean> {
  const choice = ++profileChoice
  const handle = handleFor(next)
  try {
    const me = await handle.me()
    if (choice !== profileChoice) return false
    feedFollow?.abort()
    feedFollow = undefined
    // Publish the new handle and its acting-as label in the same turn.
    flushSync(() => {
      team = handle
      identity++
      profile = next
      loaded.clear()
      listed = listingForCurrentHandle()
      set((s) => ({ ...s, me, schedules: { is: 'loading' }, live: bootStarted ? 'reconnecting' : s.live,
        tasksCounted: false, openTaskRoots: {}, openTaskMe: null, openTaskAttentionRefusals: {}, paneThread: null,
        tasksRefused: null, attention: {}, attentionUnsupported: false }))
    })
    if (bootStarted) void boot().catch((error) => toast(said(error)))
    else void loadSchedules()
  } catch (error) {
    if (choice === profileChoice) toast(`couldn't switch: ${said(error)}`)
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
  return { actor: me.actor, principal: me.principal, profile: me.profile, may: (permission, channel) => access.can(permission, channel), manages: access.at('manage', '*'), person: me.kind === 'person' }
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

const loaded = new Map<string, Promise<void>>()

/** Loads once per key; a failure can be retried. */
function once(key: string, load: () => Promise<void>): Promise<void> {
  let promise = loaded.get(key)
  if (!promise) {
    const as = identity
    promise = load().catch((error) => {
      if (as !== identity) return
      loaded.delete(key)
      toast(said(error))
    })
    loaded.set(key, promise)
  }
  return promise
}

// --- reading -----------------------------------------------------------------------

/** The page shows once it knows who you are and the channels the sidebar lists. */
export async function boot(): Promise<void> {
  bootStarted = true
  const handle = team
  const as = identity
  const current = () => handle === team && as === identity
  // Keep the first page's cursor so live updates cover posts while later pages are loading.
  let after: string | undefined
  const snapshot = await Promise.all([
    handle.me(),
    handle.discovery().catch(() => null),
    everyChannel({ channels: async (query) => {
      const page = await handle.channels(query)
      after ??= page.cursor
      return page
    } }),
  ]).catch((error) => {
    if (current()) throw error
    return null
  })
  if (!snapshot || !current()) return
  const [me, discovery, channels] = snapshot
  set((s) => ({ ...s, me, discovery, channels: Object.fromEntries(channels.map((c) => [c.path, c])) }))
  const controller = feedFollow = new AbortController()
  // A burst of events is one render: they're folded in a frame at a time.
  let queue: BoardEventView[] = []
  let taskUpdates: { root: MessageView; epoch: number }[] = []
  const flush = () => {
    const events = queue
    const updates = taskUpdates
    queue = []
    taskUpdates = []
    if (!current()) return
    listed.apply(events)
    mergeOpenTaskEvents(updates)
    if (attentionVisit) refreshAttentionEvents(events)
    // A schedule's own state isn't in the feed, but its sends are: one that landed means the list moved.
    if (events.some((event) => event.message?.schedule !== undefined)) void loadSchedules()
  }
  follow(
    handle,
    after,
    controller.signal,
    (event) => {
      if (!current()) return
      if (event.type === 'work.control') {
        // Apply the transition immediately so the store can reject older status snapshots.
        set((s) => store.applyEvent(s, event))
        void loadStatus()
      } else {
        if (event.message && observeOpenTaskEvent(event.message))
          taskUpdates.push({ root: event.message, epoch: openTaskEpoch })
        if (queue.push(event) === 1) requestAnimationFrame(flush)
      }
    },
    (feed) => {
      if (!current()) return
      const reconnected = feed === 'live' && state.live === 'reconnecting'
      set((s) => ({ ...s, live: feed === 'live' ? 'live' : 'reconnecting' }))
      if (reconnected && needsVisit) refreshOpenTasks(true)
    },
  ).catch((error) => { if (current()) toast(`live updates stopped: ${said(error)}`) })
  // Read after the feed's cursor is fixed: a pause is either in this snapshot or in the feed.
  void loadStatus()
  // Who's who, for the names of a task's owner and holder; and the open tasks, for their count.
  void handle.actors().then((actors) => {
    if (current()) set((s) => ({ ...s, actors: { ...Object.fromEntries(actors.map((actor) => [actor.id, actor])), ...s.actors } }))
  }, () => {})
  void loadSchemas()
  void loadSchedules()
  if (route(currentPath()).view !== 'needs' && openTaskRead?.identity !== identity) refreshOpenTasks()
}

// #region guide inspector/live.ts
/**
 * Follows the board's feed from `after`, a read's cursor, or from now without one: every event since,
 * as it happens. `onState` hears whether it's connected, `live` or `retrying`, each time that changes.
 * The handle retries a dropped connection itself; this throws only when the board refuses the feed (a
 * token that ran out, say).
 */
async function follow(team: ReturnType<typeof board>, after: string | undefined, signal: AbortSignal, each: (event: BoardEventView) => void, onState: (state: EventsState) => void) {
  for await (const event of team.events({ all: true, ...(after !== undefined ? { after } : {}) }, { signal, onState })) each(event)
}
// #endregion

// #region guide inspector/read.ts
const PAGE = 200

/** One channel's newest messages across its threads, roots and replies alike, oldest first. */
const readChannel = (channel: string, handle = team) => handle.channel(channel).messages({ limit: PAGE })

/** A thread: its root, its replies oldest first, and the cursor to follow it from. */
const readThread = (id: string) => team.thread(id)
// #endregion

/**
 * Each channel's view, a page of its threads at a time (by messages on a board from before `older`), through
 * whichever handle you post as now.
 */
function listingForCurrentHandle() {
  const handle = team
  const as = identity
  return listing(
    { threads: (query) => handle.threads(query), messages: (channel) => readChannel(channel, handle) },
    () => state,
    (next) => { if (as === identity) set(next) },
  )
}

let listed = listingForCurrentHandle()

export const loadChannel = (channel: string) => once(`channel:${channel}`, () => listed.load(channel))

export async function loadOlder(channel: string): Promise<boolean> {
  const as = identity
  try {
    return await listed.older(channel)
  } catch (error) {
    if (as === identity) toast(said(error))
    return true
  }
}

export const loadThread = (id: string) =>
  once(`thread:${id}`, async () => {
    const as = identity
    try {
      const { message: root, replies } = await readThread(id)
      if (as !== identity) return
      set((s) => store.merge(s, [root, ...replies]))
    } catch (error) {
      if (as === identity && inaccessible(error)) {
        forgetThread(id, said(error))
        refreshThreadPane(id)
      }
      throw error
    } finally {
      // Share in-flight reads, not the access decision from a prior visit to the thread.
      if (as === identity) loaded.delete(`thread:${id}`)
    }
  })

let pane: { id: string; identity: number; read: number } | undefined

export function openThreadPane(id: string) {
  const visit = pane = { id, identity, read: 0 }
  set((s) => ({ ...s, paneThread: { id, identity, result: 'loading' } }))
  refreshThreadPane()
  return () => { if (pane === visit) pane = undefined }
}

function refreshThreadPane(only?: string) {
  const visit = pane
  if (!visit || visit.identity !== identity || (only !== undefined && only !== visit.id)) return
  const { id } = visit
  const read = ++visit.read
  const current = () => pane === visit && visit.identity === identity && read === visit.read
  void readThread(id).then(({ message, replies }) => {
    if (!current()) return
    set((s) => ({ ...store.merge(s, [message, ...replies]), paneThread: { id, identity, result: 'readable' } }))
  }, (error: unknown) => {
    if (!current()) return
    if (inaccessible(error)) forgetThread(id, said(error))
    else set((s) => ({ ...s, paneThread: { id, identity, result: { refused: said(error) } } }))
  })
}

/** Threads a filtered view asks the board for, and how many of them it reads whole. */
const FILTERED = 50
const FILTERED_WHOLE = 30

/** The kinds of filtered read the board refused, each asked once. */
const unsupported = new Set<string>()

/**
 * History that matches a view's filters, from the board, so a filter finds older messages too; the
 * feed keeps it current. The board lists the threads with a match, and each longer one is read whole,
 * since the match may be any message of it. A board that can't find threads that way says so once,
 * and the filter then shows what matches among what's loaded.
 */
export const loadFiltered = (channel: string, filter: store.Filter) => {
  const kind = `${filter.from ? 'from' : ''}:${filter.text ? 'text' : ''}:${filter.label.length > 0 ? 'label' : ''}`
  if (unsupported.has(kind)) return Promise.resolve()
  return once(`filtered:${channel}:${JSON.stringify(filter)}`, async () => {
    const as = identity
    const page = await team
      .threads({
        channel,
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.text ? { text: filter.text } : {}),
        ...(filter.label.length > 0 ? { label: filter.label } : {}),
        limit: FILTERED,
      })
      .catch((error: unknown) => {
        if (as === identity && (error as { status?: unknown } | null)?.status === 501) unsupported.add(kind)
        throw error
      })
    if (as !== identity) return
    set((s) => store.merge(s, page.threads.flatMap((thread) => (thread.last ? [thread.message, thread.last] : [thread.message]))))
    await Promise.all(page.threads.filter((thread) => thread.replies > 1).slice(0, FILTERED_WHOLE).map((thread) => loadThread(thread.message.id)))
  })
}

// --- work control and registry ------------------------------------------------------

let statusRead = 0
let statusSettled = 0
let statusRefusedAt = 0

export async function loadStatus() {
  const read = ++statusRead
  const as = identity
  try {
    const status = await team.status()
    if (as !== identity) return
    statusSettled = Math.max(statusSettled, read)
    set((s) => {
      // Work state is ordered by the board's transitions; the refusal is ordered by request.
      const next = store.applyStatus(s, status)
      return next.statusRefused !== null && read > statusRefusedAt ? { ...next, statusRefused: null } : next
    })
  } catch (error) {
    // A refusal only adds a note to the header; it never replaces a successful status.
    if (as !== identity || read <= statusSettled) return
    statusSettled = statusRefusedAt = read
    set((s) => ({ ...s, statusRefused: said(error) }))
  }
}

export async function changePause(paused: boolean, reason: string) {
  const as = identity
  try {
    const status = await (paused ? team.pause(reason) : team.resume(reason))
    if (as === identity) set((s) => store.applyStatus(s, status))
  } catch (error) {
    if (as === identity) toast(refusal(error))
  }
}

export async function listProfiles(channel: string): Promise<string[] | undefined> {
  const handle = team
  const as = identity
  try {
    const { agents } = await handle.agents.list(channel)
    if (handle !== team || as !== identity) return
    return [...new Set(agents.flatMap(({ binding }) => binding.profile === null ? [] : [binding.profile]))].sort()
  } catch (error) {
    if (handle !== team || as !== identity) return
    if (!(error instanceof BoardError && error.code === 'no_agent_ops')) throw error
    return []
  }
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
    const as = identity
    const attachments = await Promise.all(files.map((file) => team.upload({ data: file, name: file.name })))
    if (as !== identity) throw new Error('the acting identity changed before this was sent; retry to send as the current identity')
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
    set((s) => as === identity ? store.sent(s, key, sent) : { ...s, pending: s.pending.filter((p) => p.key !== key) })
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

/**
 * The tasks a filter keeps, a page at a time, into the store. Answers where the list ends for
 * now, or what the board refused it for: `tooWide` when the filter's tree holds more channels than
 * one list reads, as Vercel's board says for a caller who doesn't read every channel.
 */
export async function loadTasks(filter: store.TaskFilter, after?: string): Promise<{ cursor: string; last: MessageView | undefined; more: boolean; roots: MessageView[] } | { refused: string; tooWide: boolean; inaccessible: boolean } | undefined> {
  const as = identity
  try {
    const page = await listTasks({
        state: filter.state,
        ...(filter.channel ? { channel: filter.channel } : {}),
        ...(filter.label.length > 0 ? { label: filter.label } : {}),
        ...(filter.owner ? { owner: filter.owner } : {}),
        ...(filter.for ? { for: filter.for } : {}),
        ...(after ? { after } : {}),
      })
    if (as !== identity) return
    const roots = page.tasks.map((task) => task.message)
    set((s) => store.merge(s, roots))
    return { cursor: page.cursor, last: roots.at(-1), more: roots.length === PAGE, roots }
  } catch (error) {
    if (as !== identity) return
    return { refused: refusal(error), tooWide: (error as { code?: unknown } | null)?.code === 'channel_tree_too_large', inaccessible: inaccessible(error) }
  }
}

const inaccessible = (error: unknown) => error instanceof BoardError && (error.status === 403 || error.status === 404)

let openTaskEpoch = 0
let openTaskRead: {
  identity: number; again: boolean; superseded: boolean; refused: Set<string>; observed: Map<string, MessageView>
} | undefined
let attentionVisit: symbol | undefined
let needsVisit: symbol | undefined

/** The feed updates members, but only a complete list may admit a new member. */
function observeOpenTaskEvent(root: MessageView): boolean {
  if (root.re !== null) return false
  const member = Object.hasOwn(state.openTaskRoots, root.id)
  if (!member && store.isTask(root) && !root.deleted && store.OPEN_STATES.includes(root.task.state)) refreshOpenTasks()
  const read = openTaskRead
  // A root can be in the in-flight snapshot even if it has never been a member here.
  if (read?.identity === identity && (read.observed.get(root.id)?.version ?? -1) <= root.version)
    read.observed.set(root.id, root)
  return member
}

function mergeOpenTaskEvents(updates: { root: MessageView; epoch: number }[]) {
  const members = updates.flatMap(({ root, epoch }) =>
    epoch === openTaskEpoch && Object.hasOwn(state.openTaskRoots, root.id) ? [root] : [])
  if (members.length) set((s) => ({ ...s, openTaskRoots: store.newest(s.openTaskRoots, members) }))
}

function forgetThread(id: string, reason: string, fromNeedsAttention = false) {
  if (openTaskRead?.identity === identity) openTaskRead.refused.add(id)
  const inPane = pane?.identity === identity && pane.id === id ? pane : undefined
  // An older pane snapshot must not replace the refusal.
  if (inPane) inPane.read++
  set((s) => {
    const { [id]: _, ...openTaskRoots } = s.openTaskRoots
    return { ...s, openTaskRoots,
      openTaskAttentionRefusals: fromNeedsAttention ? { ...s.openTaskAttentionRefusals, [id]: reason } : s.openTaskAttentionRefusals,
      paneThread: inPane ? { id, identity, result: { refused: reason } } : s.paneThread }
  })
}

/** Publish the full membership and its permissions together. Never publish a partial page. */
function refreshOpenTasks(revalidate = false) {
  if (openTaskRead?.identity === identity) {
    openTaskRead.again = true
    openTaskRead.superseded ||= revalidate
    return
  }
  const read = openTaskRead = { identity, again: false, superseded: false, refused: new Set<string>(), observed: new Map<string, MessageView>() }
  const handle = team
  const current = () => read.identity === identity && !read.superseded
  const roots = async () => {
    const found: MessageView[] = []
    let after: string | undefined
    while (current()) {
      const page = await handle.tasks.list({ state: 'open', limit: PAGE, ...(after ? { after } : {}) })
      found.push(...page.tasks.map(({ message }) => message))
      if (page.tasks.length < PAGE || page.cursor === after) break
      after = page.cursor
    }
    return found
  }
  const requests = [roots(), handle.me()] as const
  void Promise.all(requests).then(([tasks, me]) => {
    if (!current()) return
    openTaskEpoch++
    const accepted = tasks.filter(({ id }) => !read.refused.has(id)).map((root) => {
      let latest = root
      for (const view of [state.openTaskRoots[root.id], read.observed.get(root.id)])
        if (view && view.version > latest.version) latest = view
      return latest
    })
    const openTaskRoots = Object.fromEntries(accepted.filter((root) =>
      store.isTask(root) && !root.deleted && store.OPEN_STATES.includes(root.task.state)).map((root) => [root.id, root]))
    set((s) => {
      const next = store.merge(s, accepted)
      const id = pane?.identity === identity ? pane.id : undefined
      const root = id === undefined ? undefined : next.messages[id]
      // Do not keep a possibly revoked task on screen while its thread read is in flight.
      // A known transition out of open work is not itself a loss of access.
      const hide = id !== undefined && root && !Object.hasOwn(openTaskRoots, id) &&
        (!viewerOf(me).may('read', root.channel) || (Object.hasOwn(s.openTaskRoots, id) &&
          store.isTask(root) && !root.deleted && store.OPEN_STATES.includes(root.task.state)))
      const paneThread = hide && s.paneThread?.result === 'readable' ? { ...s.paneThread, result: 'loading' as const } : s.paneThread
      return { ...next, openTaskRoots, openTaskMe: me, tasksCounted: true, tasksRefused: null, openTaskAttentionRefusals: {}, paneThread }
    })
    refreshThreadPane()
    refreshAttentionRoots()
  }, (error: unknown) => {
    if (!current()) return
    openTaskEpoch++
    set((s) => ({ ...s, openTaskRoots: {}, openTaskMe: null, tasksCounted: false, tasksRefused: refusal(error) }))
  }).finally(async () => {
    // Even on refusal, don't start another read until both requests have settled.
    await Promise.allSettled(requests)
    if (openTaskRead !== read) return
    openTaskRead = undefined
    if (read.identity === identity && read.again) refreshOpenTasks()
  })
}

export function swarmRecords(): SwarmRecords | null {
  return new URLSearchParams(location.search).get('swarm') === 'fixtures' ? fixtureRecords : null
}

export function openNeeds() {
  const visit = needsVisit = Symbol()
  const close = openAttention()
  const revalidate = () => { if (document.visibilityState === 'visible') refreshOpenTasks(true) }
  window.addEventListener('focus', revalidate)
  document.addEventListener('visibilitychange', revalidate)
  refreshOpenTasks(true)
  return () => {
    if (needsVisit === visit) needsVisit = undefined
    window.removeEventListener('focus', revalidate)
    document.removeEventListener('visibilitychange', revalidate)
    close()
  }
}

function refreshAttentionRoots() {
  if (!attentionVisit) return
  const roots = needsVisit ? Object.values(state.openTaskRoots).filter(attentionStore.holdsAttention) : attentionStore.attentionTasks(state)
  for (const root of roots) void readAttention(root)
}

export function openAttention() {
  const visit = attentionVisit = Symbol()
  refreshAttentionRoots()
  return () => {
    if (attentionVisit !== visit) return
    attentionVisit = undefined
    set(attentionStore.leaveAttention)
  }
}

function refreshAttentionEvents(events: BoardEventView[]) {
  const touched = new Set<string>()
  for (const event of events) {
    const message = event.message
    if (store.isTask(message)) touched.add(message.id)
    // Editing or deleting a reply can invalidate evidence in the request.
    if ((event.type === 'message.edited' || event.type === 'message.deleted') && message?.re) touched.add(message.re)
  }
  for (const id of touched) {
    const root = needsVisit ? state.openTaskRoots[id] : state.messages[id]
    if (attentionStore.holdsAttention(root)) void readAttention(root)
  }
}

const attentionFailure = (error: unknown) => ({
  words: said(error),
  unsupported: error instanceof BoardError && error.status === 501,
})

export function attentionRendered(rendered: store.State) {
  set((s) => attentionStore.showAttentionRefusals(s, rendered))
}

async function readAttention(root: ReturnType<typeof attentionStore.attentionTasks>[number]) {
  const as = identity
  const visit = attentionVisit
  const needs = needsVisit
  const epoch = openTaskEpoch
  const { id } = root
  const reading = attentionStore.beginAttentionRead(state, root)
  set(() => reading.state)
  const current = () => as === identity && visit === attentionVisit &&
    state.attention[id]?.latest === reading.read &&
    (!needs || (epoch === openTaskEpoch && Object.hasOwn(state.openTaskRoots, id)))
  try {
    const { attention } = await team.tasks.attention(id)
    if (current()) set((s) => attentionStore.finishAttentionRead(s, id, reading.read, { is: 'here', value: attention }))
  } catch (error) {
    if (!current()) return
    if (inaccessible(error)) {
      forgetThread(id, said(error), needs !== undefined)
      refreshThreadPane(id)
      if (needs) return
    }
    set((s) => attentionStore.finishAttentionRead(s, id, reading.read, { is: 'failed', ...attentionFailure(error) }))
  }
}

/** Only the feed settles a successful answer. */
export async function answerAttention(id: string, requestId: string, optionId: string) {
  const root = state.messages[id]
  if (!attentionStore.holdsAttention(root) || !state.me) return
  const { attention, reason, disabled } = attentionStore.attentionFor(state, root, viewerOf(state.me))
  if (!attention || attention.id !== requestId || reason !== null || disabled) return
  const option = attention.options.find((option) => option.id === optionId)
  if (!option) return
  const as = identity
  set((s) => attentionStore.beginAnswer(s, root, attention, option.label))
  try {
    await team.tasks.answer(id, requestId, { option: option.id, commit: attention.commit })
    if (as === identity) set((s) => attentionStore.finishAnswer(s, id, attention))
  } catch (error) {
    if (as === identity) set((s) => attentionStore.finishAnswer(s, id, attention, attentionFailure(error)))
  }
}

/** A task write: the root it answers goes in the store, and a refusal is said in the page's words. */
async function work(write: () => Promise<MessageView>): Promise<boolean> {
  const as = identity
  try {
    const root = await write()
    if (as !== identity) return false
    set((s) => store.merge(s, [root]))
    return true
  } catch (error) {
    if (as === identity) toast(refusal(error))
    return false
  }
}

export const blockTask = (id: string, reason: string, kind?: string) => work(() => team.tasks.block(id, reason, kind ? { kind } : {}))
export const unblockTask = (id: string) => work(() => team.tasks.unblock(id))
export const reopenTask = (id: string) => work(() => team.tasks.reopen(id))
/** `actor` is one of the owner's (`<owner>+<profile>`), or null for anyone who may claim it. */
export const assignTask = (id: string, actor: string | null) => work(() => team.tasks.assign(id, actor))
export const cancelTask = (id: string, reason: string) => work(() => team.tasks.cancel(id, reason))
export const parkTask = (id: string, reason: string) => work(() => team.tasks.park(id, reason))
export const unparkTask = (id: string, reason: string) => work(() => team.tasks.unpark(id, reason))
export const prioritizeTask = (id: string, priority: TaskPriority) => work(() => team.tasks.priority(id, priority))
export async function loadAttention(id: string) {
  const as = identity
  const visit = pane
  const member = Object.hasOwn(state.openTaskRoots, id)
  const current = () => as === identity && pane === visit && (!member || Object.hasOwn(state.openTaskRoots, id))
  try {
    const result = await team.tasks.attention(id)
    if (current() && (visit?.id !== id || state.paneThread?.result === 'readable')) return result
  } catch (error) {
    if (!current()) return
    if (inaccessible(error)) {
      forgetThread(id, said(error))
      refreshThreadPane(id)
    }
    throw error
  }
}
export const answerTask = (id: string, request: string, answer: AttentionAnswerBody) => work(async () => (await team.tasks.answer(id, request, answer)).task)

/** Makes the thread `re` roots a task, as it is. */
export const makeTask = (re: string, options: { needs: string[]; for: string | null }) => work(async () => (await team.tasks.create({ re }, options)).task)

// --- schemas: what a message's blocks hold -------------------------------------------------

/** The board's registry: the built-ins, then its own. It says what each block's fields mean. */
export async function loadSchemas() {
  const handle = team
  const as = identity
  const current = () => handle === team && as === identity
  try {
    const schemas = await handle.schemas()
    if (current()) set((s) => ({ ...s, schemas, schemasRefused: null }))
  } catch (error) {
    // Blocks still show, by their data alone; the registry's view says what the board answered.
    if (current()) set((s) => ({ ...s, schemasRefused: said(error) }))
  }
}

/** Reads the registry again for a schema it doesn't hold: someone may have registered it since, and nothing in the feed says so. Once per schema. */
export const findSchema = (id: string) => once(`schema:${id}`, loadSchemas)

/** Registers a schema version, for good. Answers what the board refused it for, in its words, or null once it's kept. */
export async function registerSchema(input: SchemaInput): Promise<string | null> {
  const as = identity
  try {
    const { schema } = await team.createSchema(input)
    if (as === identity) set((s) => store.addSchema(s, schema))
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
  const as = identity
  try {
    return await write({})
  } catch (error) {
    if (as !== identity || !lockout(error) || !confirm(`${said(error)}: only someone who still manages grants there could change it then. Go ahead?`)) throw error
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

let scheduleRead = 0

/** What's scheduled: pending ones, or with `all`, done and canceled ones too. */
export async function loadSchedules(all = state.everySchedule) {
  const read = ++scheduleRead
  const handle = team
  const current = () => read === scheduleRead && handle === team
  set((s) => ({ ...s, everySchedule: all, schedules: all === s.everySchedule && s.schedules.is === 'here' ? s.schedules : { is: 'loading' } }))
  try {
    const schedules = await handle.schedules({ all })
    if (current()) set((s) => ({ ...s, schedules: { is: 'here', items: schedules } }))
  } catch (error) {
    if (current()) set((s) => ({ ...s, schedules: { is: 'failed', why: said(error) } }))
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

// --- watchers and sync ---------------------------------------------------------------------

export const loadInbox = (key: string): Promise<InboxEntry[]> => team.inbox(key, { limit: 100 })

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
