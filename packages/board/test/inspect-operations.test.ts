import { describe, expect, it } from 'vitest'
import { appearance, initialState, merge, operatorReports, reviewQueue, themeFor } from '../src/inspect/app/store.ts'
import { testBoard } from './harness.ts'

describe('the operator console', () => {
  it('only queues tasks the board holds for approval, and removes them when the hold ends', async () => {
    const board = testBoard()
    const { task: needsReview } = await board.tasks.create('work', 'Check the candidate')
    const { task: needsInput } = await board.tasks.create('work', 'Clarify the requirements')
    const { task: tagged } = await board.tasks.create('work', { text: 'Not in review', labels: { review: 'awaiting_approval' } })
    const held = await board.tasks.block(needsReview.id, 'review the candidate', { kind: 'awaiting_approval' })
    const input = await board.tasks.block(needsInput.id, 'Which tenant?', { kind: 'needs_input' })
    const state = merge(initialState, [held, input, tagged])
    expect(reviewQueue(state).map((row) => row.text)).toEqual(['Check the candidate'])

    const released = await board.tasks.unblock(needsReview.id)
    expect(reviewQueue(merge(state, [released, held]))).toEqual([])
  })

  it('shows the newest report root in the designated channel, not replies or other channels', async () => {
    const board = testBoard()
    const channel = 'ops/model-scoreboard'
    const router = board.as('router')
    const old = await router.post(channel, 'Previous scores')
    board.clock.skip(1_000)
    const current = await router.post(channel, 'Current scores')
    board.clock.skip(1_000)
    const reply = await board.reply(old.id, 'A comment on previous scores')
    const elsewhere = await board.post('ops/provider-access', 'Provider incident')
    const state = merge(initialState, [old, current, reply, elsewhere])
    expect(operatorReports(state, channel, 1)).toMatchObject([{ text: 'Current scores', by: { actor: current.by.actor } }])

    await router.delete(current.id)
    const { message: deleted } = await board.thread(current.id)
    expect(operatorReports(merge(state, [deleted, current]), channel, 1)).toMatchObject([{ text: 'Previous scores' }])
  })

  it('honors browser theme overrides, and falls back independently for old preferences', () => {
    expect(appearance({ theme: 'unsupported', density: 'compact' })).toEqual({ theme: 'system', density: 'compact' })
    expect(appearance({ theme: 'dark', density: 'unsupported' })).toEqual({ theme: 'dark', density: 'comfortable' })
    expect(themeFor('system', true)).toBe('dark')
    expect(themeFor('system', false)).toBe('light')
    expect(themeFor('dark', false)).toBe('dark')
    expect(themeFor('light', true)).toBe('light')
  })
})
