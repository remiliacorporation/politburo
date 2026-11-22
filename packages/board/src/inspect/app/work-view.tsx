import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { attentionFor } from './attention-store.ts'
import * as board from './board.ts'
import { useHoldPosition } from './hold-position.ts'
import { Ago, here, Link, navigate, useLocation, useTypeToFocus } from './nav.tsx'
import { keepOrder } from './needs.ts'
import { nameOf, type State } from './store.ts'
import { Header } from './ui.tsx'
import { homeOf, projectWork, workGroupTitle, type WorkGroup, type WorkRow } from './work.ts'

const RULES: Record<WorkGroup, string> = {
  needs: 'A person must answer a request or fix a contract.',
  repair: 'A claim, source, or piece of evidence needs repair.',
  review: 'An open PR has passing checks and no hold.',
  running: 'The board shows an unexpired claim.',
  pull: 'Ready to claim, with no park or blocking overlap.',
  waiting: 'Held, parked, or not ready to claim.',
  done: 'The task is completed, failed, or canceled.',
}

const rowOf = (node: Node | null) =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-work-row]')
const rowKey = (node: Node | null) => rowOf(node)?.dataset.workRow

export function Work({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  useTypeToFocus('main')
  useEffect(board.openNeeds, [])
  const { params, thread } = useLocation()
  const peekId = params.get('peek')
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement>(null)
  const focusPeek = useRef<string | null>(null)
  const pane = useRef<HTMLElement>(null)
  const openPeek = (id: string, from: HTMLElement) => {
    opener.current = from
    if (id === peekId) heading.current?.focus({ preventScroll: true })
    else {
      focusPeek.current = id
      navigate(here({ params: { peek: id } }))
    }
  }
  useLayoutEffect(() => {
    if (focusPeek.current === peekId && peekId !== null) heading.current?.focus({ preventScroll: true })
    focusPeek.current = null
  }, [peekId])
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
  const focused = useRef<HTMLElement>(null)
  const hovered = useRef(false)
  const hoveredKey = useRef<string | undefined>(undefined)
  const selectionInList = () => {
    const selection = document.getSelection()
    return selection && !selection.isCollapsed
      ? [selection.anchorNode, selection.focusNode].filter((node) => list.current?.contains(node))
      : []
  }
  const selected = selectionInList()
  const anchor = rowKey(focused.current) ?? hoveredKey.current ?? selected.map(rowKey).find(Boolean)
  // Keep the slice-1 visual anchor when reading the list alone. With a peek open,
  // leave the shared scroll position (and the independently scrollable pane) alone.
  useHoldPosition(list, peekId === null ? anchor : undefined, 'data-work-row')
  const release = (target: EventTarget | null) => {
    if (hovered.current || (target instanceof Node && list.current?.contains(target))) return
    if (!selectionInList().length) setFrozen(false)
  }
  useEffect(() => {
    const changed = () => {
      if (selectionInList().length) setFrozen(true)
      else release(document.activeElement)
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [])
  const closePeek = () => {
    if (pane.current?.contains(document.activeElement)) {
      const from = opener.current
      ;(from?.isConnected ? from : list.current)?.focus({ preventScroll: true })
    }
    opener.current = null
    navigate(here({ params: { peek: null } }))
  }
  useEffect(() => {
    if (peekId === null || thread !== null) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || list.current?.closest('[inert]')) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="menu"], [role="dialog"]')) return
      closePeek()
    }
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  }, [peekId, thread])
  const rowsById = new Map(latest.rows.map((row) => [row.root.id, row]))
  const groups = latest.groups.filter(({ group }) => group !== 'done').map(({ group, title, rows }) => ({
    group, title, rows: frozen ? keepOrder(rows.map(({ root }) => root), order.current).map(({ id }) => rowsById.get(id)!) : rows,
  }))
  const shown = groups.flatMap(({ rows }) => rows)
  const ids = shown.map(({ root }) => root.id)
  const home = homeOf([...shown, ...latest.rows.filter(({ group }) => group === 'done')], records, now)
  const peeked = peekId === null ? undefined : rowsById.get(peekId)
  useLayoutEffect(() => {
    const before = [...order.current.keys()]
    order.current = new Map(ids.map((id, index) => [id, index]))
    const el = list.current
    const target = focused.current
    const id = rowOf(target)?.dataset.taskId
    if (!el || !target || id === undefined || document.activeElement !== document.body) return
    const index = before.indexOf(id)
    const next = [id, ...before.slice(index + 1), ...before.slice(0, Math.max(0, index)).reverse(), ...ids]
      .find((candidate) => order.current.has(candidate))
    const selector = target.matches('button') ? ' button' : target.matches('a') ? ' a' : ''
    const replacement = next === undefined ? null : el.querySelector<HTMLElement>(`[data-work-row="queue:${CSS.escape(next)}"]${selector}`)
    ;(replacement ?? el).focus({ preventScroll: true })
  })
  const showRow = (row: WorkRow, area: 'home' | 'queue', detail?: ReactNode) => (
    <Row key={row.root.id} {...{ row, state, area, detail, openPeek }} expanded={peekId === row.root.id} />
  )
  const { counts } = home

  return (
    <>
      <Header title="Work" live={state.live} lead={lead} />
      <div className={`page home-view needs-view work-view${peekId === null ? '' : ' with-peek'}`}>
        <p className="work-counts">
          <a href="#work-needs">{counts.needs} need you</a> · <a href="#work-review">{counts.review} ready to review</a> ·{' '}
          <a href="#work-running">{counts.running} running</a> · <a href="#work-health">{counts.expiring} expiring in 30 min</a>
        </p>
        <p role="status">{records ? 'swarm records: seeded fixtures (not live data)' : 'swarm records: none (add ?swarm=fixtures to preview seeded fixtures)'}</p>
        <div className="work-layout">
          <div ref={list} tabIndex={-1} aria-label="Work board tasks" className="work-list"
            onFocus={(event) => {
              focused.current = event.target
              setFrozen(true)
            }}
            onBlur={(event) => {
              focused.current = null
              release(event.relatedTarget)
            }}
            onMouseEnter={() => { hovered.current = true; setFrozen(true) }}
            onMouseOver={(event) => { hoveredKey.current = rowKey(event.target as Node) }}
            onMouseLeave={() => {
              hovered.current = false
              hoveredKey.current = undefined
              release(document.activeElement)
            }}>
            <HomeSection id="work-needs" title="Needs you" empty="nothing needs you" present={!!home.needs.length}>
              <ul role="list">{home.needs.map((row) => showRow(row, 'home'))}</ul>
            </HomeSection>
            <HomeSection id="work-review" title="Ready to review" empty="nothing to review" present={!!home.review.length}>
              <ul role="list">{home.review.map((row) => showRow(row, 'home', <Ago iso={row.root.createdAt} now={now} prefix="open " />))}</ul>
            </HomeSection>
            <HomeSection id="work-running" title="Running now" empty="nothing running" present={!!home.running.length}>
              {home.running.map(({ party, cells }) => (
                <div key={party.id}>
                  <h3><PartyName party={party} /></h3>
                  {cells.map(({ claimant, rows }) => (
                    <div key={claimant}>
                      <h4>{claimant ? nameOf(state, claimant) : 'unclaimed'}</h4>
                      <ul role="list">{rows.map(({ row, liveness }) => showRow(row, 'home', liveness))}</ul>
                    </div>
                  ))}
                </div>
              ))}
            </HomeSection>
            <HomeSection id="work-health" title="Health and spend" empty="no health data" present={!!home.health.perParty.length}>
              <Health health={home.health} />
            </HomeSection>
            <div className="home-queue work-queue">
              <h2>Queue</h2>
              {groups.map(({ group, title, rows }) => (
                <section key={group}>
                  <h3>{title} ({rows.length}) <small>{RULES[group]}</small></h3>
                  <ul role="list">{rows.map((row) => showRow(row, 'queue'))}</ul>
                </section>
              ))}
              {ids.length === 0 && errors.size === 0 && <p role="status">{state.tasksCounted ? 'nothing on the board' : 'loading…'}</p>}
              {[...errors].map((error) => <p key={error} role="status" className="error">{error}</p>)}
            </div>
          </div>
          {peekId !== null && (
            <aside ref={pane} id="work-peek" className="work-peek" aria-label="Work peek">
              {peeked ? <Peek row={peeked} state={state} heading={heading} close={closePeek} /> : <p role="status">no longer on the board</p>}
            </aside>
          )}
        </div>
      </div>
    </>
  )
}

function HomeSection({ id, title, empty, present, children }: {
  id: string; title: string; empty: string; present: boolean; children: ReactNode
}) {
  return (
    <section id={id} className="home-queue" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {present ? children : <p role="status">{empty}</p>}
    </section>
  )
}

function Health({ health: { perParty, total } }: { health: ReturnType<typeof homeOf>['health'] }) {
  const cells = (metrics: typeof total) => (
    <>
      <td>{metrics.active} / {metrics.openClaimLimit ?? 'limit unknown'}</td>
      <td>{metrics.expiring}</td>
      <td>{metrics.stale}</td>
      <td>{metrics.reviewWip}</td>
      <td>{metrics.knownTokens} known · {metrics.unknownTokens} unknown</td>
      <td>{metrics.unknownCoverage}</td>
      <td>{metrics.overlaps}</td>
    </>
  )
  return (
    <table className="work-health">
      <thead><tr>
        {['Party', 'Active / limit', 'Expiring', 'Stale', 'Review WIP', 'Tokens', 'Unknown', 'Overlaps'].map((label) => (
          <th scope="col" key={label}>{label}</th>
        ))}
      </tr></thead>
      <tbody>
        {perParty.map(({ party, ...metrics }) => (
          <tr key={party.id === null ? 'external' : `party:${party.id}`}>
            <th scope="row"><PartyName party={party} /></th>
            {cells({ ...metrics, openClaimLimit: party.openClaimLimit })}
          </tr>
        ))}
      </tbody>
      <tfoot><tr><th scope="row">Repo total</th>{cells(total)}</tr></tfoot>
    </table>
  )
}

const TRACKER = { gh: 'GH#', lin: 'LIN ', bd: 'bd ', native: '#' }

function TrackerBadges({ trackers }: Pick<WorkRow, 'trackers'>) {
  return trackers.map(({ kind, id }) => <span className="label" key={`${kind}:${id}`}>{TRACKER[kind]}{id}</span>)
}

function PartyName({ party }: { party: Pick<NonNullable<WorkRow['party']>, 'name' | 'colour'> | null }) {
  return <span style={party?.colour ? { borderLeft: `3px solid ${party.colour}`, paddingLeft: 4 } : undefined}>{party?.name ?? 'external'}</span>
}

function Peek({ row, state, heading, close }: {
  row: WorkRow; state: State; heading: React.RefObject<HTMLHeadingElement | null>; close: () => void
}) {
  const until = row.root.task.claim?.until
  return (
    <>
      <h2 ref={heading} tabIndex={-1}>{row.title || `Task #${row.root.id}`}</h2>
      <button type="button" onClick={close}>close</button>
      <p>{row.workId} · {workGroupTitle(row.group)} · {row.reason}</p>
      <p><PartyName party={row.party} /> · {row.claimant ? nameOf(state, row.claimant) : 'unclaimed'}</p>
      {until && <p>claim until (board time) <time dateTime={until} title={until}>{until}</time></p>}
      <p>{row.prText}{row.prHead && <> · head <code title={row.prHead}>{row.prHead.slice(0, 7)}</code></>}</p>
      <p>spend {row.spendText}{row.spendText === 'unknown' && row.spend && row.spend.coverage !== 'unknown' && ` · ${row.spend.coverage}`}</p>
      {row.trackers.length > 0 && <p><TrackerBadges trackers={row.trackers} /></p>}
      {row.overlapText && <p>{row.overlapText}</p>}
      <Link to={here({ thread: row.root.id })}>open thread</Link>
    </>
  )
}

export function Row({ row, state, area, detail, expanded, openPeek }: {
  row: WorkRow; state: State; area: 'home' | 'queue'; detail?: ReactNode; expanded: boolean; openPeek: (id: string, from: HTMLElement) => void
}) {
  const { root, party } = row
  return (
    <li data-task-id={root.id} data-work-row={`${area}:${root.id}`} tabIndex={0} onKeyDown={(event) => {
      if (event.key !== ' ' || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target
      if (!(target instanceof HTMLElement) || (target !== event.currentTarget && !target.matches('a'))) return
      event.preventDefault()
      if (!event.repeat) openPeek(root.id, target)
    }}>
      <small>{row.priority}</small>
      <small>{row.workId}</small>
      <Link to={here({ thread: root.id })}>{row.title || `Task #${root.id}`}</Link>
      <small><PartyName party={party} /></small>
      <small>{row.claimant ? nameOf(state, row.claimant) : 'unclaimed'}</small>
      <small>{row.group === 'running' ? detail ?? row.reason : row.reason}</small>
      {row.group !== 'running' && detail && <small>{detail}</small>}
      {row.claimText && <small title={root.task.claim?.until}>{row.claimText}</small>}
      <small>{row.prText}</small>
      <small>{row.spendText === 'unknown' ? 'spend unknown' : row.spendText}</small>
      <TrackerBadges trackers={row.trackers} />
      {row.overlapText && <small>{row.overlapText}</small>}
      <button type="button" aria-expanded={expanded} aria-controls={expanded ? 'work-peek' : undefined} onClick={(event) => openPeek(root.id, event.currentTarget)}>peek</button>
    </li>
  )
}
