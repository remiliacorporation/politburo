import type { KeyboardEvent } from 'react'
import type { attentionFor } from './attention-store.ts'

export type Selection = { taskId: string; requestId: string }

export function selectionAfter(prev: Selection | null, items: Selection[]): Selection | null {
  return prev && items.some(({ taskId, requestId }) => taskId === prev.taskId && requestId === prev.requestId) ? prev : null
}

type KeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'repeat' | 'defaultPrevented'> & {
  target: unknown
  currentTarget: { closest(selector: string): unknown; isContentEditable?: boolean }
  nativeEvent: { isComposing: boolean }
}
type Choice = Pick<ReturnType<typeof attentionFor>, 'reason' | 'disabled' | 'attention'>

export function keyAction(event: KeyEvent, ctx: { focused: unknown; choice: Choice | null; items: Selection[]; selected: Selection | null }) {
  const list = event.currentTarget
  // Only the focused scroller, not its controls, an editable ancestor, or the composer.
  if (event.target !== list || ctx.focused !== list || list.isContentEditable ||
      list.closest('input, textarea, select, [contenteditable]') || event.defaultPrevented ||
      event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return null
  const { selected, items, choice } = ctx
  if (event.key === 'j' || event.key === 'k') {
    const by = event.key === 'j' ? 1 : -1
    const at = selected ? items.findIndex((item) => item.taskId === selected.taskId && item.requestId === selected.requestId) : by === 1 ? -1 : items.length
    const next = items[at + by]
    return next ? { type: 'move', next } as const : null
  }
  if (!selected || event.repeat || !/^[1-8]$/.test(event.key) || choice?.reason !== null || choice.disabled) return null
  const optionId = choice.attention?.options[Number(event.key) - 1]?.id
  return optionId === undefined ? null : { type: 'answer', selected, optionId } as const
}
