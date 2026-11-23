import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { attentionFor } from './attention-store.ts'
import * as board from './board.ts'
import { useHoldPosition } from './hold-position.ts'
import { Ago, here, isTypingTarget, Link, navigate, useLocation } from './nav.tsx'
import { keepOrder } from './needs.ts'
import { nameOf, type State } from './store.ts'
import { Header } from './ui.tsx'
import { filterParams, filterWork, readFilter, SAVED_VIEWS } from './work-filter.ts'
import { keyAction } from './work-keys.ts'
import { workScope, workScopeUrl, type WorkRoute } from './work-scope.ts'
import { homeOf, labelsOf, projectWork, workGroupTitle, type WorkGroup, type WorkRow } from './work.ts'
import { boardWords } from './words.ts'

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
const queueRow = (id: string) => `[data-work-row="queue:${CSS.escape(id)}"]`

type WorkView = keyof typeof SAVED_VIEWS
const viewOf = (key: string | null): WorkView => key && Object.hasOwn(SAVED_VIEWS, key) ? key as WorkView : 'operations'

function webUrl(raw?: string): string | undefined {
  if (!raw) return
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch { /* Not an absolute link. */ }
}

export function Work({ state, now, lead, route }: { state: State; now: number; lead: ReactNode; route: WorkRoute }) {
  useEffect(board.openNeeds, [])
  const { params, thread } = useLocation()
  const records = board.swarmRecords()
  const where = boardWords(state.discovery)
  const { party, partyId, title, subtitle } = workScope(route, params, records, where.name)
  const repoView = route.view === 'presidium'
  const cellView = route.view === 'cell'
  const allParties = params.get('parties') === 'all'
  const parentParty = cellView ? params.get('party') ?? partyId : partyId
  const scopedParty = route.view === 'party' || (repoView && !allParties) ? partyId : null
  const unknownParty = route.view === 'party' && !party
  const peekId = params.get('peek')
  // In repo and mob views, `party` chooses the repo view rather than filtering its rows.
  const filterPartyKey = repoView || cellView ? 'filterParty' : 'party'
  const filterQuery = new URLSearchParams(params)
  filterQuery.delete('party')
  const partyFacet = params.get(filterPartyKey)
  if (partyFacet !== null) filterQuery.set('party', partyFacet)
  const urlFilter = readFilter(filterQuery)
  const [text, setText] = useState(urlFilter.text)
  // Only URL navigation can resync this draft, not a new board snapshot.
  useEffect(() => setText(urlFilter.text), [urlFilter.text])
  const filter = { ...urlFilter, text }
  const chips = [...filterParams({ ...filter, text: '' })]
  const view = viewOf(params.get('view'))
  const viewGroups: readonly WorkGroup[] = SAVED_VIEWS[view].groups
  const inView = (group: WorkGroup) => viewGroups.includes(group) && (!filter.group || filter.group === group)
  const filtering = view !== 'operations' || text.trim() !== '' || chips.length > 0
  const showEmpty = params.get('show') === 'empty'
  const comfortable = params.get('density') === 'comfortable'
  const field = useRef<HTMLInputElement>(null)
  const pending = useRef<string | null>(null)
  const [help, setHelp] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<WorkGroup>>(() => new Set())
  const [selection, setSelection] = useState<string | null>(null)
  const focusAfterExpand = useRef<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement>(null)
  const focusPeek = useRef<string | null>(null)
  const pane = useRef<HTMLElement>(null)
  const openPeek = (id: string, from: HTMLElement) => {
    opener.current = from
    focusPeek.current = id
    navigate(here({ params: { peek: id } }))
  }
  useLayoutEffect(() => {
    if (focusPeek.current === peekId && peekId !== null) heading.current?.focus({ preventScroll: true })
    focusPeek.current = null
  }, [peekId])
  const viewer = useMemo(() => state.openTaskMe && board.viewerOf(state.openTaskMe), [state.openTaskMe])
  const projected = useMemo(() => projectWork(state, records, viewer, now), [state, records, viewer, now])
  const claimant = route.view === 'cell' ? route.cell : undefined
  const latest = useMemo(() => {
    if (!unknownParty && scopedParty === null && claimant === undefined) return projected
    const groups = projected.groups.map((group) => ({
      ...group,
      rows: unknownParty ? [] : filterWork(group.rows, { text: '', party: scopedParty ?? undefined, claimant }),
    }))
    return { groups, rows: groups.flatMap(({ rows }) => rows) }
  }, [projected, unknownParty, scopedParty, claimant])
  const errors = new Set(viewer && latest === projected ? Object.values(state.openTaskAttentionRefusals) : [])
  const readStatus = state.tasksRefused ?? (state.tasksCounted ? null : 'loading…')
  const statusClass = state.tasksRefused === null ? undefined : 'error'
  for (const { root } of latest.rows) {
    const { readError } = attentionFor(state, root, viewer)
    if (readError !== null) errors.add(readError)
  }

  // As in Needs action, freeze the surviving rows' order within each group while reading;
  // membership, grouping and text keep updating. Restore focus when a link moves groups.
  const [frozen, setFrozen] = useState(false)
  const order = useRef(new Map<string, number>())
  const list = useRef<HTMLDivElement>(null)
  const layout = useRef<HTMLDivElement>(null)
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
  const peekHasFocus = Boolean(pane.current?.contains(document.activeElement))
  // Hold the row being read even with peek open; only fall back to the keyboard
  // selection when reading the list alone. Skip the row when peek itself has focus.
  const rowAnchor = peekHasFocus ? undefined : (rowKey(focused.current) ?? hoveredKey.current ?? selected.map(rowKey).find(Boolean) ??
    (frozen && peekId === null ? selection : null))
  useHoldPosition(list, rowAnchor, 'data-work-row')
  useHoldPosition(layout, peekHasFocus ? 'peek' : undefined, 'data-work-row')
  const release = (target: EventTarget | null) => {
    if (hovered.current || target === field.current ||
        (target instanceof Node && (list.current?.contains(target) || pane.current?.contains(target)))) return
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
  const rowsById = new Map(latest.rows.map((row) => [row.root.id, row]))
  const scope = latest.groups.filter(({ group }) => group !== 'done').flatMap(({ rows }) =>
    frozen ? keepOrder(rows.map(({ root }) => root), order.current).map(({ id }) => rowsById.get(id)!) : rows)
  const shown = filterWork(scope.filter(({ group }) => inView(group)), filter)
  // The queue's empty groups are optional; the home summaries still show explicit zeros.
  const groups = viewGroups.filter(inView).map((group) => ({ group, rows: shown.filter((row) => row.group === group) }))
    .filter(({ rows }) => showEmpty || rows.length > 0)
  const ids = shown.filter(({ group }) => !collapsed.has(group)).map(({ root }) => root.id)
  const selectedId = selection?.slice(selection.indexOf(':') + 1)
  const selectedRow = shown.find(({ root }) => root.id === selectedId)
  const home = homeOf(shown, null, now)
  // Health describes the whole scope, regardless of view, filters, or collapse.
  const { health } = useMemo(() => {
    const scopedRecords = unknownParty ? null : scopedParty !== null && party && records
      ? { ...records, parties: { [scopedParty]: party } } : records
    return homeOf(latest.rows, scopedRecords, now)
  }, [latest, records, now, party, scopedParty, unknownParty])
  const capacity = health.perParty.find((entry) => entry.party.id === partyId)
  const empty = unknownParty ? 'no party with that id'
    : cellView && latest.rows.length === 0 ? 'nothing claimed by this cell' : null
  const peeked = peekId === null ? undefined : rowsById.get(peekId)
  const focusQueueRow = (id: string) => list.current?.querySelector<HTMLElement>(queueRow(id))?.focus()
  const queueHeading = (group: WorkGroup | 'queue') => list.current?.querySelector<HTMLElement>(`#work-queue-${group}`)
  const onKey = (event: KeyboardEvent, target: Element | null) => {
    const inList = list.current?.contains(target)
    const onBody = target === document.body && thread === null
    // Peek keeps its dismissal keys, but doesn't take over the list's keyboard map.
    const dismissPeek = pane.current?.contains(target) && (event.key === 'Escape' || event.key === ' ')
    const typing = isTypingTarget(target)
    const prefix = pending.current
    if ((!inList && !onBody && !dismissPeek) || typing || event.defaultPrevented || event.isComposing || list.current?.closest('[inert]') ||
        target?.closest('[role="menu"], [role="dialog"], [role="listbox"], [inert]')) {
      pending.current = null
      return
    }
    const action = keyAction(event, prefix, typing)
    pending.current = action?.type === 'prefix' ? action.key : null
    if (!action) {
      // Like useTypeToFocus, let the browser deliver the printable key to the newly focused field.
      if (thread === null && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) field.current?.focus()
      return
    }
    // Keep native control activation, and let Escape close a foreground thread.
    if ((action.type === 'thread' && target?.closest('a, button, [role="button"]')) ||
        (action.type === 'peek' && target?.closest('button, [role="button"]')) ||
        (action.type === 'escape' && thread !== null && peekId === null && selection === null)) return
    event.preventDefault()
    switch (action.type) {
      case 'move': {
        const at = selectedId === undefined ? -1 : ids.indexOf(selectedId)
        const next = ids[(at < 0 && action.by < 0 ? ids.length : at) + action.by]
        if (next !== undefined) focusQueueRow(next)
        break
      }
      case 'jump': {
        const first = groups.find(({ group }) => group === action.to)?.rows[0]
        const heading = queueHeading(action.to)
        if (first && !collapsed.has(first.group)) focusQueueRow(first.root.id)
        else if (heading) {
          setSelection(first ? `queue:${first.root.id}` : null)
          heading.focus()
        }
        break
      }
      case 'thread': if (selectedRow) navigate(here({ thread: selectedRow.root.id })); break
      case 'peek':
        if (!event.repeat && selectedRow) {
          if (peekId === selectedRow.root.id) closePeek()
          else openPeek(selectedRow.root.id, document.activeElement as HTMLElement)
        }
        break
      case 'escape':
        if (peekId !== null) closePeek()
        else { setSelection(null); if (rowOf(document.activeElement)) list.current?.focus({ preventScroll: true }) }
        break
      case 'filter': field.current?.focus(); break
      case 'collapse':
        if (selectedRow) {
          const { group } = selectedRow
          if (action.closed && !collapsed.has(group)) queueHeading(group)?.focus()
          if (!action.closed && collapsed.has(group)) focusAfterExpand.current = selectedRow.root.id
          setCollapsed((prev) => {
            const next = new Set(prev)
            if (action.closed) next.add(group)
            else next.delete(group)
            return next
          })
        }
        break
      case 'link': {
        const url = webUrl(selectedRow?.urls?.[action.link])
        if (url && !event.repeat) window.open(url, '_blank', 'noopener,noreferrer')
        break
      }
      case 'help': if (!event.repeat) setHelp((open) => !open); break
    }
  }
  const onDocumentKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : document.activeElement
    if (target === document.body) onKey(event, target)
    else if (!list.current?.contains(target)) pending.current = null
  })
  useEffect(() => {
    const listen = (event: KeyboardEvent) => onDocumentKey(event)
    document.addEventListener('keydown', listen)
    return () => document.removeEventListener('keydown', listen)
  }, [])
  useLayoutEffect(() => {
    const before = [...order.current.keys()]
    order.current = new Map(scope.map(({ root }, index) => [root.id, index]))
    if (focusAfterExpand.current !== null) {
      focusQueueRow(focusAfterExpand.current)
      focusAfterExpand.current = null
    }
    const el = list.current
    const target = focused.current
    const id = rowOf(target)?.dataset.taskId
    if (!el || !target || id === undefined || document.activeElement !== document.body) return
    const index = before.indexOf(id)
    const next = [id, ...before.slice(index + 1), ...before.slice(0, Math.max(0, index)).reverse(), ...ids]
      .find((candidate) => ids.includes(candidate))
    const selector = target.matches('button') ? ' button' : target.matches('a.text-link') ? ' a.text-link' : target.matches('a') ? ' a' : ''
    const replacement = next === undefined ? null : el.querySelector<HTMLElement>(`${queueRow(next)}${selector}`)
      ?? el.querySelector<HTMLElement>(queueRow(next))
    ;(replacement ?? el).focus({ preventScroll: true })
  })
  const showRow = (row: WorkRow, area: 'home' | 'queue', detail?: ReactNode) => (
    <Row key={row.root.id} {...{ row, state, area, detail }} cellDetail={cellView}
      claimantLink={row.claimant ? workScopeUrl(`/cell/${encodeURIComponent(row.claimant)}`, params,
        parentParty ?? row.party?.id) : undefined} current={selection === `${area}:${row.root.id}`}
      expanded={peekId === row.root.id} openPeek={(id, from) => {
        setSelection(`${area}:${id}`)
        if (peekId === id) closePeek()
        else openPeek(id, from)
      }} />
  )
  const { counts } = home

  return (
    <>
      <Header title={title} meta={subtitle} live={state.live} lead={lead}>
        {repoView && party && <span className="meta"><PartyName party={party} />
          {readStatus === null && capacity && <> · {capacity.active} / {capacity.party.openClaimLimit ?? 'limit unknown'} active</>}
        </span>}
      </Header>
      <div className={`page home-view needs-view work-view${peekId === null ? '' : ' with-peek'}${comfortable ? ' comfortable' : ''}`}>
        {route.view === 'party' && <p className="faint">shared queues stay on each repo board; this inspector reaches one board</p>}
        {cellView && <p><Link className="text-link" to={workScopeUrl('/presidium', params, parentParty)}>
          back to {labelsOf(records, partyId).repoView.label}
        </Link></p>}
        {repoView && !records && <p>{where.name}{where.at && <span className="faint"> · {where.at}</span>}</p>}
        {repoView && records && <div className="work-controls">
          {!party && <>
            <span>{params.has('party') ? 'no party with that id; choose a party:' : 'choose a party:'}</span>
            {Object.entries(records.parties).map(([id, entry]) => (
              <Link key={id} className="text-link" to={here({ params: { party: id, parties: null, peek: null } })}>{entry.name}</Link>
            ))}
          </>}
          {party && <Link className="text-link" to={here({ params: { parties: allParties ? null : 'all', peek: null } })}>
            {allParties ? 'this party' : 'all parties'}
          </Link>}
        </div>}
        <nav className="work-controls" aria-label="Saved work views">
          {Object.entries(SAVED_VIEWS).map(([key, { title }]) => (
            <Link key={key} className="text-link" current={key === view} to={here({ params: { view: key } })}>{title}</Link>
          ))}
        </nav>
        <div className="work-controls">
          <label className="suggest">
            <input ref={field} type="search" aria-label="Filter work" placeholder="Filter work" value={text} spellCheck={false}
              onFocus={() => { pending.current = null; setFrozen(true) }} onBlur={(event) => release(event.relatedTarget)}
              onChange={(event) => {
                const next = event.currentTarget.value
                setText(next)
                navigate(here({ params: { q: next } }), true)
              }} />
          </label>
          <DisplayCheck checked={showEmpty} label="show empty groups" onChange={() => navigate(here({ params: { show: showEmpty ? null : 'empty' } }))} />
          <DisplayCheck checked={comfortable} label="comfortable" onChange={() => navigate(here({ params: { density: comfortable ? null : 'comfortable' } }))} />
          <button type="button" className="segment small" aria-expanded={help} aria-controls={help ? 'work-keys' : undefined} onClick={() => setHelp(!help)}>keys</button>
        </div>
        {chips.length > 0 && <div className="work-controls" aria-label="Active work filters">
          {chips.map(([key, value]) => (
            <Link key={key} className="text-link" title={`remove ${key} filter`} to={here({ params: { [key === 'party' ? filterPartyKey : key]: null } })}>{key}: {value} (remove)</Link>
          ))}
        </div>}
        {help && <KeyHelp row={selectedRow} />}
        {readStatus === null && !cellView && !unknownParty && (
          <>
            {filtering && <p role="status">{shown.length} of {scope.length} rows</p>}
            <p className="work-counts">
              {inView('needs') && <><a href="#work-needs">{counts.needs} need you</a> · </>}
              {inView('review') && <><a href="#work-review">{counts.review} ready to review</a> · </>}
              {inView('running') && <><a href="#work-running">{counts.running} running</a> · </>}
              <a href="#work-health">{health.total.expiring} expiring in 30 min</a>
            </p>
          </>
        )}
        <p role="status" className={repoView && !records ? 'faint' : undefined}>{records ? 'swarm records: seeded fixtures (not live data)' : 'swarm records: none (add ?swarm=fixtures to preview seeded fixtures)'}</p>
        {/* Handle list shortcuts before the document-level type-to-focus listener. */}
        <div ref={layout} className="work-layout" onKeyDown={(event) => onKey(event.nativeEvent, event.target instanceof Element ? event.target : null)}>
          <div ref={list} tabIndex={-1} aria-label="Work board tasks" className="work-list"
            onFocus={(event) => {
              focused.current = event.target
              const key = rowKey(event.target)
              if (key) setSelection(key)
              if (event.target !== event.currentTarget) setFrozen(true)
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
            {readStatus === null && !cellView && !unknownParty && (
              <>
                {inView('needs') && <HomeSection id="work-needs" title="Needs you" empty="nothing needs you" present={!!home.needs.length}>
                  {!collapsed.has('needs') && <ul role="list">{home.needs.map((row) => showRow(row, 'home'))}</ul>}
                </HomeSection>}
                {inView('review') && <HomeSection id="work-review" title="Ready to review" empty="nothing to review" present={!!home.review.length}>
                  {!collapsed.has('review') && <ul role="list">{home.review.map((row) => showRow(row, 'home', <Ago iso={row.root.createdAt} now={now} prefix="open " />))}</ul>}
                </HomeSection>}
                {inView('running') && <HomeSection id="work-running" title="Running now" empty="nothing running" present={!!home.running.length}>
                  {!collapsed.has('running') && home.running.map(({ party, cells }) => (
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
                </HomeSection>}
                <HomeSection id="work-health" title="Health and spend" empty="no health data" present={!!health.perParty.length}>
                  <Health health={health} />
                </HomeSection>
              </>
            )}
            <div className="home-queue work-queue">
              <h2 id="work-queue-queue" tabIndex={-1}>Queue</h2>
              {unknownParty ? <p role="status">{empty}</p>
                : readStatus !== null ? <p role="status" className={statusClass}>{readStatus}</p>
                : empty ? <p role="status">{empty}</p> : (
                <>
                  {groups.map(({ group, rows }) => (
                    <section key={group}>
                      <h3 id={`work-queue-${group}`} tabIndex={-1}>{workGroupTitle(group)} ({rows.length}) <small>{collapsed.has(group) ? 'collapsed' : RULES[group]}</small></h3>
                      {!collapsed.has(group) && rows.length > 0 && <ul role="list">{rows.map((row) => showRow(row, 'queue'))}</ul>}
                    </section>
                  ))}
                  {shown.length === 0 && filtering && <p role="status">no rows match</p>}
                  {shown.length === 0 && !filtering && errors.size === 0 && <p role="status">nothing on the board</p>}
                  {[...errors].map((error) => <p key={error} role="status" className="error">{error}</p>)}
                </>
              )}
            </div>
          </div>
          {peekId !== null && (
            <aside ref={pane} id="work-peek" className="work-peek" data-work-row="peek" aria-label="Work peek" onBlur={(event) => release(event.relatedTarget)}>
              {readStatus !== null ? <p role="status" className={statusClass}>{readStatus}</p>
                : peeked ? <Peek row={peeked} state={state} heading={heading} close={closePeek} />
                : <p role="status">no longer on the board</p>}
            </aside>
          )}
        </div>
      </div>
    </>
  )
}

function DisplayCheck({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button type="button" role="checkbox" aria-checked={checked} className={`segment small${checked ? ' on' : ''}`} onClick={onChange}>{label}</button>
}

function KeyHelp({ row }: { row: WorkRow | undefined }) {
  const links = ([['o', 'source'], ['p', 'pr'], ['e', 'evidence']] as const)
    .map(([key, link]) => `${key} ${link === 'pr' ? 'PR' : link}${webUrl(row?.urls?.[link]) ? '' : ' (no link)'}`)
  return (
    <div id="work-keys" role="region" aria-label="Work keyboard shortcuts">
      <p>j / ArrowDown: next row; k / ArrowUp: previous row. Enter: open thread. Space: toggle peek. Escape: close peek or clear selection.</p>
      <p>/: focus filter. g then n: Needs you; r: Ready to review; u: Running; w: Ready to pull; q: Queue.</p>
      <p>[: collapse group; ]: expand group. Open in a new tab: {links.join('; ')}. ?: toggle keys.</p>
      <p>Write keys (c, x, r, d) and Cmd/Ctrl+K are not bound. Writes go through the dispatcher (WP-402/406).</p>
    </div>
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

export function Row({ row, state, area, detail, current, expanded, openPeek, claimantLink, cellDetail }: {
  row: WorkRow; state: State; area: 'home' | 'queue'; detail?: ReactNode; current?: boolean; expanded: boolean
  openPeek: (id: string, from: HTMLElement) => void; claimantLink?: string; cellDetail?: boolean
}) {
  const { root, party } = row
  return (
    <li data-task-id={root.id} data-work-row={`${area}:${root.id}`} tabIndex={0} aria-current={current || undefined}>
      <small>{row.priority}</small>
      <small>{row.workId}</small>
      <Link to={here({ thread: root.id })}>{row.title || `Task #${root.id}`}</Link>
      <small><PartyName party={party} /></small>
      <small>{row.claimant && claimantLink ? <Link className="text-link" to={claimantLink}>{nameOf(state, row.claimant)}</Link>
        : row.claimant ? nameOf(state, row.claimant) : 'unclaimed'}</small>
      <small>{row.group === 'running' ? detail ?? row.reason : row.reason}</small>
      {row.group !== 'running' && detail && <small>{detail}</small>}
      {cellDetail && <small>attempt {row.attempt ?? 'unknown'}</small>}
      {row.claimText && <small title={root.task.claim?.until}>{row.claimText}
        {cellDetail && root.task.claim && <> · board time <time dateTime={root.task.claim.until}>{root.task.claim.until}</time></>}
      </small>}
      <small>{row.branch && cellDetail ? `branch ${row.branch}` : row.prText}</small>
      <small>{row.spendText === 'unknown' ? 'spend unknown' : row.spendText}
        {cellDetail && row.spendText === 'unknown' && ` · ${row.spend?.coverage ?? 'unknown'} coverage`}
      </small>
      {cellDetail && <small>last handoff reason: {row.handoffReason ?? 'unknown'}</small>}
      <TrackerBadges trackers={row.trackers} />
      {row.overlapText && <small>{row.overlapText}</small>}
      <button type="button" aria-expanded={expanded} aria-controls={expanded ? 'work-peek' : undefined} onClick={(event) => openPeek(root.id, event.currentTarget)}>peek</button>
    </li>
  )
}
