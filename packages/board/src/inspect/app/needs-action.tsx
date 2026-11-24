import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as board from './board.ts'
import { lapsed } from './claim-order.ts'
import { Ago, here, Link, useTypeToFocus } from './nav.tsx'
import { keepOrder, needsAction } from './needs.ts'
import type { State, TaskRoot } from './store.ts'
import { Header } from './ui.tsx'
import { firstLine } from './words.ts'

export function NeedsAction({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  useTypeToFocus('main')
  useEffect(board.openNeeds, [])
  const viewer = useMemo(() => state.openTaskMe && board.viewerOf(state.openTaskMe), [state.openTaskMe])
  const latest = useMemo(() => needsAction(state, viewer, now), [state, viewer, now])
  const [frozen, setFrozen] = useState(false)
  const order = useRef(new Map<string, number>())
  const list = useRef<HTMLDivElement>(null)
  const focused = useRef<string | undefined>(undefined)
  const hovered = useRef(false)
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
  // Freeze positions, never membership, grouping, or the contents of a row.
  const shown = (rows: TaskRoot[]) => frozen ? keepOrder(rows, order.current) : rows
  const decisions = shown(latest.decisions), stalled = shown(latest.stalled), ready = shown(latest.ready)
  const ids = [...decisions, ...stalled, ...ready].map(({ id }) => id)
  useLayoutEffect(() => {
    const before = [...order.current.keys()]
    order.current = new Map(ids.map((id, index) => [id, index]))
    const el = list.current
    const id = focused.current
    if (!el || id === undefined || el.contains(document.activeElement)) return
    // A removed or regrouped link loses DOM focus. Restore it without scrolling, but never
    // steal it from someone who has already moved on to another control (e.g. the composer).
    if (document.activeElement !== document.body) return
    const index = before.indexOf(id)
    const next = [id, ...before.slice(index + 1), ...before.slice(0, Math.max(0, index)).reverse(), ...ids]
      .find((candidate) => order.current.has(candidate))
    const link = next === undefined ? null : el.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(next)}"] a`)
    ;(link ?? el).focus({ preventScroll: true })
  })
  const leaseEnded = (root: TaskRoot) => <><Ago iso={root.task.claim!.until} now={now} prefix="lease ended " /> ago</>
  return (
    <>
      <Header title="Needs action" live={state.live} lead={lead} />
      <div className="page home-view needs-view">
        <div ref={list} tabIndex={-1} aria-label="Needs action tasks"
          onFocus={(event) => {
            focused.current = (event.target as HTMLElement).closest<HTMLElement>('[data-task-id]')?.dataset.taskId
            setFrozen(true)
          }}
          onBlur={(event) => {
            focused.current = undefined
            release(event.relatedTarget)
          }}
          onMouseEnter={() => { if (ids.length) { hovered.current = true; setFrozen(true) } }}
          onMouseLeave={() => { hovered.current = false; release(document.activeElement) }}>
          <Group title="Open decisions" rows={decisions} detail={(root) => <Ago iso={root.createdAt} now={now} prefix="open " />} />
          <Group title="Stalled or overdue claims" rows={stalled} detail={leaseEnded} />
          <Group title="Ready work" rows={ready} detail={(root) => lapsed(root, now) ? leaseEnded(root) : root.task.priority ?? 'normal'} />
        </div>
        {ids.length === 0 && latest.errors.length === 0 && <p role="status">{state.tasksCounted ? 'nothing needs anyone' : 'loading…'}</p>}
        {latest.errors.map((error) => <p key={error} role="status" className="error">{error}</p>)}
      </div>
    </>
  )
}

function Group({ title, rows, detail }: { title: string; rows: readonly TaskRoot[]; detail: (root: TaskRoot) => ReactNode }) {
  if (rows.length === 0) return null
  return (
    <section className="home-queue">
      <h2>{title}</h2>
      <ul role="list">
        {rows.map((root) => (
          <li key={root.id} data-task-id={root.id}>
            <Link to={here({ thread: root.id })}>{firstLine(root.text) || `Task #${root.id}`}</Link>
            <small>#{root.channel} · {detail(root)}</small>
          </li>
        ))}
      </ul>
    </section>
  )
}
