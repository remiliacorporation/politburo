import { ListTodo, PanelLeftOpen, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { MessageView, SyncedView } from '../../api/routes.ts'
import { Attention } from './attention.tsx'
import * as board from './board.ts'
import { setEditing } from './chrome.ts'
import { Composer } from './composer.tsx'
import { Feed, Toasts } from './feed.tsx'
import { Home } from './home.tsx'
import { NeedsAction } from './needs-action.tsx'
import { HomeEmblem } from './home-emblem.tsx'
import { Messages, Pendings, type RowOptions } from './message.tsx'
import { here, isTypingTarget, Link, navigate, RelativeTime, route, useLocation, useNow, useTypeToFocus } from './nav.tsx'
import { Settings } from './settings.tsx'
import { Sidebar } from './sidebar.tsx'
import { actorFor, TaskCard, taskIds } from './task.tsx'
import { Tasks } from './tasks.tsx'
import { FilterButton, FilterChips } from './filters.tsx'
import { byWritten, channelRows, channelThreads, filtering, isTask, knownLabels, listingOf, matches, mayCancelSchedule, pauseBanner, profilesOf, thread as threadOf, threadSchedules, type Filter, type State, type Viewer } from './store.ts'
import { Ask, AskForm, Header, HeaderActions, nativeMenu, Panel, ResizeHandle, type KnownLabels } from './ui.tsx'
import { boardWords, cadence, firstLine, shownName, until } from './words.ts'
import { cellHasThread, isWorkRoute, workScope } from './work-scope.ts'
import { Work } from './work-view.tsx'

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

// --- sizes you drag, remembered -------------------------------------------------------

function stored(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch {
    return fallback
  }
}
function remember(key: string, value: number | string) {
  try {
    localStorage.setItem(key, String(value))
  } catch {}
}

const SIDEBAR = { min: 180, max: 400, collapse: 150, key: 'board.sidebar-width', collapsedKey: 'board.sidebar-collapsed' }
const PANE = { min: 320, key: 'board.pane-width' }

function useSidebar() {
  const [width, setWidth] = useState(() => Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, stored(SIDEBAR.key, 224))))
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR.collapsedKey) === '1'
    } catch {
      return false
    }
  })
  // The release reads the latest position, which may not have rendered yet.
  const [dragging, setDragging] = useState<number | null>(null)
  const latest = useRef<number | null>(null)
  const collapse = (value: boolean) => {
    setCollapsed(value)
    remember(SIDEBAR.collapsedKey, value ? '1' : '0')
  }
  const commit = (next: number) => {
    setWidth(next)
    remember(SIDEBAR.key, next)
  }
  return {
    width: dragging ?? width,
    collapsed,
    collapse,
    /** Dragged under the minimum it fades; let go below the threshold and it collapses. */
    fade: dragging !== null && dragging < SIDEBAR.min ? Math.max(0.25, (dragging - 60) / (SIDEBAR.min - 60)) : 1,
    drag: (x: number) => {
      latest.current = Math.min(SIDEBAR.max, Math.max(60, x))
      setDragging(latest.current)
    },
    done: () => {
      const at = latest.current
      latest.current = null
      setDragging(null)
      if (at === null) return
      if (at < SIDEBAR.collapse) collapse(true)
      else commit(Math.max(SIDEBAR.min, at))
    },
    step: (delta: number) => commit(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width + delta))),
  }
}

function usePane() {
  const clamp = (value: number) => Math.min(Math.max(PANE.min, innerWidth * 0.7), Math.max(PANE.min, value))
  const [width, setWidth] = useState(() => stored(PANE.key, 440))
  const [dragging, setDragging] = useState<number | null>(null)
  const latest = useRef<number | null>(null)
  const commit = (next: number) => {
    setWidth(next)
    remember(PANE.key, next)
  }
  return {
    width: clamp(dragging ?? width),
    drag: (x: number) => {
      latest.current = clamp(innerWidth - x)
      setDragging(latest.current)
    },
    done: () => {
      const at = latest.current
      latest.current = null
      setDragging(null)
      if (at !== null) commit(at)
    },
    step: (delta: number) => commit(clamp(width - delta)),
  }
}

/** Who you post as, asked before anything loads: the page acts as its app, so you write as a profile of it, `ada via factory`. */
function NameGate({ done }: { done: () => void }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="boot">
      <form
        className="name-gate"
        onSubmit={(event) => {
          event.preventDefault()
          const name = new FormData(event.currentTarget).get('profile')?.toString().trim()
          if (!name) return
          void board.setProfile({ name }).then((took) => (took ? done() : setError(`couldn't post as ${name}`)))
        }}
      >
        <label htmlFor="profile">Who's posting?</label>
        <p>You'll write as a profile of this app, shown as your name via it.</p>
        <input id="profile" name="profile" autoFocus placeholder="your name, e.g. ada" pattern="[A-Za-z][A-Za-z0-9\-]{0,31}" title="a letter, then up to 31 letters, numbers, and hyphens" required />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="send">
          continue
        </button>
      </form>
    </div>
  )
}

function PauseControl({ paused }: { paused: boolean }) {
  const [action, setAction] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const label = (pause: boolean) => pause ? 'Pause' : 'Resume'
  return (
    <Panel
      title={label(action ?? !paused)}
      trigger={label(!paused)}
      triggerTitle={label(!paused)}
      triggerClass="act"
      open={action !== null}
      onOpenChange={(open) => setAction(open ? !paused : null)}
    >
      <AskForm
        fields={[{ name: 'reason', placeholder: 'reason', required: true }]}
        submit={label(action ?? !paused)}
        disabled={busy}
        onDone={() => setAction(null)}
        onSubmit={({ reason }) => {
          if (action === null) return
          setBusy(true)
          void board.changePause(action, reason!).finally(() => setBusy(false))
        }}
      />
    </Panel>
  )
}

// --- the app -----------------------------------------------------------------------

export function App() {
  const state = board.useBoard()
  const where = useLocation()
  const now = useNow(state.openTaskRoots)
  const [failed, setFailed] = useState<string | null>(null)
  const sidebar = useSidebar()
  const pane = usePane()
  // On a narrow page the sidebar is out of the way until it's asked for, and goes again once you've picked.
  const [nav, setNav] = useState(false)
  const [narrow, setNarrow] = useState(() => !matchMedia('(min-width: 64rem)').matches)
  useEffect(() => {
    const query = matchMedia('(min-width: 64rem)')
    const update = () => {
      setNarrow(!query.matches)
      if (query.matches) setNav(false)
    }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => setNav(false), [where.path])
  const shell = useRef<HTMLDivElement>(null)
  const navOpener = useRef<HTMLElement>(null)
  const threadOpener = useRef<HTMLElement>(null)
  const previous = useRef<{ path: string; thread: string | null; nav: boolean }>(null)
  const ready = Boolean(state.me) && !failed
  useLayoutEffect(() => {
    const root = shell.current
    if (!root) return
    const old = previous.current
    previous.current = { path: where.path, thread: where.thread, nav }
    const focus = (selector: string) => root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
    const restore = (element: HTMLElement | null, fallback: string) => {
      if (element && element.isConnected && element.getClientRects().length && !element.closest('[inert]')) element.focus({ preventScroll: true })
      else focus(fallback)
    }
    const mainFocus = isWorkRoute(route(where.path)) ? '.main .work-list' : '.main [data-view-title]'
    if (nav) focus('.sidebar')
    else if (old?.nav && old.path === where.path && old.thread === where.thread && narrow) {
      restore(navOpener.current, `${where.thread === null ? '.main' : '.pane'} .header [aria-label="Show sidebar"]`)
    } else if (where.thread !== null && (old?.thread !== where.thread || old.nav || (narrow && !root.querySelector('.pane')?.contains(document.activeElement)))) focus('.pane [data-view-title]')
    else if (old?.path !== where.path || old.nav) focus(mainFocus)
    else if (old.thread !== null && where.thread === null) restore(threadOpener.current, mainFocus)
  }, [where.path, where.thread, nav, narrow, ready])

  // Served from an app, the page reads nothing until you've named who you post as.
  const [naming, setNaming] = useState(board.needsName)
  useEffect(() => {
    if (!naming) board.boot().catch((error: Error) => setFailed(error.message))
  }, [naming])

  useEffect(() => {
    if (naming) return
    const read = () => void board.loadStatus()
    addEventListener('popstate', read)
    return () => removeEventListener('popstate', read)
  }, [naming])

  // Old thread links open the thread pane.
  useEffect(() => {
    const old = /^\/t\/(\d+)$/.exec(where.path)
    if (old) navigate(`/?thread=${old[1]}`, true)
    if (where.path === '/settings') navigate('/settings/access', true)
  }, [where.path])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (isTypingTarget(target) || target?.closest('[role="menu"], [role="dialog"]')) return
      if (nav) setNav(false)
      else if (where.thread !== null) navigate(here({ thread: null }))
    }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [where, nav])

  const current = route(where.path)
  // The tab says which board too, so two inspectors side by side tell apart.
  const named = boardWords(state.discovery).name
  const title = isWorkRoute(current) ? workScope(current, where.params, board.swarmRecords(), named).title
    : current.view === 'channel' ? `#${current.channel}`
    : current.view === 'settings' ? `${current.section} · settings`
    : current.view === 'missing' ? 'nothing here'
    : current.view === 'needs' ? 'Needs action'
    : current.view === 'handoffs' ? 'HANDOFFS'
    : current.view
  useEffect(() => { document.title = `${title} · ${named}` }, [title, named])

  const known = useMemo(() => knownLabels(state), [state.messages])
  const viewer = useMemo(() => (state.me ? board.viewerOf(state.me) : null), [state.me])

  if (naming) return <NameGate done={() => setNaming(false)} />
  if (failed) return <div className="boot error">error: {failed}</div>
  if (!state.me || !viewer) return <div className="boot">connecting…</div>

  const platforms = Object.fromEntries((state.discovery?.sync ?? []).map((entry) => [entry.key, entry.platform]))
  const names = namesOf(state)
  const options: RowOptions = { me: state.me.actor, viewer, now, known, platforms, syncConfigured: Boolean(state.discovery?.sync.length), board: state, schemas: state.schemas, names, openThread: (id) => navigate(here({ thread: id })) }
  const filter = where.filter
  const setFilter = (next: Filter) => navigate(here({ filter: next }), true)
  const sources = (state.discovery?.sync ?? []).map((entry) => entry.key)
  const filters = { filter, setFilter, sources, known }
  const headerLead = narrow || sidebar.collapsed ? (
    <>
      <HomeEmblem />
      <button
        type="button"
        className="tool"
        title="Show sidebar"
        aria-label="Show sidebar"
        aria-controls="board-sidebar"
        aria-expanded={nav}
        onClick={(event) => {
          navOpener.current = event.currentTarget
          if (narrow) setNav(true)
          else {
            sidebar.collapse(false)
            requestAnimationFrame(() => shell.current?.querySelector<HTMLElement>('.sidebar')?.focus())
          }
        }}
      >
        <PanelLeftOpen size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </>
  ) : null
  const identity = board.getIdentity()
  const cellPaneStatus = current.view === 'cell' && where.thread !== null
    ? state.tasksRefused ?? (!state.tasksCounted ? 'loading…' : cellHasThread(state, current.cell, where.thread) ? null : 'not in this cell')
    : null
  const paneIsFront = narrow && where.thread !== null
  const expand = paneIsFront ? null : headerLead
  const banner = pauseBanner(state, now)
  const control = current.view !== 'cell' && viewer.manages && viewer.person && viewer.profile === null && state.status
    ? <PauseControl key={viewer.actor} paused={state.status.paused} /> : null
  const headerActions = <>
    {(narrow ? !nav : sidebar.collapsed) && <span className="meta" title={state.me.actor}>acting as {shownName(state.me)}</span>}
    {state.statusRefused && <span className="meta" title={state.statusRefused}>{state.statusRefused}</span>}
    {control}
  </>
  return (
    <div
      ref={shell}
      className={`shell${nav ? ' nav' : ''}`}
      style={{ '--sidebar-width': `${sidebar.collapsed ? 0 : sidebar.width}px`, '--pane-width': `${pane.width}px` } as CSSProperties}
      onFocusCapture={(event) => {
        if (where.thread === null && !nav && event.target instanceof HTMLElement && event.target.closest('.main')) threadOpener.current = event.target
      }}
    >
      <div className="workspace">
        <PauseBanner text={banner} />
        {nav && <div className="scrim" onClick={() => setNav(false)} />}
        <nav id="board-sidebar" className="sidebar" aria-label="Board navigation" tabIndex={-1} hidden={!nav && sidebar.collapsed} style={{ width: sidebar.width, opacity: sidebar.fade }}>
          <Sidebar
            state={state}
            current={current}
            onHome={() => setNav(false)}
            onCollapse={() => {
              if (nav) setNav(false)
              else sidebar.collapse(true)
            }}
          />
          <ResizeHandle side="right" label="resize the sidebar" onDrag={sidebar.drag} onDone={sidebar.done} onStep={sidebar.step} />
        </nav>
        <main className="main" inert={narrow && (nav || where.thread !== null)}>
          <HeaderActions.Provider value={paneIsFront ? null : headerActions}>
            {current.view === 'needs' && <NeedsAction key={identity} state={state} now={now} lead={expand} />}
            {current.view === 'handoffs' && <Home key={identity} state={state} now={now} lead={expand} />}
            {current.view === 'channel' && (
              <Channel key={current.channel} channel={current.channel} state={state} options={options} known={known} lead={expand} filters={filters} />
            )}
            {isWorkRoute(current) && <Work key={`${identity}:${where.path}`} route={current} state={state} now={now} lead={expand} />}
            {current.view === 'tasks' && <Tasks key={identity} state={state} viewer={viewer} now={now} lead={expand} where={where} known={known} />}
            {current.view === 'attention' && <Attention key={identity} state={state} viewer={viewer} lead={expand} now={now} />}
            {current.view === 'settings' && <Settings state={state} viewer={viewer} now={now} lead={expand} where={where} section={current.section} open={current.open} />}
            {current.view === 'missing' && (
              <>
                <Header title="nothing here" lead={expand} />
                <div className="view-body"><p className="empty">no such page</p></div>
              </>
            )}
          </HeaderActions.Provider>
        </main>
        {where.thread !== null && (
          <aside className="pane" aria-label="Thread" inert={nav}>
            <ResizeHandle side="left" label="resize the thread" onDrag={pane.drag} onDone={pane.done} onStep={pane.step} />
            <HeaderActions.Provider value={paneIsFront ? headerActions : null}>
              {cellPaneStatus === null ? (
                <ThreadPane key={where.thread} id={where.thread} state={state} viewer={viewer} now={now} known={known}
                  lead={narrow ? headerLead : null} readOnly={current.view === 'cell'} />
              ) : (
                <div className="view-body">
                  <p className="empty" role="status" data-view-title tabIndex={-1}>{cellPaneStatus}{' '}
                    <Link className="text-link" to={here({ thread: null })}>close</Link>
                  </p>
                </div>
              )}
            </HeaderActions.Provider>
          </aside>
        )}
      </div>
      <Toasts />
    </div>
  )
}

function PauseBanner({ text }: { text: string | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const height = useRef(0)
  useLayoutEffect(() => {
    const banner = ref.current!
    const workspace = banner.parentElement!
    const compensate = () => {
      const next = banner.hidden ? 0 : banner.getBoundingClientRect().height
      const delta = next - height.current
      if (!delta) return
      height.current = next
      for (const el of workspace.querySelectorAll<HTMLElement>('.sidebar *, .main *, .pane *')) {
        // A disappearing banner can clamp scrollTop to the new bottom before we read it.
        if (el.hasAttribute('data-pinned')) el.scrollTop = el.scrollHeight
        else if (el.scrollTop > 0) el.scrollTop += delta
      }
    }
    compensate()
    const observer = new ResizeObserver(compensate)
    observer.observe(banner, { box: 'border-box' })
    return () => observer.disconnect()
  }, [text])
  return <div ref={ref} className="pause-banner" role="status" hidden={text === null}>{text}</div>
}

// --- views ---------------------------------------------------------------------------

/** Your newest message among `messages`, for ↑ to edit. */
const lastOwn = (messages: MessageView[], me: string) => [...messages].reverse().find((m) => m.by.actor === me && !m.deleted)

type Filters = { filter: Filter; setFilter: (filter: Filter) => void; sources: string[]; known: KnownLabels }

function FilterControls({ filters }: { filters: Filters }) {
  return <FilterButton filter={filters.filter} onChange={filters.setFilter} sources={filters.sources} known={filters.known} />
}

const NAMES = new WeakMap<State['actors'], Record<string, string>>()
/**
 * Every actor the page knows, by ID, by their own name, which a mention of them reads as: the same
 * record until one of them changes, so a row's text renders once. Not a hook: it's read after the
 * views' early returns.
 */
function namesOf(state: State): Record<string, string> {
  let names = NAMES.get(state.actors)
  if (!names) NAMES.set(state.actors, (names = Object.fromEntries(Object.entries(state.actors).map(([id, actor]) => [id, actor.name]))))
  return names
}

function Channel(props: { channel: string; state: State; options: RowOptions; known: KnownLabels; lead: ReactNode; filters: Filters }) {
  const { channel, state, options } = props
  const { filter } = props.filters
  const canPost = options.viewer.may('post', channel)
  useTypeToFocus('main')
  const [loading, setLoading] = useState(true)
  const identity = board.getIdentity()
  useEffect(() => {
    setLoading(true)
    void board.loadChannel(channel).finally(() => { if (identity === board.getIdentity()) setLoading(false) })
  }, [channel, identity])
  const key = JSON.stringify(filter)
  useEffect(() => {
    if (filtering(filter)) void board.loadFiltered(channel, filter)
  }, [channel, key, identity])
  // The board's thread list, by latest activity; a filter, or a board from before `older`, the messages loaded.
  const listed = !!listingOf(state, channel) && !filtering(filter)
  const { threads: all, pending: posts } = useMemo(
    () => (listed ? channelRows(state, channel) : channelThreads(state, channel)),
    [state.messages, state.ops, state.pending, state.actors, state.listings, listed, channel],
  )
  // A filtered channel shows the threads where anything matches.
  const threads = filtering(filter) ? all.filter((t) => matches(state, t.root, filter) || t.replies.some((r) => matches(state, r, filter))) : all
  const pending = filtering(filter) ? [] : posts
  const roots = threads.map((t) => t.root)
  const summaries = new Map(threads.map((t) => [t.root.id, t.summary]))
  const info = state.channels[channel]
  const newest = listed
    ? (threads.at(-1)?.summary.last ?? threads.at(-1)?.root)?.id ?? ''
    : [...roots, ...threads.flatMap((t) => t.replies)].sort(byWritten).at(-1)?.id ?? ''
  const activeAt = (m: MessageView) => summaries.get(m.id)?.last?.createdAt ?? m.createdAt
  return (
    <>
      <Header
        title={`#${channel}`}
        meta={info?.threads !== undefined && info.messages !== undefined ? `${count(info.threads, 'thread')} · ${count(info.messages, 'message')}` : undefined}
        live={state.live}
        lead={props.lead}
      >
        <FilterControls filters={props.filters} />
      </Header>
      <div className="view-body">
      <FilterChips filter={filter} onChange={props.filters.setFilter} />
      <Feed scope={channel} first={roots[0]?.id ?? ''} last={`${newest}+${pending.length}`} older={() => board.loadOlder(channel)}>
        {roots.length === 0 && pending.length === 0 && (
          <p className="empty">{loading ? 'loading…' : filtering(filter) ? 'nothing matches these filters' : canPost ? 'no messages yet: say something' : 'no messages yet'}</p>
        )}
        <Messages messages={roots} now={options.now} options={{ ...options, summary: (m) => summaries.get(m.id) }} {...(listed ? { at: activeAt } : {})} />
        <Pendings posts={pending} me={state.me!} after={roots.at(-1)} afterHasReplies={(summaries.get(roots.at(-1)?.id ?? '')?.count ?? 0) > 0} />
      </Feed>
      {canPost && <Composer
        scope={`channel:${channel}`}
        role="main"
        placeholder={`message #${channel}…`}
        known={props.known}
        syncConfigured={options.syncConfigured}
        mayLabel={() => options.viewer.may('label', channel)}
        tasks={{ state }}
        onSend={({ text, noSync, labels, files, task, later }) => void board.send({ channel, re: null, text, noSync, labels, files, ...(task ? { task } : {}), ...(later ? { later } : {}) })}
        onEditLast={() => {
          const mine = lastOwn(roots, state.me!.actor)
          if (mine) setEditing(mine.id)
        }}
      />}
      </div>
    </>
  )
}

function ThreadPane(props: { id: string; state: State; viewer: Viewer; now: number; known: KnownLabels; lead: ReactNode; readOnly: boolean }) {
  const { id, state, readOnly } = props
  const viewer: Viewer = readOnly ? { ...props.viewer, may: (permission, channel) => permission === 'read' && props.viewer.may(permission, channel) } : props.viewer
  useTypeToFocus('thread')
  const identity = board.getIdentity()
  useEffect(() => board.openThreadPane(id), [id, identity])
  const read = state.paneThread?.id === id && state.paneThread.identity === identity ? state.paneThread.result : 'loading'
  const refused = typeof read === 'object' ? read.refused : null
  const t = useMemo(() => read === 'readable' ? threadOf(state, id) : null, [state.messages, state.ops, state.pending, state.actors, id, read])
  // Where the thread's copies are, on the platforms it syncs with.
  const [synced, setSynced] = useState<SyncedView['targets']>([])
  useEffect(() => {
    void board.loadSynced(id).then(setSynced)
  }, [id])
  const scheduled = threadSchedules(state, id)
  const platforms = Object.fromEntries((state.discovery?.sync ?? []).map((entry) => [entry.key, entry.platform]))
  const names = namesOf(state)
  const options: RowOptions = { me: state.me!.actor, viewer, now: props.now, known: props.known, platforms, syncConfigured: Boolean(state.discovery?.sync.length), schemas: state.schemas, names }
  return (
    <>
      <Header lead={props.lead} title={isTask(t?.root) ? 'task' : 'thread'} meta={t ? `in #${t.root.channel}` : undefined}>
        {t && !isTask(t.root) && !t.root.deleted && viewer.may('label', t.root.channel) && (
          <Ask
            label={<ListTodo size={15} strokeWidth={1.75} />}
            className="tool"
            title="make this thread a task"
            submit="make it a task"
            note="You own it, and agents claim it."
            fields={[
              { name: 'needs', placeholder: 'needs: task IDs it waits for (optional)' },
              { name: 'for', placeholder: 'for one of your profiles (optional)', items: profilesOf(state, viewer.principal) },
            ]}
            onSubmit={(values) => void board.makeTask(id, { needs: taskIds(values.needs ?? ''), for: values.for ? actorFor(viewer.principal, values.for) : null })}
          />
        )}
        <button className="tool" aria-label="Close thread" title="close (esc)" onClick={() => navigate(here({ thread: null }))}>
          <X size={15} strokeWidth={1.75} />
        </button>
      </Header>
      <div className="view-body">
      {t && !readOnly && isTask(t.root) && <TaskCard key={identity} root={t.root} state={state} viewer={viewer} />}
      {t && (synced.length > 0 || scheduled.length > 0) && (
        <dl className="facts thread-facts" {...nativeMenu}>
          {synced.length > 0 && (
            <>
              <dt>synced</dt>
              <dd className="copies">
                {synced.map((copy) => (
                  <span key={copy.target}>
                    {copy.url ? (
                      <a href={copy.url} target="_blank" rel="noreferrer" className="text-link">
                        {copy.target}
                      </a>
                    ) : (
                      copy.target
                    )}
                    {copy.undelivered && <span className="error-text"> didn't arrive: {copy.undelivered}</span>}
                  </span>
                ))}
              </dd>
            </>
          )}
          {scheduled.map((schedule) => (
            <div key={schedule.id} className="fact">
              <dt>later</dt>
              <dd>
                {schedule.next && <RelativeTime iso={schedule.next}>{until(schedule.next, props.now)}</RelativeTime>} · {cadence(schedule)} · {firstLine(schedule.text)}{' '}
                {mayCancelSchedule(viewer, schedule) && (
                  <button className="clear" onClick={() => void board.cancelSchedule(schedule.id)}>
                    cancel
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Feed scope={`thread:${id}`} first={id} last={`${t?.replies.at(-1)?.id ?? id}+${t?.pending.length ?? 0}`}>
        {!t ? (
          <p className={refused === null ? 'empty' : 'error'}>{refused ?? 'loading…'}</p>
        ) : (
          <>
            <Messages messages={[t.root]} now={props.now} options={options} />
            <div className="divider">{t.replies.length === 1 ? '1 reply' : `${t.replies.length} replies`}</div>
            <Messages messages={t.replies} now={props.now} options={options} after={t.root} />
            {!readOnly && <Pendings posts={t.pending} me={state.me!} after={t.replies.at(-1)} />}
          </>
        )}
      </Feed>
      {t && viewer.may('post', t.root.channel) && (
        <Composer
          scope={`thread:${id}`}
          role="thread"
          placeholder="reply to thread…"
          known={props.known}
          syncConfigured={options.syncConfigured}
          mayLabel={() => viewer.may('label', t.root.channel)}
          onSend={({ text, noSync, labels, files, later }) => void board.send({ channel: t.root.channel, re: id, text, noSync, labels, files, ...(later ? { later } : {}) })}
          onEditLast={() => {
            const mine = lastOwn([t.root, ...t.replies], state.me!.actor)
            if (mine) setEditing(mine.id)
          }}
        />
      )}
      </div>
    </>
  )
}
