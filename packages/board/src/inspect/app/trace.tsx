import { useEffect, useMemo, useState } from 'react'
import type { BoardEventView } from '../../api/routes.ts'
import * as board from './board.ts'
import type { TraceAttachment } from './board.ts'
import { said, shownName } from './words.ts'

const FILE_KINDS = ['transcript', 'log', 'ci'] as const

export const TRACE_KINDS = [
  'created', 'letter', 'labelled', 'review', 'pr', 'claimed', 'renewed', 'released',
  'blocked', 'unblocked', 'reply', 'delivery', 'completed', 'failed', 'canceled', 'expired', 'other',
] as const

export type TraceKind = (typeof TRACE_KINDS)[number]

export type TraceLine = { id: string; at: string; actor: string; kind: TraceKind; text: string }

const actorOf = (event: BoardEventView): string => (event.actor ? shownName(event.actor) : 'the board')

const kindOfLabel = (key: string): TraceKind => {
  if (key === 'review.verdict' || key === 'review.head') return 'review'
  if (key.startsWith('pr.')) return 'pr'
  return 'labelled'
}

const textOfLabel = (key: string, value: string): string =>
  kindOfLabel(key) === 'labelled' ? `labelled ${key}=${value}` : `${key} ${value}`

const line = (event: BoardEventView, id: string, kind: TraceKind, text: string): TraceLine => ({
  id, at: event.createdAt, actor: actorOf(event), kind, text,
})

/** One displayed row per fact, so a label write splits into review, pr, and other labels. */
export function traceLines(events: readonly BoardEventView[]): TraceLine[] {
  const lines: TraceLine[] = []
  for (const event of events) lines.push(...linesOf(event))
  return lines
}

function linesOf(event: BoardEventView): TraceLine[] {
  const payload = event.payload as Record<string, unknown>
  const text = typeof payload.text === 'string' ? payload.text : ''
  switch (event.type) {
    case 'message.posted':
      return [line(event, `${event.cursor}:post`, payload.re == null ? 'letter' : 'reply', `${payload.re == null ? 'letter' : 'reply'} ${text}`)]
    case 'labels.changed': {
      const set = payload.set && typeof payload.set === 'object' ? payload.set as Record<string, string> : {}
      const unset = Array.isArray(payload.unset) ? payload.unset.filter((key): key is string => typeof key === 'string') : []
      return [
        ...Object.entries(set).map(([key, value]) => line(event, `${event.cursor}:set:${key}`, kindOfLabel(key), textOfLabel(key, value))),
        ...unset.map((key) => line(event, `${event.cursor}:unset:${key}`, kindOfLabel(key), `labelled ${key} unset`)),
      ]
    }
    case 'message.synced':
      return [line(event, event.cursor, 'delivery', `delivered to ${String(payload.target ?? '')}`)]
    case 'message.files_synced':
      return [line(event, event.cursor, 'delivery', `files delivered to ${String(payload.target ?? '')}`)]
    case 'message.sync_failed':
      return [line(event, event.cursor, 'delivery', `delivery failed${typeof payload.reason === 'string' ? ` ${payload.reason}` : ''}`)]
    case 'task.created':
      return [line(event, event.cursor, 'created', 'created')]
    case 'task.claimed': {
      const binding = payload.binding && typeof payload.binding === 'object' ? payload.binding as { provider?: string; model?: string; session?: string; branch?: string } : undefined
      const claimed = binding
        ? `claimed agent ${binding.provider} model ${binding.model} session ${binding.session} branch ${binding.branch}`
        : 'claimed'
      return [line(event, event.cursor, 'claimed', claimed)]
    }
    case 'task.renewed':
      return [line(event, event.cursor, 'renewed', 'renewed')]
    case 'task.released':
      return [line(event, event.cursor, 'released', 'released')]
    case 'task.blocked':
      return [line(event, event.cursor, 'blocked', `blocked ${payload.kind ? `${String(payload.kind)}: ` : ''}${String(payload.reason ?? '')}`)]
    case 'task.unblocked':
      return [line(event, event.cursor, 'unblocked', `unblocked${typeof payload.reason === 'string' && payload.reason ? ` ${payload.reason}` : ''}`)]
    case 'task.completed':
      return [line(event, event.cursor, 'completed', typeof payload.result === 'string' && payload.result ? `completed ${payload.result}` : 'completed')]
    case 'task.failed':
      return [line(event, event.cursor, 'failed', `failed ${String(payload.reason ?? '')}`)]
    case 'task.canceled':
      return [line(event, event.cursor, 'canceled', `canceled ${String(payload.reason ?? '')}`)]
    case 'task.expired':
      return [line(event, event.cursor, 'expired', 'lease ran out')]
    case 'task.ready':
      return [line(event, event.cursor, 'other', 'ready')]
    default:
      return [line(event, event.cursor, 'other', event.type)]
  }
}

export function traceText(lines: readonly TraceLine[]): string {
  return lines.map((row) => `${row.at}  ${row.actor}  ${row.text}`).join('\n')
}

function TraceFiles({ id, stamp }: { id: string; stamp: string }) {
  const [files, setFiles] = useState<TraceAttachment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    void board.taskTraceFiles(id).then(
      (next) => { if (live) { setFiles(next); setError(null) } },
      (reason: unknown) => { if (live) setError(said(reason)) },
    )
    return () => { live = false }
  }, [id, stamp])
  useEffect(() => {
    if (!open) return
    let live = true
    setBody(null)
    setBodyError(null)
    setQuery('')
    void board.traceFileText(open).then(
      (text) => { if (live) setBody(text) },
      (reason: unknown) => { if (live) setBodyError(said(reason)) },
    )
    return () => { live = false }
  }, [open])
  const lines = useMemo(() => {
    if (body === null) return []
    const needle = query.trim().toLowerCase()
    return body.split('\n').flatMap((text, index) => {
      const line = { n: index + 1, text }
      return !needle || text.toLowerCase().includes(needle) ? [line] : []
    })
  }, [body, query])
  return (
    <section className="trace-file-list" aria-label="trace files">
      {error ? <p className="error" role="status">{error}</p>
        : files === null ? <p className="empty">loading…</p>
        : files.length === 0 ? <p className="empty">no trace files</p>
        : FILE_KINDS.filter((name) => files.some((file) => file.kind === name)).map((name) => (
          <div key={name}>
            <h3>{name}</h3>
            <ul>
              {files.filter((file) => file.kind === name).map((file) => (
                <li key={file.id}>
                  <button type="button" aria-current={open === file.id ? 'true' : undefined} onClick={() => setOpen(file.id)}>
                    {file.name}
                  </button>
                  {file.source && <span className="faint">{file.source}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {open && (
        <div className="trace-reader">
          <input aria-label="search trace file" value={query} onChange={(event) => setQuery(event.target.value)} />
          {bodyError ? <p className="error" role="status">{bodyError}</p>
            : body === null ? <p className="empty">loading…</p>
            : (
              <ol className="trace-reader-lines" aria-label="trace file">
                {lines.map((row) => (
                  <li key={row.n} data-line={row.n}>
                    <span className="trace-line-no">{row.n}</span>
                    <span>{row.text}</span>
                  </li>
                ))}
              </ol>
            )}
        </div>
      )}
    </section>
  )
}

/** A task's board events, oldest first. `stamp` reloads when the thread moves, without clearing the list. */
export function Trace({ id, stamp }: { id: string; stamp: string }) {
  const [events, setEvents] = useState<BoardEventView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<string>('all')
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void board.taskTrace(id).then(
      (page) => { if (live) { setEvents(page.events); setError(null) } },
      (reason: unknown) => { if (live) setError(said(reason)) },
    )
    return () => { live = false }
  }, [id, stamp])
  const lines = useMemo(() => (events ? traceLines(events) : []), [events])
  const kinds = TRACE_KINDS.filter((name) => lines.some((row) => row.kind === name))
  const shown = kind === 'all' || !kinds.includes(kind as TraceKind) ? lines : lines.filter((row) => row.kind === kind)
  return (
    <div className="trace-view">
      <div className="trace-tools">
        <label>
          kind{' '}
          <select aria-label="trace kind" value={kinds.includes(kind as TraceKind) ? kind : 'all'} onChange={(event) => setKind(event.target.value)}>
            <option value="all">all</option>
            {kinds.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="act"
          aria-label="copy trace"
          onClick={() => {
            void navigator.clipboard.writeText(traceText(shown)).then(
              () => setNote('copied'),
              (reason: unknown) => setNote(said(reason)),
            )
          }}
        >
          copy
        </button>
        {note && <span role="status">{note}</span>}
      </div>
      <TraceFiles id={id} stamp={stamp} />
      {error ? <p className="error" role="status">{error}</p>
        : events === null ? <p className="empty">loading…</p>
        : shown.length === 0 ? <p className="empty">no events</p>
        : (
          <ol className="trace" aria-label="trace">
            {shown.map((row) => (
              <li key={row.id} className="trace-row" data-kind={row.kind}>
                <time dateTime={row.at}>{row.at}</time>
                <span className="trace-actor">{row.actor}</span>
                <span>{row.text}</span>
                <span className="trace-files" />
              </li>
            ))}
          </ol>
        )}
    </div>
  )
}
