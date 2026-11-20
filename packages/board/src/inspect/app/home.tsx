import { useEffect, useState, type ReactNode } from 'react'
import * as board from './board.ts'
import { here, Link } from './nav.tsx'
import { isTask, nameOf, stateNow, tasks, type State, type TaskFilter, type TaskRoot } from './store.ts'
import { StateMark, useLapse } from './task.tsx'
import { Header } from './ui.tsx'
import { firstLine } from './words.ts'

const filter: TaskFilter = { state: 'all', label: [] }
const titleOf = (root: TaskRoot) => firstLine(root.text).slice(0, 120) || `Task #${root.id}`

function TaskDetails({ root, state, now }: { root: TaskRoot; state: State; now: number }) {
  const { task } = root
  if (task.state === 'claimed' && task.claim) {
    const { actor, until } = task.claim
    const live = stateNow(task, now) === 'claimed'
    return (
      <p>
        {live ? 'Held by' : 'Expired claim by'} <strong>{nameOf(state, actor)}</strong>{' '}
        <small>({actor})</small> · {live ? 'Lease until' : 'Lease ended'}{' '}
        <time dateTime={until}>{new Date(until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })}</time>
      </p>
    )
  }
  if (task.state === 'completed') return <p className="handoff-result"><strong>Delivery:</strong> {task.result ?? 'No result recorded.'}</p>
  if (task.blocked) return <p className="handoff-result"><strong>Hold:</strong> {task.blocked.kind && `${task.blocked.kind}: `}{task.blocked.reason}</p>
  if (task.reason) return <p className="handoff-result"><strong>Reason:</strong> {task.reason}</p>
  return null
}

function Prerequisite({ id, state, now }: { id: string; state: State; now: number }) {
  // Only use roots already in the task pages or feed. The handle has no root-only task read,
  // and a thread can be arbitrarily long. Open the link to read it on purpose.
  const root = Object.hasOwn(state.messages, id) ? state.messages[id] : undefined
  const task = isTask(root) && !root.deleted ? root : undefined
  return (
    <li>
      <div className="handoff-line">
        <Link to={here({ thread: id })}>{task ? titleOf(task) : `Task #${id}`}</Link>
        {task ? <StateMark state={stateNow(task.task, now)} /> : <small>{root?.deleted ? 'Deleted' : root ? 'No task details' : 'Open thread for details'}</small>}
      </div>
      {task && <TaskDetails root={task} state={state} now={now} />}
    </li>
  )
}

function Handoff({ root, state, now }: { root: TaskRoot; state: State; now: number }) {
  const { task } = root
  return (
    <li className="handoff">
      <div className="handoff-line">
        <Link className="handoff-title" to={here({ thread: root.id })}>{titleOf(root)}</Link>
        <StateMark state={stateNow(task, now)} />
        <small>#{root.channel}</small>
      </div>
      {task.for && <p>Assigned to {nameOf(state, task.for)}</p>}
      <TaskDetails root={root} state={state} now={now} />
      {task.needs.length > 0 && (
        <div className="handoff-needs">
          <strong>Requires</strong>
          <ul role="list" aria-label="Prerequisites">{[...new Set(task.needs)].map((id) => <Prerequisite key={id} id={id} state={state} now={now} />)}</ul>
        </div>
      )}
    </li>
  )
}

type TaskRead = { after?: string }
type TaskPage = Awaited<ReturnType<typeof board.loadTasks>>

export function Home({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  const [request, setRequest] = useState<TaskRead | null>(null)
  const [answer, setAnswer] = useState<{ request: TaskRead | null; page: TaskPage }>()
  useEffect(() => {
    let active = true
    // The roots merge by version in the shared store. Only this view owns its paging cursor.
    void board.loadTasks(filter, request?.after).then((page) => { if (active) setAnswer({ request, page }) })
    return () => { active = false }
  }, [request])

  const loading = answer?.request !== request
  const page = answer?.page
  const refused = page && 'refused' in page ? page : undefined
  const more = page && 'cursor' in page && page.more
  const next = more ? { after: page.cursor } : refused?.retry === 'same' ? { after: request?.after } : refused?.retry === 'first' ? {} : null
  // Once used, keep the same pager focusable through a read, a refusal, or the end.
  const showPager = request !== null || next !== null
  // Keep the links in one list: a claim or delivery updates a row, not its position or focus.
  const rows = tasks(state, filter, now)
  // One timer for the next lease to end, not one per row (or per reference to it).
  const clock = Math.max(now, Date.now())
  let expires: string | undefined
  for (const { task } of rows) {
    const until = task.state === 'claimed' ? task.claim?.until : undefined
    if (until && Date.parse(until) > clock && (!expires || Date.parse(until) < Date.parse(expires))) expires = until
  }
  const current = Math.max(clock, useLapse(expires))

  return (
    <>
      <Header title="Handoffs" lead={lead} live={state.live} />
      <div className="page home-view handoffs-view">
        <div className="home-intro">
          <p>Follow work from its prerequisites to delivery. Open a task thread for the brief and evidence. Delivery is not approval.</p>
          <Link to="/tasks?state=all">Browse Tasks</Link>
        </div>
        {rows.length > 0 && (
          <section className="home-queue" aria-labelledby="handoff-tasks">
            <h2 id="handoff-tasks">Tasks</h2>
            <ul className="handoff-list" role="list">{rows.map((root) => <Handoff key={root.id} root={root} state={state} now={current} />)}</ul>
          </section>
        )}
        <div className="home-intro">
          <p role="status">{loading ? 'Loading tasks…' : refused ? (
            <>Task list unavailable: {refused.refused}{rows.length > 0 && ' Showing tasks already loaded.'}</>
          ) : more ? 'Partial list · More tasks are available.' : rows.length === 0 ? 'No tasks.' : request ? 'End of task list.' : null}</p>
          {showPager && (
            <button type="button" aria-disabled={loading || !next} onClick={() => {
              if (!loading && next) setRequest(next)
            }}>{refused && next ? 'Retry task list' : 'Load more tasks'}</button>
          )}
        </div>
      </div>
    </>
  )
}
