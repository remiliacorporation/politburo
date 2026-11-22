import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BenchRun } from '@remilia/politburo-runtime'
import { bind, correct, fromBenchRun, ingest, rollupLevel, unmatched, validateRecord } from '../src/ledger/index.ts'
import { dispatch, memory, record, time } from './support.ts'

const audit = { actor: 'operator', reason: 'reconcile usage', received: time }

test('ingest refuses missing or changed envelopes and dispatch creation cannot replace them', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  const fact = record('original', d.envelope)
  const changed = { ...d, envelope: { ...d.envelope, repo: 'other-repo' } }
  assert.throws(() => ingest(ledger, fact), { code: 'unknown_dispatch' })
  assert.equal(ledger.createDispatch(d).outcome, 'created')
  assert.throws(() => ingest(ledger, { ...fact, envelope: changed.envelope }),
    { code: 'envelope_mismatch' }, 'a submitted envelope cannot change the repo')
  assert.throws(() => ledger.createDispatch(changed), { code: 'dispatch_conflict' })
  assert.equal(ledger.createDispatch(d).outcome, 'existing')
  assert.deepEqual(ledger.dispatch('exec'), d)
  assert.equal(ledger.record(fact.record_id), null)
})

test('replayed and conflicting dedupe keys add no spend and cannot reuse a record id', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  const original = record('original', d.envelope)
  assert.deepEqual(ingest(ledger, original), { outcome: 'appended', record_id: 'original' })
  const before = rollupLevel(ledger, 'party')
  assert.deepEqual(ingest(ledger, original), { outcome: 'duplicate', record_id: 'original' })
  assert.deepEqual(rollupLevel(ledger, 'party'), before, 'replay must leave totals unchanged')
  const changed = { ...record('changed', d.envelope, 90), dedupe_key: original.dedupe_key }
  assert.deepEqual(ingest(ledger, changed), { outcome: 'dedupe_mismatch', record_id: 'original' },
    'a conflicting replay must be reported as a mismatch')
  assert.equal(ledger.record('changed'), null)
  assert.throws(() => ingest(ledger, { ...original, dedupe_key: 'new-key' }), { code: 'record_id_taken' })
  assert.deepEqual(ledger.record('original'), original)
  assert.deepEqual(rollupLevel(ledger, 'party'), before)
})

test('a correction counts only its head, preserves history and refuses branching, moving or unaudited revisions', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  const other = dispatch('other')
  ledger.createDispatch(d)
  ledger.createDispatch(other)
  const original = record('original', d.envelope, 10)
  ingest(ledger, original)
  const changes = { tokens: { ...original.tokens, output: 23 } }
  const revision = { ...audit, revises: 'original', record_id: 'fixed', dedupe_key: 'fix:1', changes }
  assert.equal(correct(ledger, revision).outcome, 'appended')
  const [party] = rollupLevel(ledger, 'party')
  assert.equal(party!.inclusive.tokens.output.known, 23, 'only the corrected amount should roll up')
  assert.equal(party!.inclusive.records, 1)
  const head = { ...original, ...audit, ...changes, revises: 'original', record_id: 'fixed', dedupe_key: 'fix:1' }
  assert.deepEqual(ledger.chain('fixed'), [original, head])
  assert.deepEqual(ledger.record('original'), original)
  assert.throws(() => correct(ledger, { ...revision, record_id: 'fork', dedupe_key: 'fix:fork' }),
    { code: 'already_revised' })
  const next = { ...head, revises: 'fixed', record_id: 'next', dedupe_key: 'fix:2' }
  assert.throws(() => ingest(ledger, { ...next, envelope: other.envelope }), { code: 'moves_charge' })
  const { actor, reason, ...unaudited } = next
  assert.throws(() => ingest(ledger, { ...unaudited, reason }), { code: 'invalid' }, 'actor is required')
  assert.throws(() => ingest(ledger, { ...unaudited, actor }), { code: 'invalid' }, 'reason is required')
})

test('unbound spend keeps unknowns visible and stays out of party and repo totals until bound once', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  const original = record('unbound', null, 37)
  const binding = {
    ...audit, record_id: 'unbound', execution_id: 'exec', new_record_id: 'bound', dedupe_key: 'bind:1', state: 'partial',
  } as const
  ingest(ledger, original)
  assert.equal(unmatched(ledger).records, 1)
  assert.equal(unmatched(ledger).tokens.output.known, 37)
  assert.deepEqual(rollupLevel(ledger, 'party'), [])
  assert.deepEqual(rollupLevel(ledger, 'repo'), [])
  assert.throws(() => bind(ledger, binding), { code: 'unknown_dispatch' })
  ledger.createDispatch(d)
  for (const level of ['party', 'repo'] as const) {
    const [row] = rollupLevel(ledger, level)
    assert.equal(row!.inclusive.records, 0, `unmatched spend must not enter an existing ${level}`)
  }
  assert.throws(() => ingest(ledger, { ...original, coverage: { ...original.coverage, state: 'partial' } }),
    { code: 'invalid' })
  assert.throws(() => ingest(ledger, { ...original, envelope: d.envelope }), { code: 'invalid' })

  assert.deepEqual(bind(ledger, binding), { outcome: 'appended', record_id: 'bound' })
  assert.deepEqual(ledger.chain('unbound'), [original, {
    ...original, ...audit, envelope: d.envelope, coverage: { ...original.coverage, state: 'partial' },
    record_id: 'bound', revises: 'unbound', dedupe_key: 'bind:1',
  }])
  assert.equal(unmatched(ledger).records, 0, 'the historical unbound record must leave unmatched')
  assert.throws(() => bind(ledger, { ...binding, record_id: 'bound', new_record_id: 'rebound', dedupe_key: 'bind:2' }),
    { code: 'not_bindable' }, 'an attributed head cannot be bound again')
  assert.deepEqual(bind(ledger, binding), { outcome: 'duplicate', record_id: 'bound' })
  for (const level of ['party', 'repo'] as const) {
    const [row] = rollupLevel(ledger, level)
    assert.equal(row!.inclusive.records, 1)
    assert.equal(row!.inclusive.tokens.output.known, 37)
  }
  ingest(ledger, record('unbound-unknown', null, null))
  assert.deepEqual(unmatched(ledger).tokens.output, { known: 0, known_records: 0, unknown_records: 1 },
    'unmatched totals must retain unknown-only output')
})

test('validation and ingest refuse extra payload fields and free-text evidence references', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  const sample = record('sample', d.envelope)
  const priced = {
    ...sample, basis: 'priced_estimate', amount: { value: '0.2', unit: 'USD' },
    coverage: { ...sample.coverage, field_quality: { ...sample.coverage.field_quality, amount: 'priced_estimate' } },
  } as const
  const cases = {
    'top-level field': { ...sample, prompt: 'sample text' },
    'envelope field': { ...sample, envelope: { ...d.envelope, transcript: 'sample text' } },
    'tokens field': { ...sample, tokens: { ...sample.tokens, prompt: 'sample text' } },
    'coverage field': { ...sample, coverage: { ...sample.coverage, transcript: 'sample text' } },
    'amount field': { ...priced, amount: { ...priced.amount, api_key: 'placeholder' } },
    'evidence with spaces': { ...sample, evidence_ref: 'sample evidence' },
    'evidence with a newline': { ...sample, evidence_ref: 'evidence\ntext' },
  }
  for (const [name, input] of Object.entries(cases)) {
    assert.throws(() => validateRecord(input), { code: 'invalid' }, `validateRecord must refuse ${name}`)
    assert.throws(() => ingest(ledger, input), { code: 'invalid' }, `ingest must refuse ${name}`)
    assert.equal(ledger.record(sample.record_id), null, `ingest must not store ${name}`)
  }
})

test('bench mapping keeps usage and timeout codes without pricing unknowns or charging aggregates, replays or unbound runs', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  ledger.createDispatch(d)
  const run: BenchRun = {
    schema: 'bench-run@1', runId: 'leaf', level: 'sprite', parentId: null, taskId: 'work', repo: null,
    model: { provider: 'sample', name: 'small' }, byModel: null, thinking: 'low', startedAt: time,
    endedAt: '2026-01-01T00:00:04.000Z', wallSeconds: 4, activeSeconds: 3.5, turns: 1, toolCalls: 2,
    tokens: { in: 81, out: 12, reasoning: 3, cached: 29 }, costMicros: 4201,
    outcome: { state: 'failed', reason: 'exit 124' }, changes: null, reviewRounds: null,
    check: { result: null, command: null }, coverage: { tokens: 'complete' },
    complexity: { rating: null, proxies: { files: null, lines: null, reviewRounds: null, failedChecks: null, retries: null } },
    sprites: null,
  }
  const options = { envelope: d.envelope, received: time }
  const mapped = fromBenchRun(run, options)
  assert.ok(!('skipped' in mapped), 'exit 124 must map to a valid sprite record')
  assert.equal(mapped.exit_reason, 'exit_124')
  assert.deepEqual(mapped.tokens, { input_uncached: 81, input_total: null, output: 12,
    cache_read: 29, cache_write: null, reasoning: 3 })
  assert.deepEqual(mapped.amount, { value: '0.004201', unit: 'USD' })
  assert.equal(mapped.basis, 'priced_estimate')
  assert.equal(ingest(ledger, mapped).outcome, 'appended')
  assert.equal(ingest(ledger, fromBenchRun(run, options)).outcome, 'duplicate')

  const { turns, toolCalls, tokens, costMicros } = run
  for (const level of ['mob', 'task'] as const) {
    assert.deepEqual(fromBenchRun({ ...run, runId: level, level, model: null,
      byModel: [{ ...run.model!, turns, toolCalls, tokens, costMicros }],
      sprites: { count: 1, wallSeconds: 4, activeSeconds: 3.5 },
    }, options), { skipped: 'aggregate' })
  }
  const unpriced = fromBenchRun({ ...run, runId: 'unpriced', costMicros: null }, { ...options, envelope: null })
  assert.ok(!('skipped' in unpriced))
  assert.equal(unpriced.amount, null, 'missing cost must not turn into a zero estimate')
  assert.equal(unpriced.basis, 'unknown')
  assert.equal(unpriced.envelope, null)
  assert.equal(unpriced.coverage.state, 'unattributed')
  ingest(ledger, unpriced)
  assert.equal(unmatched(ledger).records, 1)
  assert.equal(rollupLevel(ledger, 'party')[0]!.inclusive.records, 1)
})
