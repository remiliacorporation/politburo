import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { attentionFor } from './attention-store.ts'
import * as board from './board.ts'
import { useHoldPosition } from './hold-position.ts'
import { here, Link, useTypeToFocus } from './nav.tsx'
import { keepOrder } from './needs.ts'
import { nameOf, type State } from './store.ts'
import { Header } from './ui.tsx'
import { projectWork, type WorkGroup, type WorkRow } from './work.ts'

const RULES: Record<WorkGroup, string> = {
  needs: 'A person must answer a request or fix a contract.',
  repair: 'A claim, source, or piece of evidence needs repair.',
  review: 'An open PR has passing checks and no hold.',
  running: 'The board shows an unexpired claim.',
  pull: 'Ready to claim, with no park or blocking overlap.',
  waiting: 'Held, parked, or not ready to claim.',
  done: 'The task is completed, failed, or canceled.',
}

const taskIdOf = (node: Node | null) =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId

export function Work({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  useTypeToFocus('main')
  useEffect(board.openNeeds, [])
  const records = board.swarmRecords()
  const viewer = useMemo(() => state.openTaskMe && board.viewerOf(state.openTaskMe), [state.openTaskMe])
  const latest = useMemo(() => projectWork(state, records, viewer, now), [state, records, viewer, now])
  const errors = new Set(viewer ? Object.values(state.openTaskAttentionRefusals) : [])
  if (state.tasksRefused !== null) errors.add(state.tasksRefused)
  for (const { root } of latest.rows) {
    const { readError } = attentionFor(state, root, viewer)
    if (readError !== null) errors.add(readError)
  }

  // As in Needs action, freeze the surviving rows' order within each group while reading;
  // membership, grouping and text keep updating. Restore focus when a link moves groups.
  const [frozen, setFrozen] = useState(false)
  const order = useRef(new Map<string, number>())
  const list = useRef<HTMLDivElement>(null)
  const focused = useRef<string | undefined>(undefined)
  const hovered = useRef(false)
  const hoveredId = useRef<string | undefined>(undefined)
  const selection = list.current?.ownerDocument.getSelection()
  const selectedId = selection && !selection.isCollapsed
    ? [selection.anchorNode, selection.focusNode].map((node) => list.current?.contains(node) ? taskIdOf(node) : undefined).find(Boolean)
    : undefined
  useHoldPosition(list, focused.current ?? hoveredId.current ?? selectedId)
  const release = (target: EventTarget | null) => {
    const el = list.current
    if (!el || hovered.current || (target instanceof Node && el.contains(target))) return
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed && (el.contains(selection.anchorNode) || el.contains(selection.focusNode))) return
    setFrozen(false)
  }
  useEffect(() => {
    const changed = () => release(document.activeElement)
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [])
  const rowsById = new Map(latest.rows.map((row) => [row.root.id, row]))
  const groups = latest.groups.filter(({ group }) => group !== 'done').map(({ group, title, rows }) => ({
    group, title, rows: frozen ? keepOrder(rows.map(({ root }) => root), order.current).map(({ id }) => rowsById.get(id)!) : rows,
  }))
  const ids = groups.flatMap(({ rows }) => rows.map(({ root }) => root.id))
  useLayoutEffect(() => {
    const before = [...order.current.keys()]
    order.current = new Map(ids.map((id, index) => [id, index]))
    const el = list.current
    const id = focused.current
    if (!el || id === undefined || document.activeElement !== document.body) return
    const index = before.indexOf(id)
    const next = [id, ...before.slice(index + 1), ...before.slice(0, Math.max(0, index)).reverse(), ...ids]
      .find((candidate) => order.current.has(candidate))
    const link = next === undefined ? null : el.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(next)}"] a`)
    ;(link ?? el).focus({ preventScroll: true })
  })

  return (
    <>
      <Header title="Work" live={state.live} lead={lead} />
      <div className="page home-view needs-view work-view">
        <p role="status">{records ? 'swarm records: seeded fixtures (not live data)' : 'swarm records: none (add ?swarm=fixtures to preview seeded fixtures)'}</p>
        <div ref={list} tabIndex={-1} aria-label="Work board tasks"
          onFocus={(event) => {
            focused.current = taskIdOf(event.target)
            setFrozen(true)
          }}
          onBlur={(event) => {
            focused.current = undefined
            release(event.relatedTarget)
          }}
          onMouseEnter={() => { hovered.current = true; setFrozen(true) }}
          onMouseOver={(event) => { hoveredId.current = taskIdOf(event.target as Node) }}
          onMouseLeave={() => {
            hovered.current = false
            hoveredId.current = undefined
            release(document.activeElement)
          }}>
          {groups.map(({ group, title, rows }) => (
            <section key={group} className="home-queue">
              <h2>{title} ({rows.length}) <small>{RULES[group]}</small></h2>
              <ul role="list">
                {rows.map((row) => <Row key={row.root.id} row={row} state={state} />)}
              </ul>
            </section>
          ))}
        </div>
        {ids.length === 0 && errors.size === 0 && <p role="status">{state.tasksCounted ? 'nothing on the board' : 'loading…'}</p>}
        {[...errors].map((error) => <p key={error} role="status" className="error">{error}</p>)}
      </div>
    </>
  )
}

const TRACKER = { gh: 'GH#', lin: 'LIN ', bd: 'bd ', native: '#' }

function Row({ row, state }: { row: WorkRow; state: State }) {
  const { root, party } = row
  return (
    <li data-task-id={root.id}>
      <small>{row.priority}</small>
      <small>{row.workId}</small>
      <Link to={here({ thread: root.id })}>{row.title || `Task #${root.id}`}</Link>
      <small style={party?.colour ? { borderLeft: `3px solid ${party.colour}`, paddingLeft: 4 } : undefined}>{party?.name ?? 'external'}</small>
      <small>{row.claimant ? nameOf(state, row.claimant) : 'unclaimed'}</small>
      <small>{row.reason}</small>
      {row.claimText && <small title={root.task.claim?.until}>{row.claimText}</small>}
      <small>{row.prText}</small>
      <small>{row.spendText === 'unknown' ? 'spend unknown' : row.spendText}</small>
      {row.trackers.map(({ kind, id }) => <span className="label" key={`${kind}:${id}`}>{TRACKER[kind]}{id}</span>)}
      {row.overlapText && <small>{row.overlapText}</small>}
    </li>
  )
}
