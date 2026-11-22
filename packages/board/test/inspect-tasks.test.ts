import { expect, it } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { byClaimOrder, initialState, isTask, merge, readFilter, tasks, type TaskFilter, type TaskRoot } from '../src/inspect/app/store.ts'
import { BOARD_URL, personToken, testBoard } from './harness.ts'

const viewer = { actor: 'user:reader+worker', principal: 'user:reader', may: () => true }
const now = Date.parse('2026-11-01T00:00:00Z')
const filter: TaskFilter = { state: 'all', label: [] }

function root(id: number, priority: TaskRoot['task']['priority'], extra: Partial<TaskRoot['task']> = {}, second = id): TaskRoot {
  return {
    id: String(id), version: id, revision: id, channel: 'work', text: `Task ${id}`, re: null, replyTo: null,
    thread: `t${id}`, labels: {}, reactions: {}, by: { actor: viewer.actor, principal: viewer.principal, profile: 'worker' },
    noSync: false, origin: null, from: null, blocks: [], createdAt: new Date(now + second * 1000).toISOString(),
    editedAt: null, deleted: false, undelivered: {}, attachments: [], links: [], author: null,
    task: { state: 'ready', priority, owner: viewer.principal, by: viewer.actor, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null, ...extra },
  }
}

const ids = (rows: TaskRoot[]) => rows.map((row) => row.id)

it('sorts loaded tasks by priority and then oldest even when finished tasks are included', () => {
  const state = merge(initialState, [root(6, 'high'), root(1, 'low'), root(5, 'urgent', { state: 'completed' }), root(2, 'lowest'), root(3, 'normal'), root(9, 'high', {}, 6), root(10, 'high', {}, 5)])
  expect(ids(tasks(state, filter, now, undefined, viewer))).toEqual(['5', '10', '6', '9', '3', '1', '2'])
})

it('prefers tasks assigned to the viewer only within their priority', () => {
  const state = merge(initialState, [root(1, 'high'), root(2, 'low', { for: viewer.actor }), root(3, 'high', { for: viewer.actor }), root(4, 'urgent'), root(5, 'high', { for: 'user:reader+reviewer' })])
  expect(ids(tasks(state, filter, now, undefined, viewer))).toEqual(['4', '3', '1', '5', '2'])
})

it('filters to normal priority within the requested state and channel tree', () => {
  const state = merge(initialState, [root(1, 'normal'), root(2, 'urgent'), root(3, 'normal', { state: 'completed' }), { ...root(4, 'normal'), channel: 'other' }, { ...root(5, 'normal'), channel: 'work/review' }])
  expect(ids(tasks(state, { state: 'ready', label: [], channel: 'work/', priority: 'normal' }, now, undefined, viewer))).toEqual(['1', '5'])
})

it('parses a priority URL filter alongside state and channel and ignores unknown priorities', () => {
  expect(readFilter(new URLSearchParams('state=ready&channel=work%2F&priority=urgent'))).toEqual({ state: 'ready', channel: 'work/', priority: 'urgent', label: [] })
  expect(readFilter(new URLSearchParams('priority=critical'))).toEqual({ state: 'open', label: [] })
})

it('orders ready unparked tasks the same way the board claims them', async () => {
  const board = testBoard()
  const token = await personToken('u_reader', BOARD_URL)
  const caller = createBoardClient({ url: BOARD_URL, token, profile: 'worker', fetch: (input, init) => board.fetch(new Request(input, init)) })
  const me = await caller.me()
  await caller.tasks.create('work', { text: 'Oldest high', priority: 'high' })
  await caller.tasks.create('work', { text: 'Default priority' })
  await caller.tasks.create('work', { text: 'Urgent', priority: 'urgent' })
  await caller.tasks.create('work', { text: 'Newer high for caller', priority: 'high', for: me.actor })
  await caller.tasks.create('work', { text: 'Newest high', priority: 'high' })

  const { tasks: listed } = await caller.tasks.list({ channel: 'work', state: 'ready' })
  const ordered = listed.map(({ message }) => message).filter(isTask).sort((a, b) => byClaimOrder(a, b, me))
  expect(ordered).toHaveLength(5)
  for (const expected of ordered) {
    expect((await caller.tasks.claim({ channel: 'work' }))?.task.id, expected.text).toBe(expected.id)
  }
  expect(await caller.tasks.claim({ channel: 'work' })).toBeNull()
})
