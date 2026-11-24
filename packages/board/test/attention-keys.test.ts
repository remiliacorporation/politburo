import { expect, it } from 'vitest'
import type { AttentionView } from '../src/api/routes.ts'
import { keyAction, selectionAfter } from '../src/inspect/app/attention-keys.ts'

const first = { taskId: '1', requestId: 'a' }
const second = { taskId: '2', requestId: 'b' }

it('keeps a selection by both IDs and clears it rather than selecting another item', () => {
  expect(selectionAfter(first, [second, { ...first }])).toBe(first)
  expect(selectionAfter(first, [second])).toBeNull()
  expect(selectionAfter(first, [{ ...first, requestId: 'new' }, second])).toBeNull()
  expect(selectionAfter(first, [{ ...first, taskId: 'new' }, second])).toBeNull()
  expect(selectionAfter(null, [second])).toBeNull()
})

it('resolves shortcuts to a real destination or a selected, enabled option', () => {
  const list = { closest: () => null }
  const event = { target: list, currentTarget: list, key: '2', nativeEvent: { isComposing: false },
    metaKey: false, ctrlKey: false, altKey: false, repeat: false, defaultPrevented: false }
  const attention = { options: [{ id: 'ship' }, { id: 'stop' }] } as AttentionView
  const ctx = { focused: list, items: [first, second], selected: { ...first }, choice: { attention, reason: null, disabled: false } }
  expect(keyAction(event, ctx)).toEqual({ type: 'answer', selected: first, optionId: 'stop' })
  expect(keyAction({ ...event, key: 'j' }, ctx)).toEqual({ type: 'move', next: second })
  expect(keyAction({ ...event, key: 'k' }, { ...ctx, selected: null })).toEqual({ type: 'move', next: second })
  expect(keyAction({ ...event, key: 'j' }, { ...ctx, items: [], selected: null })).toBeNull()
  expect(keyAction({ ...event, key: 'k' }, ctx)).toBeNull()
  expect(keyAction({ ...event, key: '3' }, ctx)).toBeNull()
  expect(keyAction({ ...event, repeat: true }, ctx)).toBeNull()
  expect(keyAction(event, { ...ctx, selected: null })).toBeNull()
  expect(keyAction(event, { ...ctx, choice: { ...ctx.choice, disabled: true } })).toBeNull()
  expect(keyAction(event, { ...ctx, choice: { ...ctx.choice, reason: 'read only' } })).toBeNull()
  expect(keyAction(event, { ...ctx, focused: null })).toBeNull()
  for (const key of ['2', 'j']) {
    const press = { ...event, key }
    expect(keyAction({ ...press, target: {} }, ctx)).toBeNull()
    for (const ancestor of ['input', 'textarea', 'select', '[contenteditable]']) {
      const editable = { closest: (selectors: string) => selectors.split(',').some((selector) => selector.trim() === ancestor) ? {} : null }
      expect(keyAction({ ...press, target: editable, currentTarget: editable }, { ...ctx, focused: editable })).toBeNull()
    }
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'defaultPrevented'] as const) {
      expect(keyAction({ ...press, [modifier]: true }, ctx)).toBeNull()
    }
    expect(keyAction({ ...press, nativeEvent: { isComposing: true } }, ctx)).toBeNull()
  }
})
