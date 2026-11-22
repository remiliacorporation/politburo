import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ingest, rollupBy, rollupLevel, validateRecord, type EnvelopeField, type Totals } from '../src/ledger/index.ts'
import { dispatch, memory, record, seedHierarchy } from './support.ts'

const output = (totals: Totals) => totals.tokens.output.known

test('unknown tokens and missing executions remain coverage gaps, not reported zeroes', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  ingest(ledger, record('reported', d.envelope, 120))
  ingest(ledger, record('zero', d.envelope, 0))
  const unknown = record('unknown', d.envelope, null)
  ingest(ledger, { ...unknown, coverage: { ...unknown.coverage,
    field_quality: { ...unknown.coverage.field_quality, 'tokens.reasoning': 'not_applicable' } } })
  const before = rollupBy(ledger, 'party')[0]!.totals
  assert.deepEqual(before.tokens.output, { known: 120, known_records: 2, unknown_records: 1 },
    'only the reported zero, not the null count, is known')
  assert.deepEqual(before.tokens.reasoning, { known: 0, known_records: 0, unknown_records: 2 },
    'not applicable is neither known nor unknown')
  assert.equal(before.amount_unknown_records, 3)

  ledger.createDispatch(dispatch('awaiting-usage'))
  const after = rollupBy(ledger, 'party')[0]!.totals
  assert.deepEqual(after.executions, { total: 2, without_records: 1 })
  for (const bucket of Object.keys(before.tokens) as (keyof Totals['tokens'])[]) {
    const prior = before.tokens[bucket]
    assert.deepEqual(after.tokens[bucket], { ...prior, unknown_records: prior.unknown_records + 1 },
      `a missing execution adds one gap to ${bucket}`)
  }
  assert.equal(after.amount_unknown_records, 4)

  for (const [value, quality] of [[null, 'provider_reported'], [0, 'unknown']] as const) {
    assert.throws(() => validateRecord({ ...unknown, tokens: { ...unknown.tokens, output: value },
      coverage: { ...unknown.coverage, field_quality: { ...unknown.coverage.field_quality, 'tokens.output': quality } },
    }), { code: 'invalid' }, `output ${value} cannot be marked ${quality}`)
  }
})

test('hierarchy rollups neither drop descendants or historical sponsors nor double-count party spend', (t) => {
  const ledger = memory(t)
  seedHierarchy(ledger)
  // [key, own output, inclusive output, own records, inclusive records]
  const expected = {
    sprite: [[{ execution_id: 'sprite' }, 13, 13, 1, 1]],
    mob: [[{ execution_id: 'mob' }, 7, 31, 1, 3], [{ execution_id: 'submob' }, 11, 24, 1, 2]],
    work_item: [[{ party: 'party', repo: 'repo', work_id: 'work' }, 5, 36, 1, 4]],
    spawner: [[{ execution_id: 'new-spawner' }, 3, 3, 1, 1], [{ execution_id: 'old-spawner' }, 2, 38, 1, 5]],
    repo: [[{ party: 'party', repo: 'repo' }, 3, 39, 1, 5]],
    party: [[{ party: 'party' }, 2, 41, 1, 6]],
  } as const
  for (const level of ['sprite', 'mob', 'work_item', 'spawner', 'repo', 'party'] as const) {
    const rows = rollupLevel(ledger, level)
    assert.equal(rows.length, expected[level].length, `${level} row count`)
    for (const [key, own, inclusive, ownRecords, inclusiveRecords] of expected[level]) {
      const row = rows.find((r) => Object.entries(key).every(([field, value]) => r.key[field] === value))
      assert.ok(row, `${level} must include ${JSON.stringify(key)}`)
      assert.deepEqual([row.key, output(row.own), output(row.inclusive), row.own.records, row.inclusive.records],
        [key, own, inclusive, ownRecords, inclusiveRecords], `${level} ${JSON.stringify(key)} own and inclusive totals`)
    }
  }
  const scoped = rollupLevel(ledger, 'mob', { execution_id: 'mob' })
  assert.deepEqual(scoped.map((row) => [row.key.execution_id, output(row.inclusive)]), [['mob', 31]],
    'scoping selects the mob but keeps its transitive descendants')

  const groups: Record<EnvelopeField, [string | null, number][]> = {
    party: [['party', 41]], repo: [[null, 2], ['repo', 39]], work_id: [[null, 5], ['work', 36]],
    attempt: [[null, 5], ['attempt', 36]], tier: [['spawner', 5], ['secretary', 5], ['mob', 18], ['sprite', 13]],
    parent: [[null, 10], ['old-spawner', 7], ['mob', 11], ['submob', 13]], trace_id: [['trace', 41]],
    session: [['session:old-spawner', 2], ['session:new-spawner', 3], ['session:direct', 5],
      ['session:mob', 7], ['session:submob', 11], ['session:sprite', 13]],
    execution_id: [['old-spawner', 2], ['new-spawner', 3], ['direct', 5], ['mob', 7], ['submob', 11], ['sprite', 13]],
    sponsor: [[null, 5], ['old-spawner', 36]],
  }
  for (const field of Object.keys(groups) as EnvelopeField[]) {
    assert.deepEqual(new Map(rollupBy(ledger, field).map((r) => [r.key[field], output(r.totals)])),
      new Map(groups[field]), `rollupBy ${field} must preserve distinct groups, including null overhead`)
  }
})

test('totals never mix meters or round decimals or book unknown spend as zero', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  const samples = [
    ['estimate-a', 'priced_estimate', 'USD', '0.1', 'priced_estimate', 20],
    ['estimate-b', 'priced_estimate', 'USD', '0.2', 'priced_estimate', 30],
    ['bill', 'settled_charge', 'USD', '0.4', 'provider_charge', null],
    ['effort', 'measured_resource', 'worker_seconds', '2.5', 'locally_measured', null],
  ] as const
  for (const [id, basis, unit, value, quality, tokens] of samples) {
    const fact = record(id, d.envelope, tokens)
    ingest(ledger, { ...fact, amount: { value, unit }, basis,
      coverage: { ...fact.coverage, field_quality: { ...fact.coverage.field_quality, amount: quality } } })
  }
  ingest(ledger, record('unknown', d.envelope, 5))
  const totals = rollupLevel(ledger, 'party')[0]!.inclusive
  assert.equal(totals.amounts.length, 3, 'estimates, settled charges and resources must stay separate')
  assert.deepEqual(new Map(totals.amounts.map(({ basis, ...row }) => [basis, row])), new Map([
    ['priced_estimate', { unit: 'USD', known: '0.3', records: 2 }],
    ['settled_charge', { unit: 'USD', known: '0.4', records: 1 }],
    ['measured_resource', { unit: 'worker_seconds', known: '2.5', records: 1 }],
  ]))
  assert.deepEqual(totals.tokens.output, { known: 55, known_records: 3, unknown_records: 2 })
  assert.equal(totals.amount_unknown_records, 1)
})
