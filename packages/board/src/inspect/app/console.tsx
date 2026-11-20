import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import type { BoardEventView } from '../../api/routes.ts'
import { compileAccess } from '../../server/access.ts'
import * as board from './board.ts'
import { Ago, here, Link, navigate, type Where } from './nav.tsx'
import { CONSOLE_LANES, consoleBlockers, consoleLane, consolePriority, consoleTasks, isTask, shown, stateNow, type ConsoleLane, type State, type TaskRoot, type Viewer } from './store.ts'
import { Header } from './ui.tsx'
import { firstLine } from './words.ts'

const PRIORITIES = ['1', '2', '3', '4', '5', 'unreported'] as const
const titleOf = (root: TaskRoot) => firstLine(root.text) || root.attachments[0]?.name || `task ${root.id}`
const change = (params: Record<string, string | null>) => navigate(here({ params }), true)

export function Console({ state, viewer, now, where, lead }: { state: State; viewer: Viewer; now: number; where: Where; lead: ReactNode }) {
  const search = useRef<HTMLInputElement>(null)
  const lanes = useRef<HTMLDivElement>(null)
  const channel = where.params.get('channel') || undefined
  const lane = CONSOLE_LANES.find((name) => name === where.params.get('lane'))
  const priority = PRIORITIES.find((value) => value === where.params.get('priority'))
  const text = where.params.get('text') ?? ''

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target
      if (where.thread || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!(target instanceof HTMLElement) || !target.closest('.main') || target.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"], [inert]')) return
      if (event.key === '/') {
        event.preventDefault()
        search.current?.focus()
      } else if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        const step = event.key === ']' ? 1 : -1
        const index = lane === undefined ? (step === 1 ? 0 : CONSOLE_LANES.length - 1) : CONSOLE_LANES.indexOf(lane) + step
        change({ lane: CONSOLE_LANES[index] ?? null })
        if (lanes.current?.contains(target)) lanes.current.focus({ preventScroll: true })
      }
    }
    addEventListener('keydown', keys)
    return () => removeEventListener('keydown', keys)
  }, [lane, where.thread])

  return (
    <>
      <Header title="operator console" lead={lead} live={state.live} />
      <div className="operator-filters" role="group" aria-label="Console filters">
        <label>Search <input ref={search} type="search" value={text} onChange={(e) => change({ text: e.currentTarget.value })} /></label>
        <label>Lane <select value={lane ?? ''} onChange={(e) => change({ lane: e.currentTarget.value })}>
          <option value="">All lanes</option>
          {CONSOLE_LANES.map((name) => <option key={name}>{name}</option>)}
        </select></label>
        <label>Priority label <select value={priority ?? ''} onChange={(e) => change({ priority: e.currentTarget.value })}>
          <option value="">Any priority</option>
          {PRIORITIES.map((value) => <option key={value} value={value}>{value === 'unreported' ? 'Unreported' : value}</option>)}
        </select></label>
        <label>Channel <select value={channel ?? ''} onChange={(e) => change({ channel: e.currentTarget.value })}>
          <option value="">All channels</option>
          {Object.keys(state.channels).sort().map((path) => <option value={path} key={path}>#{path}</option>)}
        </select></label>
        <span className="hint"><kbd>/</kbd> search · <kbd>[</kbd> <kbd>]</kbd> lanes</span>
      </div>
      <ConsoleList key={JSON.stringify([viewer.actor, channel])} scroller={lanes} {...{ state, viewer, now, channel, lane, priority, text }} />
    </>
  )
}

type TaskPage = Awaited<ReturnType<typeof board.loadTasks>>

function ConsoleList({ state, viewer, now, channel, lane, priority, text, scroller }: {
  state: State; viewer: Viewer; now: number; channel: string | undefined; lane: ConsoleLane | undefined
  priority: ReturnType<typeof consolePriority> | undefined; text: string
  scroller: Ref<HTMLDivElement>
}) {
  const [page, setPage] = useState<TaskPage | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const filter = useMemo(() => ({ state: 'all' as const, label: [], ...(channel ? { channel } : {}) }), [channel])
  useEffect(() => {
    let active = true
    void board.loadTasks(filter).then((answer) => {
      if (!active) return
      setPage(answer)
      setLoading(false)
    })
    return () => { active = false }
  }, [filter])

  const access = useMemo(() => compileAccess(state.me?.can ?? {}), [state.me])
  const listed = page && 'cursor' in page ? page : null
  const rows = useMemo(() => listed ? consoleTasks(state, { channel, lane, priority, text }, now, listed.more ? listed.last : undefined)
    .filter((row) => access.readable(row.channel)) : [], [state.messages, state.ops, state.actors, channel, lane, priority, text, now, listed, access])
  const root = selected === null ? undefined : shown(state, selected)
  const task = isTask(root) && !root.deleted && access.readable(root.channel) ? root : null

  return (
    <>
      <div className="operator-scroller" ref={scroller} tabIndex={0} aria-label="Task lanes" role="region" aria-busy={loading}>
        {page && 'refused' in page ? <p className="error" role="status">{page.refused}</p> : page === null ? <p className="empty" role="status">loading tasks…</p> : (
          <>
            <div className="operator-lanes">
              {CONSOLE_LANES.filter((name) => !lane || name === lane).map((name) => {
                const inLane = rows.filter((row) => consoleLane(row, now) === name)
                return (
                  <section key={name} className="operator-lane" aria-label={name}>
                    <h2>{name} <span className="hint">{inLane.length}</span></h2>
                    {inLane.length === 0 ? <p className="hint">{name === 'QA review' ? 'no QA stage reported' : 'no loaded tasks'}</p> : (
                      <ul>{inLane.map((row) => {
                        const rank = consolePriority(row)
                        return <li key={row.id}>
                          <button type="button" className="operator-card" aria-pressed={selected === row.id} onClick={() => setSelected(selected === row.id ? null : row.id)}>
                            <span className="hint">#{row.id} · {row.channel}{rank !== 'unreported' ? ` · P${rank}` : ''}</span>
                            <strong>{titleOf(row)}</strong>
                          </button>
                        </li>
                      })}</ul>
                    )}
                  </section>
                )
              })}
            </div>
            {listed?.more && <button type="button" className="act" disabled={loading} onClick={() => {
              setFailure(null)
              setLoading(true)
              void board.loadTasks(filter, listed.cursor).then((answer) => {
                setLoading(false)
                if ('refused' in answer) setFailure(answer.refused)
                else setPage(answer)
              })
            }}>{loading ? 'loading tasks…' : 'load more tasks'}</button>}
            {failure && <p className="error" role="status">{failure}</p>}
          </>
        )}
      </div>
      {task && <TaskDetails key={task.id} {...{ state, viewer, now, task }} onClose={() => setSelected(null)} />}
    </>
  )
}

function TaskDetails({ state, task, viewer, now, onClose }: { state: State; task: TaskRoot; viewer: Viewer; now: number; onClose: () => void }) {
  const current = stateNow(task.task, now)
  const needs = current === 'waiting' || current === 'blocked' ? task.task.needs : null
  const [needRefusals, setNeedRefusals] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!needs) return
    const controller = new AbortController()
    setNeedRefusals({})
    for (const id of new Set(needs)) {
      void board.loadConsoleNeed(id, controller.signal).then((refused) => {
        if (refused !== undefined && !controller.signal.aborted) setNeedRefusals((current) => ({ ...current, [id]: refused }))
      })
    }
    return () => controller.abort()
  }, [needs])
  const blockers = consoleBlockers(state, task, viewer, now, needRefusals)
  return (
    <section className="operator-details" aria-label={`Details for task ${task.id}`}>
      <div className="operator-detail-head">
        <h2>{titleOf(task)}</h2>
        <Link to={here({ thread: task.id })} className="text-link">open thread</Link>
        <button type="button" className="clear" onClick={onClose}>close details</button>
      </div>
      <h3>Why isn't this running?</h3>
      {blockers.length > 0 ? <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <p>No blocker shown by this task and your access.</p>}
      <p className="hint">The board does not report dispatch pause or work scope here.</p>
      <TaskHistory id={task.id} />
    </section>
  )
}

const eventNote = (event: BoardEventView) => {
  switch (event.type) {
    case 'task.blocked': return [event.payload.kind, event.payload.reason].filter(Boolean).join(': ')
    case 'task.canceled':
    case 'task.failed': return event.payload.reason
    case 'task.completed': return event.payload.result
    case 'message.posted':
    case 'message.edited': return event.message?.deleted ? null : firstLine(event.message?.text ?? '')
    default: return null
  }
}

type HistoryPage = Awaited<ReturnType<typeof board.loadTaskHistory>>

function TaskHistory({ id }: { id: string }) {
  const [kind, setKind] = useState('task')
  const [after, setAfter] = useState<string>()
  const [request, retry] = useState(0)
  const [page, setPage] = useState<HistoryPage | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void board.loadTaskHistory(id, after, controller.signal).then((answer) => {
      if (!controller.signal.aborted) setPage(answer)
    })
    return () => controller.abort()
  }, [id, after, request])
  const events = page && 'events' in page ? page.events.filter((event) => kind === 'all' || event.type.startsWith(`${kind}.`)) : []
  const load = (cursor?: string) => {
    setPage(null)
    setAfter(cursor)
    retry((n) => n + 1)
  }
  return (
    <div className="operator-history">
      <h3>Task history</h3>
      <label>History filter <select value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
        <option value="task">Task changes</option>
        <option value="message">Messages</option>
        <option value="all">All events</option>
      </select></label>
      {page === null ? <p role="status">loading history…</p> : 'refused' in page ? <p className="error" role="status">{page.refused}</p> : events.length === 0 ? <p role="status">No matching events on this page.</p> : (
        <ol>{events.map((event) => {
          const note = eventNote(event)
          return <li key={event.cursor}>
            <code>{event.type}</code>{event.actor && ` · ${event.actor.name}`} · <Ago iso={event.createdAt} />{note && ` · ${note}`}
          </li>
        })}</ol>
      )}
      {page && <div className="operator-history-actions">
        {after && <button type="button" className="act" onClick={() => load()}>first page</button>}
        <button type="button" className="act" onClick={() => load('cursor' in page ? page.cursor : after)}>
          {'refused' in page ? 'retry history' : page.cursor === (after ?? id) ? 'check for newer events' : 'next history page'}
        </button>
      </div>}
    </div>
  )
}
