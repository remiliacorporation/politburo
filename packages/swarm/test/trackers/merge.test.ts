import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeWorkItems, type Observation } from '../../src/trackers/index.ts'

const gh = 'github:o/r', lin = 'linear:KEY'
const at = '2026-01-01T00:00:00Z'
const obs = (source: string, state: Observation['state'], labels = ['work:7']): Observation => ({
  ref: { source, itemId: '7', displayId: source === lin ? 'KEY-7' : '7', url: 'https://example.invalid/7' },
  title: 'issue 7', rawState: state, state, labels, priority: 'none', assignees: [], updatedAt: at, observedAt: at,
})
const precedence = [lin, gh]

test('merge splits linked issues or loses ordered badges and the winning state', () => {
  const linked = [obs(gh, 'done', ['WORK:7']), obs(lin, 'open')]
  const unlabelled = linked.map((item) => ({ ...item, labels: [] }))
  for (const items of [
    mergeWorkItems(linked, { precedence }),
    mergeWorkItems(unlabelled, { precedence, links: [{ workId: '7', refs: unlabelled.map(({ ref }) => ref) }] }),
  ]) {
    assert.deepEqual(items.map(({ workId, badges, state, observations }) =>
      ({ workId, badges, state, sources: observations.map(({ ref }) => ref.source) })),
      [{ workId: '7', badges: ['LIN KEY-7', 'GH#7'], state: 'open', sources: [lin, gh] }])
  }
})

test('merge conflates unlinked issues with identical titles and numbers', () => {
  const items = mergeWorkItems([obs(gh, 'done', []), obs(lin, 'open', [])], { precedence })
  assert.deepEqual(items.map(({ key, observations }) => [key, observations.length]).sort(),
    [[`ref:${gh}:7`, 1], [`ref:${lin}:7`, 1]])
})

test('merge ignores precedence or lets unlisted sources and input order decide the result', () => {
  const a = 'github:a/r', z = 'github:z/r'
  const unlisted = obs(a, 'withdrawn')
  unlisted.ref = { ...unlisted.ref, itemId: '9', displayId: '9' }
  const sibling = obs(z, 'open')
  sibling.ref = { ...sibling.ref, itemId: '8', displayId: '8' }
  const inputs = [obs(z, 'done'), unlisted, obs(gh, 'done'), obs(lin, 'open'), sibling, obs(z, 'open', [])]
  const forward = mergeWorkItems(inputs, { precedence })
  const reverse = mergeWorkItems(inputs, { precedence: [gh, lin] })
  const linked = forward.find(({ workId }) => workId === '7')!
  const flipped = reverse.find(({ workId }) => workId === '7')!
  assert.deepEqual(linked.observations.map(({ ref }) => ref.source), [lin, gh, a, z, z])
  assert.deepEqual([linked.state, linked.stateSource], ['open', lin])
  assert.deepEqual([flipped.state, flipped.stateSource], ['done', gh])
  let seed = 407
  for (let i = 0; i < 100; i++) {
    const shuffled = [...inputs]
    for (let j = shuffled.length - 1; j > 0; j--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const k = Math.floor((seed / 2 ** 32) * (j + 1))
      ;[shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!]
    }
    assert.deepEqual(mergeWorkItems(shuffled, { precedence }), forward)
    assert.deepEqual(mergeWorkItems(shuffled, { precedence: [gh, lin] }), reverse)
  }
})

test('merge lets unknown win, invents a known state, or hides disagreements', () => {
  const [known] = mergeWorkItems([obs(lin, 'unknown'), obs(gh, 'done')], { precedence })
  assert.equal(known!.state, 'done')
  assert.equal(known!.stateSource, gh)
  assert.deepEqual(known!.disagreements, [{ source: lin, state: 'unknown' }])
  const [unknown] = mergeWorkItems([obs(gh, 'unknown'), obs(lin, 'unknown')], { precedence })
  assert.equal(unknown!.state, 'unknown')
  assert.equal(unknown!.stateSource, undefined)
  assert.deepEqual(unknown!.disagreements, [])
})

test('merge joins an issue with conflicting work ids or omits its conflict note', () => {
  const items = mergeWorkItems([obs(gh, 'done', ['work:7', 'work:8']), obs(lin, 'open')], { precedence })
  const conflict = items.find(({ key }) => key === `ref:${gh}:7`)
  const linked = items.find(({ workId }) => workId === '7')
  assert.deepEqual(conflict?.badges, ['GH#7'])
  assert.match(conflict?.conflict ?? '', /conflict/i)
  assert.deepEqual(linked?.badges, ['LIN KEY-7'])
})

test('merge presents partial or errored observations as fresh, or complete ones as stale', () => {
  const other = 'github:o/2'
  for (const status of ['partial', 'error', 'complete'] as const) {
    const items = mergeWorkItems([obs(gh, 'done'), obs(lin, 'open'), obs(other, 'open', [])], {
      precedence, sourceStatus: { [gh]: status, [lin]: 'complete', [other]: 'complete' },
    })
    assert.equal(items.find(({ workId }) => workId === '7')?.stale, status !== 'complete', status)
    assert.equal(items.find(({ key }) => key === `ref:${other}:7`)?.stale, false, status)
  }
})
