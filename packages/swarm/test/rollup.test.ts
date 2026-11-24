import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ingest, rollupBy, rollupLevel, validateRecord, type EnvelopeField, type Totals } from '../src/ledger/index.ts'
import { dispatch, memory, record, seedHierarchy } from './support.ts'

const output = (totals: Totals) => totals.tokens.output.known

test('unknowns are not zeroes and quota snapshots are not token counts', (t) => {
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

  for (const [value, quality] of [[null, 'provider_reported'], [0, 'unknown'], [50, 'quota_snapshot']] as const) {
    assert.throws(() => validateRecord({ ...unknown, tokens: { ...unknown.tokens, output: value },
      coverage: { ...unknown.coverage, field_quality: { ...unknown.coverage.field_quality, 'tokens.output': quality } },
    }), { code: 'invalid' }, `output ${value} cannot be marked ${quality}`)
  }
})

test('rollups keep descendants and historical sponsors, scope whole groups and sort keys', (t) => {
  const ledger = memory(t)
  seedHierarchy(ledger)
  // [key, own output, inclusive output, own records, inclusive records]
  const expected = {
    sprite: [[{ execution_id: 'sprite' }, 13, 13, 1, 1]],
    mob: [[{ execution_id: 'mob' }, 7, 48, 1, 4], [{ execution_id: 'submob' }, 11, 24, 1, 2]],
    // Only the direct secretary is own spend; the secretary under the mob is inclusive only.
    work_item: [[{ party: 'party', repo: 'repo', work_id: 'work' }, 5, 53, 1, 5]],
    spawner: [[{ execution_id: 'new-spawner' }, 3, 3, 1, 1], [{ execution_id: 'old-spawner' }, 2, 55, 1, 6]],
    repo: [[{ party: 'party', repo: 'repo' }, 3, 56, 1, 6]],
    party: [[{ party: 'party' }, 2, 58, 1, 7]],
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
  assert.deepEqual(scoped.map((row) => [row.key.execution_id, output(row.inclusive)]), [['mob', 48]],
    'scoping selects the mob but keeps its transitive descendants')

  const groups: Record<EnvelopeField, [string | null, number][]> = {
    party: [['party', 58]], repo: [[null, 2], ['repo', 56]], work_id: [[null, 5], ['work', 53]],
    attempt: [[null, 5], ['attempt', 53]], tier: [['spawner', 5], ['secretary', 22], ['mob', 18], ['sprite', 13]],
    parent: [[null, 10], ['old-spawner', 7], ['mob', 28], ['submob', 13]], trace_id: [['trace', 58]],
    session: [['session:old-spawner', 2], ['session:new-spawner', 3], ['session:direct', 5],
      ['session:mob', 7], ['session:submob', 11], ['session:sprite', 13], ['session:child-secretary', 17]],
    execution_id: [['old-spawner', 2], ['new-spawner', 3], ['direct', 5], ['mob', 7], ['submob', 11], ['sprite', 13],
      ['child-secretary', 17]],
    sponsor: [[null, 5], ['old-spawner', 53]],
  }
  for (const field of Object.keys(groups) as EnvelopeField[]) {
    assert.deepEqual(new Map(rollupBy(ledger, field).map((r) => [r.key[field], output(r.totals)])),
      new Map(groups[field]), `rollupBy ${field} must preserve distinct groups, including null overhead`)
  }
  assert.deepEqual(rollupBy(ledger, 'execution_id').map(({ key }) => key.execution_id),
    ['child-secretary', 'direct', 'mob', 'new-spawner', 'old-spawner', 'sprite', 'submob'],
    'rollupBy orders keys independently of dispatch insertion order')

  ledger.createDispatch(dispatch('other-exec', { party: 'other-party' }))
  for (const level of ['party', 'repo', 'work_item'] as const) {
    const wholeGroup = rollupLevel(ledger, level).filter(({ key }) => key.party === 'party')
    assert.deepEqual(rollupLevel(ledger, level, { execution_id: 'mob' }), wholeGroup,
      `execution scope selects a whole ${level} group without shrinking its totals`)
  }
})

test('totals keep bases and currencies separate without rounding or booking unknown spend as zero', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  const samples = [
    ['estimate-a', 'priced_estimate', 'USD', '0.1', 'priced_estimate', 20],
    ['estimate-b', 'priced_estimate', 'USD', '0.2', 'priced_estimate', 30],
    ['bill', 'settled_charge', 'USD', '0.4', 'provider_charge', null],
    ['bill-eur', 'settled_charge', 'EUR', '0.6', 'provider_charge', null],
    ['effort', 'measured_resource', 'worker_seconds', '2.5', 'locally_measured', null],
  ] as const
  for (const [id, basis, unit, value, quality, tokens] of samples) {
    const fact = record(id, d.envelope, tokens)
    ingest(ledger, { ...fact, amount: { value, unit }, basis,
      coverage: { ...fact.coverage, field_quality: { ...fact.coverage.field_quality, amount: quality } } })
  }
  ingest(ledger, record('unknown', d.envelope, 5))
  const totals = rollupLevel(ledger, 'party')[0]!.inclusive
  assert.deepEqual(totals.amounts, [
    { basis: 'measured_resource', unit: 'worker_seconds', known: '2.5', records: 1 },
    { basis: 'priced_estimate', unit: 'USD', known: '0.3', records: 2 },
    { basis: 'settled_charge', unit: 'EUR', known: '0.6', records: 1 },
    { basis: 'settled_charge', unit: 'USD', known: '0.4', records: 1 },
  ], 'settled charges of different currencies must have separate rows')
  assert.deepEqual(totals.tokens.output, { known: 55, known_records: 3, unknown_records: 3 })
  assert.equal(totals.amount_unknown_records, 1)
})

test('conflict heads count as coverage gaps, never as known tokens or amounts', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  const disputed = record('disputed', d.envelope, 50)
  ingest(ledger, { ...disputed, basis: 'settled_charge', amount: { value: '1.25', unit: 'USD' },
    coverage: { state: 'conflict', field_quality: {
      ...disputed.coverage.field_quality, amount: 'provider_charge', 'tokens.reasoning': 'not_applicable',
    } } })
  const totals = rollupBy(ledger, 'party')[0]!.totals
  assert.deepEqual(totals.tokens.output, { known: 0, known_records: 0, unknown_records: 1 },
    'disputed output must be unknown, not 50 known tokens')
  assert.equal(totals.tokens.input_total.unknown_records, 1)
  assert.equal(totals.tokens.reasoning.unknown_records, 0)
  assert.deepEqual(totals.amounts, [], 'disputed settled charges do not enter known amounts')
  assert.equal(totals.amount_unknown_records, 1)
  assert.equal(totals.coverage.conflict, 1)

  const tokenOnly = dispatch('token-only')
  ledger.createDispatch(tokenOnly)
  const disputedTokens = record('disputed-tokens', tokenOnly.envelope, 9)
  ingest(ledger, { ...disputedTokens, basis: 'not_applicable', coverage: { state: 'conflict',
    field_quality: { ...disputedTokens.coverage.field_quality, amount: 'not_applicable' } } })
  assert.equal(rollupBy(ledger, 'party')[0]!.totals.amount_unknown_records, 1,
    'a disputed record with no applicable amount adds no unknown amount')
})

test('token subtotals throw instead of rounding past the safe integer range', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  ingest(ledger, record('large-response', d.envelope, Number.MAX_SAFE_INTEGER))
  assert.equal(output(rollupBy(ledger, 'party')[0]!.totals), Number.MAX_SAFE_INTEGER)
  ingest(ledger, record('small-response', d.envelope, 2))
  assert.throws(() => rollupBy(ledger, 'party'), RangeError, 'individually safe counts can exceed the safe subtotal')
})
