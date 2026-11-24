import { expect, it } from 'vitest'
import { initialState, merge, readFilter, tasks, type TaskRoot } from '../src/inspect/app/store.ts'

const viewer = { actor: 'user:reader+worker', principal: 'user:reader', may: () => true }
const now = Date.parse('2026-11-01T00:00:00Z')

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

it('filters to normal priority within the requested state and channel tree', () => {
  const state = merge(initialState, [root(1, 'normal'), root(2, 'urgent'), root(3, 'normal', { state: 'completed' }), { ...root(4, 'normal'), channel: 'other' }, { ...root(5, 'normal'), channel: 'work/review' }])
  expect(ids(tasks({ ...state, openTaskRoots: state.messages }, { state: 'ready', label: [], channel: 'work/', priority: 'normal' }, now))).toEqual(['1', '5'])
})

it('parses a priority URL filter alongside state and channel and ignores unknown priorities', () => {
  expect(readFilter(new URLSearchParams('state=ready&channel=work%2F&priority=urgent'))).toEqual({ state: 'ready', channel: 'work/', priority: 'urgent', label: [] })
  expect(readFilter(new URLSearchParams('priority=critical'))).toEqual({ state: 'open', label: [] })
})
