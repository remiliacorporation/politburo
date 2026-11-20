import { useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as board from '../board.ts'
import { Ago, here, Link, OPERATIONS, type Operation } from '../nav.tsx'
import { operatorReports, reviewQueue, type State, type TaskFilter } from '../store.ts'
import { Header } from '../ui.tsx'
import { firstLine } from '../words.ts'

export function Operations({ section, state, lead, thread }: { section: Operation; state: State; lead: ReactNode; thread: string | null }) {
  return (
    <>
      <Header title={OPERATIONS[section]} lead={lead} />
      <nav className="tabs" aria-label="Operator console">
        {(Object.keys(OPERATIONS) as Operation[]).map((name) => (
          <Link key={name} to={`/operations/${name}`} className="tab" current={name === section}>{OPERATIONS[name]}</Link>
        ))}
      </nav>
      <div className="page">
        {section === 'review' ? <ReviewQueue state={state} thread={thread} /> :
          section === 'agents' ? <p className="empty">Agent health is unavailable. This inspector’s board handle has no agent registry or run health API.</p> :
          <Reports key={section} kind={section} state={state} thread={thread} />}
      </div>
    </>
  )
}

const BLOCKED: TaskFilter = { state: 'blocked', label: [] }

function ReviewQueue({ state, thread }: { state: State; thread: string | null }) {
  const [page, setPage] = useState<Extract<Awaited<ReturnType<typeof board.loadTasks>>, { cursor: string }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let open = true
    void board.loadTasks(BLOCKED).then((answer) => {
      if (!open) return
      if ('refused' in answer) setError(answer.refused)
      else setPage(answer)
      setLoading(false)
    })
    return () => { open = false }
  }, [])
  async function more() {
    if (!page?.more || loading) return
    setLoading(true)
    setError(null)
    const answer = await board.loadTasks(BLOCKED, page.cursor)
    if ('refused' in answer) setError(answer.refused)
    else setPage(answer)
    setLoading(false)
  }
  const rows = page ? reviewQueue(state, page.more ? page.last : undefined) : []
  return (
    <>
      <p className="empty">Tasks the board marks as awaiting approval. Independent review stages are not available.</p>
      {error !== null && <p className="empty error" role="status">{error}</p>}
      {rows.length ? (
        <div className="task-rows">
          {rows.map((row) => (
            <Link key={row.id} to={here({ thread: row.id })} current={row.id === thread} className="task-row operator-task">
              <span className="faint">#{row.channel}</span>
              <span>{firstLine(row.text) || `task #${row.id}`}</span>
            </Link>
          ))}
        </div>
      ) : !loading && error === null && <p className="empty">{page?.more ? 'No tasks awaiting approval on this page yet.' : 'No tasks awaiting approval.'}</p>}
      {loading && <p className="empty" role="status">loading…</p>}
      {page?.more && <button type="button" className="clear more" disabled={loading} onClick={() => void more()}>load more</button>}
    </>
  )
}

const REPORT_CHANNELS = { providers: 'ops/provider-access', models: 'ops/model-scoreboard' } as const

function Reports({ kind, state, thread }: { kind: keyof typeof REPORT_CHANNELS; state: State; thread: string | null }) {
  const channel = REPORT_CHANNELS[kind]
  const [result, setResult] = useState<{ refused: string } | { loaded: true } | null>(null)
  useEffect(() => {
    let open = true
    void board.loadOperatorReports(channel).then((answer) => { if (open) setResult(answer) })
    return () => { open = false }
  }, [channel])
  if (result === null) return <p className="empty" role="status">loading…</p>
  if ('refused' in result) return <p className="empty error" role="status">{result.refused}</p>
  const reports = operatorReports(state, channel, kind === 'models' ? 1 : 25)
  if (reports.length === 0) {
    return <p className="empty">No {kind === 'models' ? 'scoreboard snapshots' : 'provider access reports'} in #{channel}. The router must publish reports to this channel.</p>
  }
  return (
    <div className="operator-reports">
      {reports.map((report) => (
        <article key={report.id}>
          <div className="faint">
            <Link to={here({ thread: report.id })} current={thread === report.id}>#{report.id}</Link>
            {' · '}{report.by.actor}{' · '}<Ago iso={report.createdAt} />
          </div>
          <div className="text"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{report.text}</Markdown></div>
        </article>
      ))}
    </div>
  )
}
