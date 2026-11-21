import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import * as board from './board.ts'
import { Ago, here, Link, useTypeToFocus } from './nav.tsx'
import { attentionFor, attentionRows, NO_ATTENTION, type State, type TaskRoot, type Viewer } from './store.ts'
import { Header } from './ui.tsx'
import { firstLine } from './words.ts'

export function Attention({ state, viewer, lead }: { state: State; viewer: Viewer; lead: ReactNode }) {
  useTypeToFocus('main')
  useEffect(board.openAttention, [])
  const rows = useMemo(() => attentionRows(state), [state.messages, state.attention])
  const [selectedId, select] = useState<string | null>(null)
  const selected = rows.find((root) => root.id === selectedId) ?? rows[0]
  useEffect(() => {
    select(selected?.id ?? null)
  }, [selected?.id])

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    // Only this scroller, never its controls or the thread's composer.
    const list = event.currentTarget
    if (event.target !== list || list.ownerDocument.activeElement !== list || list.isContentEditable ||
        event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (!selected) return
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault()
      const at = rows.indexOf(selected) + (event.key === 'j' ? 1 : -1)
      const next = rows[at]
      if (next) {
        select(next.id)
        list.ownerDocument.getElementById(`attention-${next.id}`)?.scrollIntoView({ block: 'nearest' })
      }
    } else if (/^[1-8]$/.test(event.key)) {
      event.preventDefault()
      if (event.repeat) return
      const { attention, reason, disabled } = attentionFor(state, selected, viewer)
      const option = attention?.options[Number(event.key) - 1]
      if (option && attention && reason === null && !disabled) void board.answerAttention(selected.id, attention.id, option.id)
    }
  }

  const supported = state.discovery?.task_attention === true && !state.attentionUnsupported
  return (
    <>
      <Header title="attention" meta="oldest first" live={state.live} lead={lead} />
      <div className="page attention-list" role="region" aria-label="attention requests" tabIndex={0} onKeyDown={keys}>
        {rows.length > 0 && <p className="attention-keys faint">with the list focused: j/k to select{supported ? ', 1–8 to answer' : ''}</p>}
        {state.tasksRefused !== null && <p className="empty error">{state.tasksRefused}</p>}
        {rows.length === 0 && state.tasksRefused === null && (
          <p className="empty">{!state.tasksCounted ? 'loading…' : !supported ? NO_ATTENTION : 'no open attention requests'}</p>
        )}
        {rows.map((root) => <AttentionRow key={root.id} root={root} state={state} viewer={viewer} selected={selected?.id === root.id} onSelect={() => select(root.id)} />)}
      </div>
    </>
  )
}

function AttentionRow({ root, state, viewer, selected, onSelect }: { root: TaskRoot; state: State; viewer: Viewer; selected: boolean; onSelect: () => void }) {
  const { attention, readError, missing, error, answering, reason, disabled } = attentionFor(state, root, viewer)
  const title = firstLine(root.text) || root.attachments?.map((file) => file.name).join(', ') || 'message removed'
  const chosen = attention?.status === 'answered' ? attention.options.find((option) => option.id === attention.receipt.option) : undefined
  return (
    <article id={`attention-${root.id}`} className="attention-row" aria-current={selected ? 'true' : undefined} onFocus={onSelect}>
      <div className="attention-meta">
        <span>#{root.channel}</span>
        <Ago iso={root.createdAt} />
        <span className="attention-status" role="status">
          {answering !== null ? `answering ${answering}` : chosen ? `answered · ${chosen.label}` : attention?.status}
        </span>
      </div>
      <Link to={here({ thread: root.id })} className="attention-title" title="open the task thread">
        <span className="faint">#{root.id}</span> {title}
      </Link>
      {readError !== null ? (
        <p className="error" role="status">{readError}</p>
      ) : attention === null ? (
        <p className="faint">{missing ? 'no request found' : 'reading request…'}</p>
      ) : (
        <>
          <p className="attention-question">{attention.question}</p>
          {attention.context && <details><summary>context</summary><p className="attention-prose">{attention.context}</p></details>}
          <ol className="attention-options">
            {attention.options.map((option) => (
              <li key={option.id}>
                {reason !== null ? <span className="attention-label">{option.label}</span> : (
                  <button className="act attention-choice" disabled={disabled} onClick={() => void board.answerAttention(root.id, attention.id, option.id)}>{option.label}</button>
                )}
                <p className="attention-prose">{option.consequence}</p>
                <span className="faint">{option.next === 'resume' ? 'continues the task' : 'fails the task'}</span>
              </li>
            ))}
          </ol>
          <p className="attention-meta">expires <time dateTime={attention.expiresAt} title={attention.expiresAt}>{new Date(attention.expiresAt).toLocaleString()}</time></p>
        </>
      )}
      {error !== undefined && <p className="error" role="status">{error}</p>}
      {attention !== null && reason !== null && <p className="faint">read only: {reason}</p>}
      {state.attentionUnsupported && attention === null && readError !== NO_ATTENTION && error !== NO_ATTENTION && <p className="faint">{NO_ATTENTION}</p>}
    </article>
  )
}
