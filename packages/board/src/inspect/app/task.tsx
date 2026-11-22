import { Circle, CircleCheck, CircleDashed, CircleDot, CirclePause, CircleSlash, CircleX, Ellipsis } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import type { AttentionView } from '../../api/routes.ts'
import { TaskPriority } from '../../contract/schemas.ts'
import * as board from './board.ts'
import { toast } from './chrome.ts'
import { here, Link, RelativeTime } from './nav.tsx'
import { isTask, moves, nameOf, profilesOf, stateNow, type State, type TaskRoot, type TaskState, type Viewer } from './store.ts'
import { AskForm, Menu, MenuItem, MenuSeparator, nativeMenu, Panel, type AskProps } from './ui.tsx'
import { firstLine, left, refusal } from './words.ts'

// A task is a thread with a state, so it shows as one more line on its root: the state, who holds
// it and for how long, who it's for, what it waits for, and how it ended. The thread pane shows the
// same in full, with what you can do to it.

const MARKS: Record<TaskState, typeof Circle> = {
  waiting: CircleDashed,
  ready: Circle,
  claimed: CircleDot,
  blocked: CirclePause,
  completed: CircleCheck,
  failed: CircleX,
  canceled: CircleSlash,
}

export function StateMark({ state }: { state: TaskState }) {
  const Icon = MARKS[state]
  return (
    <span className={`task-state ${state}`}>
      <Icon size={13} strokeWidth={2} />
      {state}
    </span>
  )
}

/** The time now, read again the moment a lease ends, so a claim that lapses shows as over without a reload. */
export function useLapse(until: string | undefined): number {
  const [, again] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (until === undefined) return
    const left = Date.parse(until) - Date.now()
    if (left <= 0) return
    // A timer takes at most 2^31 ms; no lease is that long.
    const timer = setTimeout(again, Math.min(left + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [until])
  return Date.now()
}

/** What's left of a lease, counted down a second at a time. */
export function Lease({ until }: { until: string }) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [])
  return <RelativeTime iso={until} className="lease">{left(until)}</RelativeTime>
}

/** The tasks one waits for, each a link to its thread, with its state where the page has it. */
export function Needs({ ids, state }: { ids: string[]; state: State }) {
  return (
    <span className="needs">
      {ids.map((id) => {
        const need = state.messages[id]
        return (
          <Link key={id} to={here({ thread: id })} className="need" title={need ? firstLine(need.text) : `#${id}`}>
            #{id}
            {isTask(need) && <span className={`need-state ${stateNow(need.task, Date.now())}`}>{stateNow(need.task, Date.now())}</span>}
          </Link>
        )
      })}
    </span>
  )
}

/** A task in a line, under its root. */
export function TaskLine({ root, state }: { root: TaskRoot; state: State }) {
  const { task } = root
  const now = useLapse(task.claim?.until)
  const current = stateNow(task, now)
  const lapsed = task.state === 'claimed' && current !== 'claimed'
  const finished = current === 'completed' || current === 'failed' || current === 'canceled'
  return (
    <div className="task-line" {...nativeMenu}>
      <StateMark state={current} />
      {current === 'claimed' && task.claim && (
        <>
          <span>by {nameOf(state, task.claim.actor)}</span>
          <Lease until={task.claim.until} />
        </>
      )}
      {lapsed && <span>lease ran out</span>}
      {task.for && !finished && <span>for {nameOf(state, task.for)}</span>}
      {task.needs.length > 0 && !finished && (
        <span>
          needs <Needs ids={task.needs} state={state} />
        </span>
      )}
      {current === 'blocked' && task.parked && <span className="task-note">parked: {task.parked.reason}</span>}
      {current === 'blocked' && task.blocked && (
        <span className="task-note">
          {task.blocked.kind ? `${task.blocked.kind}: ` : ''}
          {task.blocked.reason}
        </span>
      )}
      {current === 'completed' && task.result && <span className="task-note">{task.result}</span>}
      {(current === 'failed' || current === 'canceled') && task.reason && <span className="task-note">{task.reason}</span>}
    </div>
  )
}

/** A profile's actor under a principal, as the board writes one: the profile in lowercase. */
export const actorFor = (principal: string, profile: string) => `${principal}+${profile.trim().toLowerCase()}`

/** `#17 19, 21` as task IDs. */
export const taskIds = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((id) => id.replace(/^#/, '')).filter(Boolean))]

const HOLD_KINDS = ['needs_input', 'awaiting_approval']

/** What a task's card asks about before it acts. */
type Asked = 'park' | 'unpark' | 'block' | 'assign' | 'priority' | 'cancel'

/** A task in full, at the top of its thread: its facts, and what you can do to it now. */
export function TaskCard({ root, state, viewer }: { root: TaskRoot; state: State; viewer: Viewer }) {
  const { task } = root
  const now = useLapse(task.claim?.until)
  const current = stateNow(task, now)
  const lapsed = task.state === 'claimed' && current !== 'claimed'
  const can = moves(state, root, viewer, now)
  const [busy, setBusy] = useState(false)
  const run = (write: Promise<unknown>) => {
    setBusy(true)
    void write.finally(() => setBusy(false))
  }
  // What it waits for may be anywhere on the board: each need's thread says its state.
  const needs = task.needs.join(' ')
  useEffect(() => {
    for (const id of task.needs) if (!board.getState().messages[id]) void board.loadThread(id)
  }, [needs])

  // What you'd most likely do next is a button; everything else is in one menu, and asks in the same place.
  const [asking, setAsking] = useState<Asked | null>(null)
  const acts = useRef<HTMLDivElement>(null)
  const next: ReactNode[] = []
  if (can.answer) next.push(<Answer key={task.attentionId} task={root.id} request={task.attentionId!} />)
  if (can.unpark) next.push(
    <button key="unpark" className="act primary" disabled={busy} onClick={() => setAsking('unpark')}>unpark…</button>,
  )
  if (can.unblock)
    next.push(
      <button key="unblock" className="act primary" disabled={busy} onClick={() => run(board.unblockTask(root.id))}>
        unblock
      </button>,
    )
  if (can.reopen)
    next.push(
      <button key="reopen" className="act primary" disabled={busy} title="make it ready again, in place" onClick={() => run(board.reopenTask(root.id))}>
        reopen
      </button>,
    )
  const more: ReactNode[] = []
  if (can.park) more.push(<MenuItem key="park" onClick={() => setAsking('park')}>park…</MenuItem>)
  if (can.priority) more.push(<MenuItem key="priority" onClick={() => setAsking('priority')}>change priority…</MenuItem>)
  if (can.hold)
    more.push(
      <MenuItem key="block" onClick={() => setAsking('block')}>
        block for a person…
      </MenuItem>,
    )
  if (can.assign)
    more.push(
      <MenuItem key="assign" onClick={() => setAsking('assign')}>
        assign…
      </MenuItem>,
    )
  if (can.assign && task.for !== null)
    more.push(
      <MenuItem key="pool" onClick={() => run(board.assignTask(root.id, null))}>
        back to the pool
      </MenuItem>,
    )
  if (can.cancel)
    more.push(
      <MenuSeparator key="separator" />,
      <MenuItem key="cancel" danger onClick={() => setAsking('cancel')}>
        cancel the task…
      </MenuItem>,
    )
  const asks: Record<Exclude<Asked, 'priority'>, { title: string } & AskProps> = {
    park: {
      title: 'park the task',
      submit: 'park',
      note: current === 'claimed' ? "Ends its holder's claim." : undefined,
      fields: [{ name: 'reason', placeholder: 'why it should wait', required: true }],
      onSubmit: ({ reason }) => run(board.parkTask(root.id, reason!)),
    },
    unpark: {
      title: 'unpark the task',
      submit: 'unpark',
      fields: [{ name: 'reason', placeholder: 'why it can go ahead', required: true }],
      onSubmit: ({ reason }) => run(board.unparkTask(root.id, reason!)),
    },
    block: {
      title: 'hold it for a person',
      submit: 'block',
      fields: [
        { name: 'kind', placeholder: 'kind, e.g. needs_input (optional)', items: HOLD_KINDS },
        { name: 'reason', placeholder: 'what a person has to answer', required: true, long: true },
      ],
      onSubmit: ({ kind, reason }) => run(board.blockTask(root.id, reason!, kind || undefined)),
    },
    assign: {
      title: `assign it to one of ${nameOf(state, task.owner)}'s profiles`,
      submit: 'assign',
      note: 'Only that profile claims it then.',
      fields: [{ name: 'profile', placeholder: 'profile, e.g. fixer', required: true, items: profilesOf(state, task.owner) }],
      onSubmit: ({ profile }) => run(board.assignTask(root.id, actorFor(task.owner, profile!))),
    },
    cancel: {
      title: 'cancel it',
      submit: 'cancel the task',
      note: current === 'claimed' ? "Ends its holder's claim." : undefined,
      fields: [{ name: 'reason', placeholder: "why it's no longer wanted", required: true, long: true }],
      onSubmit: ({ reason }) => run(board.cancelTask(root.id, reason!)),
    },
  }

  return (
    <section className="task-card">
      <div className="task-head" {...nativeMenu}>
        <StateMark state={current} />
        {current === 'claimed' && task.claim && (
          <>
            <span>by {nameOf(state, task.claim.actor)}</span>
            <Lease until={task.claim.until} />
          </>
        )}
        {lapsed && task.claim && <span>{nameOf(state, task.claim.actor)}'s lease ran out</span>}
      </div>
      <dl className="facts" {...nativeMenu}>
        <dt>owner</dt>
        <dd>{nameOf(state, task.owner)}</dd>
        <dt>priority</dt>
        <dd>{task.priority}</dd>
        {task.for && (
          <>
            <dt>for</dt>
            <dd>{nameOf(state, task.for)}</dd>
          </>
        )}
        {task.needs.length > 0 && (
          <>
            <dt>needs</dt>
            <dd>
              <Needs ids={task.needs} state={state} />
            </dd>
          </>
        )}
        {task.parked && (
          <>
            <dt>parked</dt>
            <dd>{task.parked.reason}</dd>
          </>
        )}
        {task.blocked && (
          <>
            <dt>held</dt>
            <dd>
              {task.blocked.kind && <span className="badge">{task.blocked.kind}</span>} {task.blocked.reason}
            </dd>
          </>
        )}
        {task.result && (
          <>
            <dt>result</dt>
            <dd>{task.result}</dd>
          </>
        )}
        {task.reason && (
          <>
            <dt>reason</dt>
            <dd>{task.reason}</dd>
          </>
        )}
      </dl>
      {(next.length > 0 || more.length > 0) && (
        <div className="acts" ref={acts}>
          {next}
          {more.length > 0 && (
            <Menu className="act" title="more" trigger={<Ellipsis size={14} strokeWidth={1.75} />}>
              {more}
            </Menu>
          )}
        </div>
      )}
      {asking && (
        <Panel title={asking === 'priority' ? 'change priority' : asks[asking].title} open onOpenChange={(open) => !open && setAsking(null)} anchor={acts}>
          {asking === 'priority' ? (
            <form className="ask" onSubmit={(event) => {
              event.preventDefault()
              const priority = TaskPriority.parse(new FormData(event.currentTarget).get('priority'))
              run(board.prioritizeTask(root.id, priority))
              setAsking(null)
            }}>
              <select name="priority" aria-label="priority" defaultValue={task.priority}>
                {TaskPriority.options.map((priority) => <option key={priority}>{priority}</option>)}
              </select>
              <button className="send small" disabled={busy}>set priority</button>
            </form>
          ) : <AskForm {...asks[asking]} disabled={busy} onDone={() => setAsking(null)} />}
        </Panel>
      )}
    </section>
  )
}

/** Show the board's choices for this request and submit the selected one against its exact commit. */
function Answer({ task, request }: { task: string; request: string }) {
  const [open, setOpen] = useState(false)
  const [attention, setAttention] = useState<AttentionView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    let current = true
    setAttention(null)
    setProblem(null)
    void board.loadAttention(task).then((result) => {
      if (!current || !result) return
      const { attention } = result
      if (attention?.id === request && attention.status === 'pending') setAttention(attention)
      else setProblem('this request is no longer awaiting an answer')
    }, (error) => { if (current) setProblem(refusal(error)) })
    return () => { current = false }
  }, [open, task, request])
  return (
    <Panel title="answer the task" trigger="answer…" triggerClass="act primary" open={open} onOpenChange={setOpen}>
      {attention ? (
        <form className="ask" onSubmit={(event) => {
          event.preventDefault()
          const option = new FormData(event.currentTarget).get('option')?.toString()
          if (!option || busy) return
          setBusy(true)
          void board.answerTask(task, request, { option, commit: attention.commit }).then((ok) => {
            if (ok) setOpen(false)
          }).catch((error) => toast(refusal(error))).finally(() => setBusy(false))
        }}>
          <strong>{attention.question}</strong>
          {attention.context && <p>{attention.context}</p>}
          {attention.options.map((option) => (
            <label key={option.id}>
              <input type="radio" name="option" value={option.id} required /> {option.label} · {option.consequence}
            </label>
          ))}
          <button className="send small" disabled={busy}>answer</button>
        </form>
      ) : <p className="hint">{problem ?? 'loading…'}</p>}
    </Panel>
  )
}
