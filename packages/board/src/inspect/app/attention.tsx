import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { keyAction, selectionAfter, type Selection } from './attention-keys.ts'
import * as board from './board.ts'
import { Ago, here, Link, useTypeToFocus } from './nav.tsx'
import { attentionFor, attentionRows, NO_ATTENTION } from './attention-store.ts'
import type { State, TaskRoot, Viewer } from './store.ts'
import { Header } from './ui.tsx'
import { firstLine } from './words.ts'

export function Attention({ state, viewer, lead }: { state: State; viewer: Viewer; lead: ReactNode }) {
  useTypeToFocus('main')
  useEffect(board.openAttention, [])
  const rows = useMemo(() => attentionRows(state), [state.messages, state.attention])
  const items = rows.flatMap((root) => {
    const { held, attention } = attentionFor(state, root, viewer)
    return held && root.task.attentionId !== undefined && attention?.status !== 'canceled' && attention?.status !== 'answered'
      ? [{ taskId: root.id, requestId: root.task.attentionId }]
      : []
  })
  const [previous, select] = useState<Selection | null>(null)
  const selected = selectionAfter(previous, items)
  if (selected !== previous) select(selected)
  const selectedRow = selected && rows.find((root) => root.id === selected.taskId)
  const choice = selectedRow && attentionFor(state, selectedRow, viewer)
  useEffect(() => board.attentionRendered(state), [state])

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const list = event.currentTarget
    const action = keyAction(event, { focused: list.ownerDocument.activeElement, choice: choice ?? null, items, selected })
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.type === 'move') {
      select(action.next)
      list.ownerDocument.getElementById(`attention-${action.next.taskId}`)?.scrollIntoView({ block: 'nearest' })
    } else {
      void board.answerAttention(action.selected.taskId, action.selected.requestId, action.optionId)
    }
  }

  const supported = state.discovery?.task_attention === true && !state.attentionUnsupported
  const canAnswer = rows.some((root) => attentionFor(state, root, viewer).reason === null)
  return (
    <>
      <Header title="attention" meta="oldest first" live={state.live} lead={lead} />
      <div className="page attention-list" role="region" aria-label="attention requests" tabIndex={0} onKeyDown={keys}>
        {rows.length > 0 && <p className="attention-keys faint">with the list focused: j/k to select{canAnswer ? ', 1–8 to answer' : ''}</p>}
        {state.tasksRefused !== null && <p className="empty error">{state.tasksRefused}</p>}
        {rows.length === 0 && state.tasksRefused === null && (
          <p className="empty">{!state.tasksCounted ? 'loading…' : !supported ? NO_ATTENTION : 'no open attention requests'}</p>
        )}
        {rows.map((root) => (
          <AttentionRow key={root.id} root={root} state={state} viewer={viewer} selected={selected?.taskId === root.id}
            onSelect={() => {
              const item = items.find(({ taskId }) => taskId === root.id)
              if (item) select(item)
            }} />
        ))}
      </div>
    </>
  )
}

function AttentionRow({ root, state, viewer, selected, onSelect }: { root: TaskRoot; state: State; viewer: Viewer; selected: boolean; onSelect: () => void }) {
  const { held, attention, readError, missing, error, answering, reason, disabled } = attentionFor(state, root, viewer)
  const title = firstLine(root.text) || root.attachments?.map((file) => file.name).join(', ') || 'message removed'
  const chosen = attention?.status === 'answered' ? attention.options.find((option) => option.id === attention.receipt.option) : undefined
  return (
    <article id={`attention-${root.id}`} className="attention-row" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
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
        held && <p className="faint">{missing ? 'no request found' : 'reading request…'}</p>
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
      {error !== undefined && error !== readError && <p className="error" role="status">{error}</p>}
      {attention !== null && reason !== null && <p className="faint">read only: {reason}</p>}
      {state.attentionUnsupported && attention === null && readError !== NO_ATTENTION && error !== NO_ATTENTION && <p className="faint">{NO_ATTENTION}</p>}
    </article>
  )
}
