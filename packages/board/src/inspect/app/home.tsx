import { useEffect, useState, type ReactNode } from 'react'
import * as board from './board.ts'
import { here, Link, RelativeTime } from './nav.tsx'
import { isTask, nameOf, stateNow, tasks, type State, type TaskFilter, type TaskRoot } from './store.ts'
import { StateMark } from './task.tsx'
import { Header } from './ui.tsx'
import { ago, firstLine, left } from './words.ts'

const filter: TaskFilter = { state: 'all', label: [] }
const lanes = [
  { title: 'Runnable', states: ['ready'] },
  { title: 'In progress', states: ['claimed'] },
  { title: 'Waiting on prerequisites', states: ['waiting'] },
  { title: 'Needs attention', states: ['blocked', 'failed'] },
  { title: 'Delivered', states: ['completed'] },
  { title: 'Canceled', states: ['canceled'] },
]

const titleOf = (root: TaskRoot) => firstLine(root.text).slice(0, 120) || `Task #${root.id}`

function Outcome({ root }: { root: TaskRoot }) {
  const { task } = root
  if (task.state === 'completed') return <p className="handoff-result"><strong>Delivery:</strong> {task.result || 'No result recorded.'}</p>
  if (task.parked) return <p className="handoff-result"><strong>Hold:</strong> {task.parked.reason}</p>
  if (task.blocked) return <p className="handoff-result"><strong>Hold:</strong> {task.blocked.kind && `${task.blocked.kind}: `}{task.blocked.reason}</p>
  if (task.state === 'failed' || task.state === 'canceled') return <p className="handoff-result"><strong>Reason:</strong> {task.reason || 'No reason recorded.'}</p>
  return null
}

function Prerequisite({ id, state, now }: { id: string; state: State; now: number }) {
  const root = state.messages[id]
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (root) return
    let active = true
    void board.loadThread(id).then(() => { if (active) setChecked(true) })
    return () => { active = false }
  }, [id, root])
  const task = root && !root.deleted && isTask(root) ? root : undefined
  return (
    <li>
      <div className="handoff-line">
        <Link to={here({ thread: id })}>{task ? titleOf(task) : `Task #${id}`}</Link>
        {task ? <StateMark state={stateNow(task.task, now)} /> : <small>{root || checked ? 'Prerequisite unavailable' : 'Loading prerequisite…'}</small>}
      </div>
      {task && <Outcome root={task} />}
    </li>
  )
}

function Handoff({ root, state, now }: { root: TaskRoot; state: State; now: number }) {
  const { task } = root
  const current = stateNow(task, now)
  const claim = task.state === 'claimed' ? task.claim : null
  const holder = claim ? nameOf(state, claim.actor) : null
  const step = root.labels.step
  return (
    <li className="handoff">
      <div className="handoff-line">
        <Link className="handoff-title" to={here({ thread: root.id })}>{titleOf(root)}</Link>
        <StateMark state={current} />
        <small>#{root.channel}</small>
        {step && <small>step={step}</small>}
      </div>
      {task.for && <p>Assigned to {nameOf(state, task.for)}</p>}
      {claim && (
        <p>
          {current === 'claimed' ? 'Held by' : 'Expired claim by'} <strong>{holder}</strong>{' '}
          {holder !== claim.actor && <small>({claim.actor}) </small>}· {current === 'claimed' ? 'lease' : 'lease ended'}{' '}
          <RelativeTime iso={claim.until}>{current === 'claimed' ? left(claim.until, now) : `${ago(claim.until, now)} ago`}</RelativeTime>
        </p>
      )}
      <Outcome root={root} />
      {task.needs.length > 0 && (
        <div className="handoff-needs">
          <strong>Requires</strong>
          <ul role="list">{task.needs.map((id) => <Prerequisite key={id} id={id} state={state} now={now} />)}</ul>
        </div>
      )}
    </li>
  )
}

export function Home({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  const [listed, setListed] = useState<Awaited<ReturnType<typeof board.loadTasks>>>()
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => {
    let active = true
    void board.loadTasks(filter).then((page) => { if (active) setListed(page) })
    return () => { active = false }
  }, [])
  const rows = tasks(state, filter, now)
  // Keep each task in the lane where it first appeared on this visit. Its badge and
  // details still read the latest state; leaving Handoffs (or reloading) resets placement.
  const [placement, setPlacement] = useState(() => new Map<string, string>())
  const newcomers = rows.filter(({ id }) => !placement.has(id))
  if (newcomers.length > 0) {
    const next = new Map(placement)
    for (const { id, task } of newcomers) {
      const current = stateNow(task, now)
      next.set(id, lanes.find(({ states }) => states.includes(current))!.title)
    }
    setPlacement(next)
  }
  const status = !listed ? 'Loading tasks…'
    : 'refused' in listed ? `Task list unavailable: ${listed.refused} Showing only tasks already known here.`
    : listed.more ? 'Partial list · More tasks are available.'
    : rows.length === 0 ? 'No tasks known to this view.'
    : null
  return (
    <>
      <Header title="HANDOFFS" lead={lead} live={state.live} />
      <div className="page home-view handoffs-view">
        {status && <div className="home-intro"><p role="status">{status}</p></div>}
        {lanes.map(({ title }, index) => {
          const items = rows.filter(({ id }) => placement.get(id) === title)
          if (items.length === 0) return null
          return (
            <section key={title} className="home-queue" aria-labelledby={`handoff-lane-${index}`}>
              <h2 id={`handoff-lane-${index}`}>{title}</h2>
              <ul className="handoff-list" role="list">{items.map((root) => <Handoff key={root.id} root={root} state={state} now={now} />)}</ul>
            </section>
          )
        })}
        {listed && 'cursor' in listed && listed.more && (
          <div className="home-intro">
            <button type="button" disabled={loadingMore} onClick={async () => {
              setLoadingMore(true)
              const page = await board.loadTasks(filter, listed.cursor)
              if (page) setListed(page)
              setLoadingMore(false)
            }}>{loadingMore ? 'Loading…' : 'Load more tasks'}</button>
          </div>
        )}
      </div>
    </>
  )
}
