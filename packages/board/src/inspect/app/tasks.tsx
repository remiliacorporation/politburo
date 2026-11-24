import { ListFilter, X } from 'lucide-react'
import { Component, createRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_TASK_PRIORITY, TaskPriority } from '../../contract/schemas.ts'
import { compileAccess } from '../../server/access.ts'
import * as board from './board.ts'
import { claimFirst } from './claim-order.ts'
import { Composer } from './composer.tsx'
import { describe } from './filters.tsx'
import { Pendings } from './message.tsx'
import { Ago, here, Link, navigate, useTypeToFocus, type Where } from './nav.tsx'
import { LabelValue } from './sha.tsx'
import { nameOf, placesUnder, readFilter, taskScope, tasks, taskState, TASK_FILTER_STATES, type State, type TaskFilter, type TaskRoot, type Viewer } from './store.ts'
import { Lease, Needs, StateMark } from './task.tsx'
import { Header, nativeMenu, Panel, Suggest, type KnownLabels } from './ui.tsx'
import { firstLine } from './words.ts'

const PRIORITIES = [...TaskPriority.options].reverse()

const setFilter = (changes: Record<string, string | string[] | null>) => navigate(here({ params: changes }), true)

export function Tasks(props: { state: State; viewer: Viewer; now: number; lead: ReactNode; where: Where; known: KnownLabels }) {
  const { state, viewer, where, now } = props
  const mayPost = (channel: string) => viewer.may('post', channel)
  const writable = Object.keys(state.channels).filter(mayPost).sort()
  useTypeToFocus('main')
  const query = where.params.toString()
  const filter = useMemo(() => readFilter(where.params), [query])
  const { priority } = filter
  const inScope = state.taskScope === taskScope(filter.channel)
  const refused = inScope ? state.tasksRefused : null
  const accepted = inScope ? state.openTaskMe : null
  const latest = useMemo(() => {
    if (!accepted) return []
    const viewer = board.viewerOf(accepted)
    const eligible = state.status?.paused ? { ...viewer, may: () => false } : viewer
    return claimFirst(tasks(state, filter, now), eligible, now)
  }, [accepted, filter, now, state])
  const [frozen, setFrozen] = useState<{ query: string; ids: string[] } | null>(null)
  const rowList = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const selecting = () => {
    const selection = document.getSelection()
    const inside = (node: Node | null) => node !== null && rowList.current?.contains(node)
    return selection && !selection.isCollapsed && (inside(selection.anchorNode) || inside(selection.focusNode))
  }
  const releaseRows = () => {
    if (!hovered.current && !rowList.current?.contains(document.activeElement) && !selecting()) setFrozen(null)
  }
  useEffect(() => {
    document.addEventListener('selectionchange', releaseRows)
    return () => document.removeEventListener('selectionchange', releaseRows)
  }, [])
  const freezeRows = () => setFrozen((prior) => prior?.query === query ? prior : { query, ids: latest.map(({ id }) => id) })
  // Only the order is held: use current content and membership, appending newly visible rows.
  const rows = useMemo(() => {
    if (frozen?.query !== query) return latest
    const current = new Map(latest.map((row) => [row.id, row]))
    const ordered = frozen.ids.flatMap((id) => {
      const row = current.get(id)
      current.delete(id)
      return row ? [row] : []
    })
    return [...ordered, ...current.values()]
  }, [frozen, latest, query])
  useLayoutEffect(() => {
    if (frozen?.query === query && (frozen.ids.length !== rows.length || rows.some((row, i) => row.id !== frozen.ids[i]))) {
      setFrozen({ query, ids: rows.map(({ id }) => id) })
    }
  }, [frozen, query, rows])

  const scopeRows = accepted ? tasks(state, { state: 'all', label: [] }, now) : []
  const owners = [...new Set(scopeRows.map(({ task }) => task.owner))]
  const assignees = [...new Set(scopeRows.flatMap(({ task }) => task.for ? [task.for] : []))]
  const chips: { key: string; text: string; drop: Record<string, string | string[] | null> }[] = [
    ...(filter.state !== 'open' ? [{ key: 'state', text: `state ${filter.state}`, drop: { state: null } }] : []),
    ...(filter.channel ? [{ key: 'channel', text: `in #${filter.channel}`, drop: { channel: null } }] : []),
    ...(priority ? [{ key: 'priority', text: `priority ${priority}`, drop: { priority: null } }] : []),
    ...filter.label.map((label) => ({ key: `label:${label}`, text: describe(label), drop: { label: filter.label.filter((l) => l !== label) } })),
    ...(filter.owner ? [{ key: 'owner', text: `owner ${nameOf(state, filter.owner)}`, drop: { owner: null } }] : []),
    ...(filter.for ? [{ key: 'for', text: `for ${nameOf(state, filter.for)}`, drop: { for: null } }] : []),
  ]
  // Tasks on their way, and any the board refused, with why.
  const pending = state.pending.filter((post) => post.task !== undefined && post.re === null)
  return (
    <>
      <Header title="tasks" meta="claimable first, then by priority and age" live={state.live} lead={props.lead}>
        <TaskFilterButton filter={filter} channels={Object.keys(state.channels).sort()} owners={owners} assignees={assignees} state={state} known={props.known} count={chips.length} />
      </Header>
      <div className="view-body">
      <nav className="tabs plain">
        {TASK_FILTER_STATES.map((name) => (
          <Link key={name} to={here({ params: { state: name === 'open' ? null : name } })} className="tab" current={filter.state === name}>
            {name}
          </Link>
        ))}
        {chips.map((chip) => (
          <span key={chip.key} className="label">
            {chip.text}
            <button title={`remove ${chip.text}`} onClick={() => setFilter(chip.drop)}>
              <X size={11} />
            </button>
          </span>
        ))}
      </nav>
      <TaskPage rows={rows} query={query}>
        {refused && state.tasksTooWide ? (
          <Places channels={Object.keys(state.channels)} under={filter.channel} />
        ) : refused ? (
          <p className="empty error">{refused}</p>
        ) : !accepted || state.tasksLoading ? (
          <p className="empty" role="status">loading all {state.tasksLoading ?? 0} so far</p>
        ) : rows.length === 0 && pending.length === 0 ? (
          <p className="empty">{chips.length > 0 ? 'no tasks match' : 'no open tasks'}</p>
        ) : null}
        <div
          className="task-rows"
          ref={rowList}
          tabIndex={-1}
          onFocusCapture={(event) => { if (event.target !== event.currentTarget) freezeRows() }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget) && !hovered.current && !selecting()) setFrozen(null)
          }}
          onMouseEnter={() => { hovered.current = true; freezeRows() }}
          onMouseLeave={() => { hovered.current = false; releaseRows() }}
        >
          {rows.map((row) => (
            <TaskRow key={row.id} root={row} state={state} now={now} open={where.thread === row.id} />
          ))}
        </div>
        <Pendings posts={pending} me={state.me!} />
      </TaskPage>
      {state.me && compileAccess(state.me.can).anywhere('post') && <Composer
        scope="tasks"
        role="main"
        placeholder="start a task…"
        known={props.known}
        channels={writable}
        syncConfigured={Boolean(state.discovery?.sync.length)}
        mayPost={mayPost}
        mayLabel={(channel) => viewer.may('label', channel)}
        {...(filter.channel && !filter.channel.endsWith('/') && mayPost(filter.channel) ? { channel: filter.channel } : {})}
        tasks={{ state, always: true }}
        onSend={({ text, noSync, channel, labels, files, task }) => void board.send({ channel, re: null, text, noSync, labels, files, ...(task ? { task } : {}) })}
      />}
      </div>
    </>
  )
}

type TaskPageProps = { rows: TaskRoot[]; query: string; children: ReactNode }
type TaskPageSnapshot = { anchor?: { row: HTMLElement; offset: number }; focus?: HTMLElement }

/** Keep the visible anchor, and hand off focus if the row being read goes away. */
class TaskPage extends Component<TaskPageProps> {
  private page = createRef<HTMLDivElement>()

  getSnapshotBeforeUpdate(previous: TaskPageProps): TaskPageSnapshot | null {
    const page = this.page.current
    if (!page || previous.query !== this.props.query || previous.rows === this.props.rows) return null
    const frame = page.getBoundingClientRect()
    const next = new Set(this.props.rows.map((row) => row.id))
    const before = [...page.querySelectorAll<HTMLElement>('[data-task-row]')]
    const survives = (row: HTMLElement) => next.has(row.dataset.taskRow!)
    const focused = before.findIndex((row) => row.contains(document.activeElement))
    const snapshot: TaskPageSnapshot = {}
    if (focused !== -1 && !survives(before[focused]!)) {
      const neighbor = before.slice(focused + 1).find(survives) ?? before.slice(0, focused).findLast(survives)
      const focus = neighbor ?? page.querySelector<HTMLElement>('.task-rows')
      if (focus) snapshot.focus = focus
    }
    for (const row of before) {
      const box = row.getBoundingClientRect()
      if (box.top >= frame.bottom) break
      if (box.bottom > frame.top && survives(row)) {
        snapshot.anchor = { row, offset: box.top - frame.top }
        break
      }
    }
    return snapshot
  }

  componentDidUpdate(_previous: TaskPageProps, _state: unknown, snapshot: TaskPageSnapshot | null) {
    const page = this.page.current
    if (!page || !snapshot) return
    const { anchor, focus } = snapshot
    if (focus && page.contains(focus)) focus.focus({ preventScroll: true })
    if (!anchor || !page.contains(anchor.row)) return
    const shift = anchor.row.getBoundingClientRect().top - page.getBoundingClientRect().top - anchor.offset
    if (shift) page.scrollTop += shift
  }

  render() {
    return <div className="page task-page" ref={this.page}>{this.props.children}</div>
  }
}

/**
 * Where to look, when the board lists tasks a tree at a time: Vercel's does for a caller who doesn't
 * read every channel. Each place filters the list to it, and one that's still too big shows its own.
 */
function Places({ channels, under }: { channels: string[]; under: string | undefined }) {
  const places = placesUnder(channels, under)
  return (
    <>
      <p className="empty">
        {under ? `#${under} has` : 'this board has'} too many channels to list tasks from at once, since you don't read every channel here. pick where to look:
      </p>
      <div className="task-places">
        {places.map(({ place, channels: count }) => (
          <Link key={place} to={here({ params: { channel: place } })} className="task-place">
            <span className="name">#{place}</span>
            {place.endsWith('/') && <span className="count">{count === 1 ? '1 channel' : `${count} channels`}</span>}
          </Link>
        ))}
      </div>
    </>
  )
}

/** One task: its state, what it says, and the one thing about it that matters now. Opens its thread. */
function TaskRow({ root, state, now, open }: { root: TaskRoot; state: State; now: number; open: boolean }) {
  const { task } = root
  const current = taskState(task, now, state.status)
  const labels = Object.entries(root.labels).filter(([key]) => !key.startsWith('board.'))
  return (
    <div
      className="task-row"
      data-task-row={root.id}
      role="link"
      tabIndex={0}
      aria-current={open ? 'true' : undefined}
      onClick={(event) => {
        // A link inside the row (what it needs) goes where it says.
        if (!(event.target as HTMLElement).closest('a')) navigate(here({ thread: root.id }))
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') navigate(here({ thread: root.id }))
      }}
    >
      <StateMark state={current} />
      <span className="task-priority">{task.priority ?? DEFAULT_TASK_PRIORITY}</span>
      <span className="task-title" {...nativeMenu}>
        {/* A task can be its files alone. */}
        <span className="faint">#{root.id}</span> {firstLine(root.text) || (root.attachments ?? []).map((file) => file.name).join(', ') || 'message removed'}
        {labels.map(([key, value]) => (
          <span key={key} className="label">
            {key}=<LabelValue name={key} value={value} />
          </span>
        ))}
      </span>
      <span className="task-now">
        {current === 'claimed' && task.claim && (
          <>
            {nameOf(state, task.claim.actor)} · <Lease until={task.claim.until} now={now} />
          </>
        )}
        {current === 'ready' && (task.state === 'claimed' ? 'claim ended' : task.for ? `for ${nameOf(state, task.for)}` : '')}
        {current === 'waiting' && (
          <>
            needs <Needs ids={task.needs} state={state} now={now} />
          </>
        )}
        {current === 'blocked' && (task.blocked?.kind ?? task.blocked?.reason)}
        {current === 'completed' && task.result}
        {(current === 'failed' || current === 'canceled') && task.reason}
      </span>
      <span className="task-where">#{root.channel}</span>
      <Ago iso={root.createdAt} />
    </div>
  )
}

function TaskFilterButton(props: { filter: TaskFilter; channels: string[]; owners: string[]; assignees: string[]; state: State; known: KnownLabels; count: number }) {
  const { filter, state } = props
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState(filter.channel ?? '')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const valueRef = useRef<HTMLDivElement>(null)
  useEffect(() => setChannel(filter.channel ?? ''), [filter.channel])
  // A channel, or with a trailing slash it and everything under it.
  const places = [...new Set(props.channels.flatMap((path) => [path, ...(path.includes('/') ? [`${path.slice(0, path.indexOf('/'))}/`] : [])]))].sort()
  const addLabel = () => {
    const k = key.trim()
    if (!k) return
    const label = value.trim() ? `${k}=${value.trim()}` : k
    if (!filter.label.includes(label)) setFilter({ label: [...filter.label, label] })
    setKey('')
    setValue('')
  }
  const who = (name: 'owner' | 'for', ids: string[]) => (
    <div className="segments">
      {['', ...ids].map((id) => (
        <button key={id || 'any'} className={`segment${(filter[name] ?? '') === id ? ' on' : ''}`} title={id} onClick={() => setFilter({ [name]: id || null })}>
          {id ? nameOf(state, id) : 'anyone'}
        </button>
      ))}
    </div>
  )
  return (
    <Panel
      title="filter tasks"
      trigger={
        <>
          <ListFilter size={15} strokeWidth={1.75} />
          {props.count > 0 && <span className="count">{props.count}</span>}
        </>
      }
      open={open}
      onOpenChange={setOpen}
    >
      <div className="filter-form">
        <div className="filter-row">
          <span className="filter-name">channel</span>
          <Suggest
            prefix="#"
            value={channel}
            onChange={(next) => {
              setChannel(next)
              // Picking one from the list filters at once; typing waits for Enter.
              if (places.includes(next) || next === '') setFilter({ channel: next || null })
            }}
            items={places}
            placeholder="any (work/ for all under it)"
            onEnter={() => setFilter({ channel: channel.trim().replace(/^#/, '') || null })}
          />
        </div>
        <div className="filter-row">
          <span className="filter-name">priority</span>
          <div className="segments" role="group" aria-label="priority">
            {[null, ...PRIORITIES].map((priority) => (
              <button
                key={priority ?? 'any'}
                className={`segment${(filter.priority ?? null) === priority ? ' on' : ''}`}
                aria-pressed={(filter.priority ?? null) === priority}
                onClick={() => setFilter({ priority })}
              >
                {priority ?? 'any'}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-name">labels</span>
          <div className="label-add">
            <Suggest value={key} onChange={setKey} items={[...props.known.keys()].filter((k) => !k.startsWith('board.'))} placeholder="key" onEnter={() => (value ? addLabel() : valueRef.current?.querySelector('input')?.focus())} />
            <span className="faint">=</span>
            <div ref={valueRef} className="grow">
              <Suggest value={value} onChange={setValue} items={[...(props.known.get(key.trim()) ?? [])]} placeholder="any (or a|b)" onEnter={addLabel} />
            </div>
            <button className="send small" disabled={!key.trim()} onClick={addLabel}>
              add
            </button>
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-name">owner</span>
          {who('owner', props.owners)}
        </div>
        <div className="filter-row">
          <span className="filter-name">for</span>
          {who('for', props.assignees)}
        </div>
      </div>
    </Panel>
  )
}
