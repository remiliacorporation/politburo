import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  defaultConfig, drill, history, leaderboard, orderReadyToPull, scorecard, scoreRules,
  type ScoreInput,
} from '../src/index.ts'

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString()
const rules = scoreRules(defaultConfig())
const asOf = day(20)
const at = { party: 'A', asOf }
const empty = (): ScoreInput => ({ dispatches: [], spend: [], outcomes: [], facts: [] })

// The same envelope and outcome shapes as scoring.test.ts, with fixed dates and IDs.
function merged(party: string, work_id = 'work-0') {
  const key = { party, work_id, attempt: '1' }
  const id = `${party}-${work_id}`
  const dispatch = {
    ...key, repo: 'acme/web', tier: 'sprite' as const, parent: null, session: id,
    trace: { id, execution_id: `run-${id}` },
  }
  const outcome = {
    ...key, contract_revision: 1, result: 'valid' as const, outcome: { kind: 'pr', index: 0 },
    checked_at: day(1), evidence: 'acme/web#1', verifier_version: '1', override: null,
  }
  const fact = { ...key, fact_id: `merge-${id}`, at: day(1), kind: 'merged' as const, pr: 'acme/web#1' }
  return { dispatch, outcome, fact }
}

test('GATE: score changes queue order, a queue sort key is wrong, or the input is mutated', () => {
  const items = [
    { work_id: 'work-0', priority: 1, ready_at: day(1), party: 'A' },
    { work_id: 'work-1', priority: 2, ready_at: day(3), party: 'A' },
    { work_id: 'work-a', priority: 2, ready_at: day(2), party: 'B' },
    { work_id: 'work-Z', priority: 2, ready_at: day(2), party: 'A' },
  ]
  const before = structuredClone(items)
  const expected = [before[3], before[2], before[1], before[0]]
  for (const [winner, loser] of [['A', 'B'], ['B', 'A']] as const) {
    const wins = [0, 1, 2, 3].map(i => merged(winner, `win-${i}`))
    const input: ScoreInput = {
      ...empty(), outcomes: [...wins.map(w => w.outcome), merged(loser, 'unmerged').outcome],
      facts: wins.map(w => w.fact),
    }
    const rows = leaderboard(input, rules, { asOf })
    assert.deepEqual(rows.map(({ party, total }) => [party, total]), [[winner, 4 * rules.merged_work], [loser, 0]])
    assert.deepEqual(orderReadyToPull(items), expected, `queue order when ${winner} leads`)
    assert.deepEqual(items, before, 'sorting changed the shared queue')
  }
})

test('someone wires a score into queue order', () => {
  const source = readFileSync(new URL('../src/scoring/queue-order.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bimport\b(?!\s*\.)/, 'queue order must not import anything')
})

test('leaderboard misranks ties or drops a party with no merges', () => {
  const a = merged('A'), b = merged('B'), c = merged('C', 'work-1')
  const input = { ...empty(), outcomes: [c.outcome, b.outcome, a.outcome], facts: [c.fact, b.fact] }
  const rows = leaderboard(input, rules, { asOf })
  assert.deepEqual(rows.map(({ party, rank, total }) => [party, rank, total]), [
    ['B', 1, rules.merged_work], ['C', 1, rules.merged_work], ['A', 3, 0],
  ])
})

test('scorecard item totals disagree or party overhead is missing or not last', () => {
  const z = merged('A', 'work-z'), a = merged('A', 'work-a')
  const minutes = { ...z.fact, kind: 'human_minutes' as const, fact_id: 'minutes', minutes: rules.human_minutes.per_point }
  const input = { ...empty(), outcomes: [z.outcome, a.outcome], facts: [z.fact, a.fact, minutes] }
  const { items, total } = scorecard(input, rules, at)
  assert.deepEqual(items.map(item => item.work_id), ['work-a', 'work-z', null], 'item order')
  assert.deepEqual(items[2]!.contributions.map(({ rule, work_id, points }) => [rule, work_id, points]), [
    ['human_minutes', null, -1],
  ], 'party overhead contributions')
  assert.equal(items.reduce((sum, item) => sum + item.total, 0), total, 'sum of item totals')
  for (const item of items) {
    assert.ok(item.contributions.every(c => c.work_id === item.work_id), 'contribution in the wrong item')
    assert.equal(item.total, item.contributions.reduce((sum, c) => sum + c.points, 0), 'sum within an item')
  }
})

test('drill resolves the wrong records or accepts a work item without contributions', () => {
  const { dispatch, outcome, fact } = merged('A')
  const spend: ScoreInput['spend'][number] = {
    record_id: 'spend-A', dedupe_key: 'A', revises: null, envelope: dispatch,
    coverage: { state: 'closed_reconciled' },
    tokens: {
      input_total: 10_000_000, output: 0, input_uncached: null, cache_read: null, cache_write: null, reasoning: null,
    },
  }
  const idle = merged('A', 'unmerged').outcome
  const input = { dispatches: [dispatch], spend: [spend], outcomes: [idle, outcome], facts: [fact] }
  const { records } = drill(input, rules, { ...at, work_id: fact.work_id })
  const expected = [
    ['spend', spend.record_id, spend], ['dispatch', dispatch.trace.execution_id, dispatch],
    ['outcome', `${outcome.work_id}#${outcome.attempt}@${outcome.checked_at}`, outcome],
    ['fact', fact.fact_id, fact],
  ] as const
  assert.equal(records.length, expected.length)
  for (const [kind, id, record] of expected) {
    assert.equal(records.find(r => r.ref.kind === kind && r.ref.id === id)?.record, record, `${kind}/${id}`)
  }
  assert.throws(() => drill(input, rules, { ...at, work_id: idle.work_id }), /no score contributions/)
})

test('history is out of order or a late revert changes the wrong snapshot', () => {
  const { outcome, fact } = merged('A')
  const revertAt = day(18)
  const before = new Date(Date.parse(revertAt) - 1).toISOString()
  const revert = { ...fact, kind: 'reverted' as const, fact_id: 'late-revert', at: revertAt }
  const input = { ...empty(), outcomes: [outcome], facts: [revert, fact] }
  const points = history(input, rules, { party: 'A', asOfs: [revertAt, day(2), before] })
  assert.deepEqual(points.map(p => [p.asOf, p.total]), [[day(2), 0], [before, rules.merged_work], [revertAt, -rules.revert]])
})
