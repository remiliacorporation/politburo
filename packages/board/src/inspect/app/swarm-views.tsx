import { useEffect, type ReactNode } from 'react'
import * as board from './board.ts'
import { here, Link, useTypeToFocus, type Where } from './nav.tsx'
import { answerKey, attentionOf, nameOf, type State, type TaskRoot } from './store.ts'
import { answerDisabled, completedOf, mobsOf, phaseOf, queueOf, statusOf, type SwarmScope } from './swarm.ts'
import { Needs } from './task.tsx'
import { Header, nativeMenu } from './ui.tsx'
import { firstLine } from './words.ts'

const row = { padding: '6px 20px', overflowWrap: 'anywhere' } as const
const facts = { gridTemplateColumns: 'max-content minmax(0, 1fr)' }

export function Swarm({ section, state, where, now, lead }: { section: 'queue' | 'mobs'; state: State; where: Where; now: number; lead: ReactNode }) {
  useTypeToFocus('main')
  const channel = where.params.get('channel')
  const needs = where.params.get('needs')
  const scope: SwarmScope = { ...(channel ? { channel } : {}), ...(needs ? { needs } : {}) }
  useEffect(() => board.watchSwarm(section, scope).stop, [channel, needs, section, state.me?.actor])
  const { reads } = state.swarm
  const meta = [section === 'queue' ? 'priority, then assignment, then oldest' : 'leases and bindings', channel && `#${channel}`, needs && `needs #${needs}`].filter(Boolean).join(' · ')
  return (
    <>
      <Header title={section} meta={meta} lead={lead} live={state.live} />
      <div className="page">
        {(['access', 'control', 'open', 'claims'] as const).map((read) => reads[read] && <p key={read} className="empty error">{reads[read].why}</p>)}
        {section === 'queue' ? <Queue state={state} scope={scope} now={now} thread={where.thread} />
          : <Mobs state={state} scope={scope} now={now} thread={where.thread} />}
        {section === 'mobs' && <Completed state={state} scope={scope} now={now} thread={where.thread} />}
      </div>
    </>
  )
}

function TaskLink({ root, current }: { root: TaskRoot; current: boolean }) {
  return (
    <Link to={here({ thread: root.id })} current={current} className="text-link">
      <span style={{ whiteSpace: 'normal' }}>#{root.id} {firstLine(root.text) || root.attachments?.map((file) => file.name).join(', ') || 'task'}</span>
    </Link>
  )
}

function LeaseUntil({ until }: { until: string }) {
  return <time dateTime={until}>{new Date(until).toLocaleString()}</time>
}

type LensProps = { state: State; scope: SwarmScope; now: number; thread: string | null }

function Queue({ state, scope, now, thread }: LensProps) {
  const queue = queueOf(state, scope, now)
  if (Object.values(queue).every((rows) => rows.length === 0)) return <NoOpen state={state}>no ready, claimed, held or parked tasks</NoOpen>
  return Object.entries(queue).map(([group, tasks]) => tasks.length > 0 && (
    <section key={group}>
      <h3>{group}</h3>
      {tasks.map((root) => {
        const { task } = root
        return (
          <article style={row} key={root.id} {...nativeMenu}>
            <TaskLink root={root} current={thread === root.id} />
            <div className="task-note">
              #{root.channel} · {task.priority} priority
              {task.for && ` · for ${nameOf(state, task.for)}`}
              {group === 'ready' && task.state === 'claimed' && (task.claim && Date.parse(task.claim.until) <= now ? ' · lease ran out' : ' · claim no longer holds')}
              {group === 'claimed' && task.claim && <> · claimed by {nameOf(state, task.claim.actor)} · lease until <LeaseUntil until={task.claim.until} /></>}
            </div>
            {task.needs.length > 0 && <div>needs <Needs ids={task.needs} state={state} /></div>}
            {group !== 'decisions' && task.blocked && <div className="task-note">held: {task.blocked.kind && `${task.blocked.kind} · `}{task.blocked.reason}</div>}
            {group === 'parked' && task.parked && <div className="task-note">parked: {task.parked.reason}</div>}
            {group === 'decisions' && <Decision root={root} state={state} now={now} />}
          </article>
        )
      })}
    </section>
  ))
}

/** A structured hold, including the question on its task when the decision read is unavailable. */
export function Decision({ root, state, now }: { root: TaskRoot; state: State; now: number }) {
  const id = root.task.attentionId
  const read = attentionOf(state, root)
  useEffect(() => {
    if (id && (read?.version !== root.version || read.error)) void board.loadSwarmAttention(root)
  }, [root.id, root.version, id, state.me?.actor])
  if (!id) return null
  const error = read?.error
  const attention = read?.attention
  if (!attention || (read.closed && (attention.status === 'pending' || attention.status === 'stale'))) {
    return (
      <section className="ask" style={{ marginTop: 6 }}>
        <strong>decision{error?.status === 501 ? ' · read only' : ''}</strong>
        {!read?.closed && root.task.blocked && <div className="task-note">{root.task.blocked.reason}</div>}
        {error ? <div className="error-text">{error.why}</div> : !read?.closed && <div>loading decision…</div>}
      </section>
    )
  }
  const status = statusOf(state, root, attention, now)
  const why = answerDisabled(state, root, attention, now)
  const answer = state.me && state.swarm.answers[answerKey(state.me.actor, root.id, id)]
  const refused = answer?.is === 'failed' ? answer : null
  const readOnly = error?.status === 501 || refused?.status === 501
  const buttons = !readOnly && status !== 'answered' && status !== 'canceled'
  return (
    <section className="ask" style={{ marginTop: 6 }}>
      <strong>decision · {status}{readOnly ? ' · read only' : ''}</strong>
      <div className="task-note">{attention.question}</div>
      {attention.context && <div className="task-note">{attention.context}</div>}
      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
        {attention.options.map(({ id: option, label, consequence }) => (
          <li key={option} style={{ marginBottom: 4 }}>
            {buttons ? (
              <button
                type="button"
                className="act"
                style={{ whiteSpace: 'normal', height: 'auto', minHeight: 26, textAlign: 'left' }}
                disabled={why !== null}
                onClick={() => void board.answerSwarmAttention(root, attention, option)}
              >{label}</button>
            ) : <strong>{label}</strong>}
            <div className="task-note">{consequence}</div>
          </li>
        ))}
      </ul>
      {buttons && <p className="hint" role="status">{why ?? 'only a configured responder can answer; the board checks your choice'}</p>}
      {error && (!buttons || error.why !== why) && <div className="error-text" role="status">{error.why}</div>}
      {refused && (!buttons || refused.why !== why) && <div className="error-text" role="status">{refused.why}</div>}
      {attention.status === 'answered' && (
        <div>answered {attention.options.find(({ id }) => id === attention.receipt.option)?.label ?? attention.receipt.option} by {nameOf(state, attention.receipt.by.actor)} · task {attention.receipt.routedTo}</div>
      )}
    </section>
  )
}

function NoOpen({ state, children }: { state: State; children: ReactNode }) {
  const read = state.swarm.reads.open
  return read ? null : <p className="empty">{read === undefined ? 'loading tasks…' : children}</p>
}

function Mobs({ state, scope, now, thread }: LensProps) {
  const mobs = mobsOf(state, scope, now)
  if (mobs.length === 0) return <NoOpen state={state}>no claimed work</NoOpen>
  return mobs.map(({ key, session, branch, work }) => (
    <section key={key}>
      <h3>{session ?? 'unbound claim'}</h3>
      <div style={row}>
        <dl className="facts" style={facts}>
          <dt>session</dt><dd>{session}</dd>
          <dt>branch</dt><dd>{branch}</dd>
        </dl>
        {session === null && <div className="hint">{state.discovery && state.discovery.task_authority !== true ? 'this board does not advertise task bindings (no_task_authority)' : 'no binding recorded for this claim'}</div>}
      </div>
      {work.map(({ root, claim, phase }) => (
        <article style={row} key={root.id} {...nativeMenu}>
          <TaskLink root={root} current={thread === root.id} />
          <dl className="facts" style={facts}>
            <dt>phase</dt><dd>{phase}</dd>
            <dt>claimed by</dt><dd>{nameOf(state, claim.actor)}</dd>
            <dt>lease until</dt><dd><LeaseUntil until={claim.until} /></dd>
            <dt>last handoff</dt>
            <dd>{root.task.handoff ? <>{root.task.handoff.packetPath} at <code>{root.task.handoff.commit}</code><br />SHA-256 <code>{root.task.handoff.sha256}</code></> : 'none recorded'}</dd>
          </dl>
        </article>
      ))}
    </section>
  ))
}

function Completed({ state, scope, now, thread }: LensProps) {
  const read = state.swarm.reads.completed
  const roots = completedOf(state, scope, now)
  if (read === null && roots.length === 0) return null
  return (
    <section>
      <h3>recent completed tasks</h3>
      {read && <p className="empty error">{read.why}</p>}
      {read === undefined && roots.length === 0 && <p className="empty">loading completed tasks…</p>}
      {roots.map((root) => (
        <article style={row} key={root.id} {...nativeMenu}>
          <TaskLink root={root} current={thread === root.id} /> · {phaseOf(state, root, now)}
          {root.task.result && <div className="task-note">{root.task.result}</div>}
        </article>
      ))}
    </section>
  )
}
