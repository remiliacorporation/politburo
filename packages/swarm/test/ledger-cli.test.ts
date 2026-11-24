import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { BenchRun } from '@remilia/politburo-runtime'
import type { Dispatch, Envelope, SpendRecord } from '../src/ledger/index.ts'

function run(args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'ledger', ...args], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
  })
  if (result.error) throw result.error
  return result
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const time = '2026-01-01T00:00:00.000Z'

function dispatch(id: string, tier: Envelope['tier'], parent: string | null, sponsor: string | null): Dispatch {
  return {
    envelope: {
      party: 'demo', repo: 'acme/web', work_id: tier === 'spawner' ? null : 'web-1',
      attempt: tier === 'spawner' ? null : 'attempt-1', tier, parent, session: `session-${id}`,
      trace: { id: 'trace-1', execution_id: id },
    },
    sponsor, created: time,
  }
}

function spend(envelope: Envelope, id: string, output: number | null): SpendRecord {
  return {
    record_id: id, dedupe_key: `test:${id}`, revises: null, envelope,
    source: 'test', source_version: '1', source_event_key: id, evidence_ref: `usage/${id}`,
    provider: 'example', requested_route: null, actual_model: 'small', auth_class: null,
    tokens: { input_uncached: 8, input_total: 8, output, cache_read: 0, cache_write: 0, reasoning: 0 },
    amount: output === null ? null : { value: '0.0042', unit: 'USD' },
    basis: output === null ? 'unknown' : 'priced_estimate',
    occurred: time, received: time, started: null, ended: null, status: 'completed',
    coverage: {
      state: output === null ? 'partial' : 'closed_reconciled',
      field_quality: {
        'tokens.input_uncached': 'provider_reported', 'tokens.input_total': 'provider_reported',
        'tokens.output': output === null ? 'unknown' : 'provider_reported',
        'tokens.cache_read': 'provider_reported', 'tokens.cache_write': 'provider_reported',
        'tokens.reasoning': 'provider_reported', amount: output === null ? 'unknown' : 'priced_estimate',
      },
    },
  }
}

function success(result: ReturnType<typeof run>): string {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return result.stdout
}

test('party text and sprite json do not lose known output or turn missing records into zeros', (t) => {
  const dir = tempDir(t)
  const db = join(dir, 'ledger.sqlite')
  const spawner = dispatch('spawner-1', 'spawner', null, null)
  const mob = dispatch('mob-1', 'mob', 'spawner-1', 'spawner-1')
  const metered = dispatch('sprite-metered', 'sprite', 'mob-1', 'spawner-1')
  const missing = dispatch('sprite-missing', 'sprite', 'mob-1', 'spawner-1')
  for (const entry of [spawner, mob, metered, missing]) {
    const input = join(dir, `${entry.envelope.trace.execution_id}.json`)
    writeFileSync(input, JSON.stringify(entry))
    assert.equal(success(run(['dispatch', '--db', db, input])), `created  ${entry.envelope.trace.execution_id}\n`)
  }
  assert.equal(success(run(['dispatch', '--db', db], missing)), 'existing  sprite-missing\n')
  for (const [id, owner, output] of [
    ['spawner-usage', spawner, 3], ['mob-usage', mob, 5],
    ['sprite-usage', metered, 120], ['sprite-partial', metered, null],
  ] as const) {
    assert.equal(success(run(['append', '--db', db, '-'], spend(owner.envelope, id, output))), `appended  ${id}\n`)
  }

  const party = success(run(['rollup', '--db', db, '--level', 'party']))
  assert.equal(party, [
    'party  demo',
    '  own',
    '    records  0',
    '    executions  0  (0 without records)',
    '    input_uncached  0 known  0 unknown',
    '    input_total  0 known  0 unknown',
    '    output  0 known  0 unknown',
    '    cache_read  0 known  0 unknown',
    '    cache_write  0 known  0 unknown',
    '    reasoning  0 known  0 unknown',
    '    amount unknown  0',
    '  inclusive',
    '    records  4',
    '    executions  4  (1 without records)',
    '    input_uncached  32 known  1 unknown',
    '    input_total  32 known  1 unknown',
    '    output  128 known  2 unknown',
    '    cache_read  0 known  1 unknown',
    '    cache_write  0 known  1 unknown',
    '    reasoning  0 known  1 unknown',
    '    priced_estimate  USD  0.0126  (3 records)',
    '    amount unknown  2',
    '',
  ].join('\n'))

  const sprites = success(run(['rollup', '--db', db, '--level', 'sprite', '--json']))
  const { rows: [reported, absent, ...rest] } = JSON.parse(sprites)
  assert.deepEqual(rest, [])
  assert.equal(reported.level, 'sprite')
  assert.deepEqual(reported.key, { execution_id: 'sprite-metered' })
  assert.deepEqual(reported.inclusive.tokens.output, { known: 120, known_records: 1, unknown_records: 1 })
  assert.deepEqual(absent.key, { execution_id: 'sprite-missing' })
  assert.deepEqual(absent.inclusive.executions, { total: 1, without_records: 1 })
  assert.deepEqual(absent.inclusive.tokens.output, { known: 0, known_records: 0, unknown_records: 1 })
})

test('append replays do not report new writes, accept changed facts, or change totals', (t) => {
  const db = join(tempDir(t), 'ledger.sqlite')
  const entry = dispatch('sprite-1', 'sprite', null, null)
  success(run(['dispatch', '--db', db], entry))
  const args = ['append', '--db', db]
  const record = spend(entry.envelope, 'once', 120)
  assert.equal(success(run(args, record)), 'appended  once\n')
  const rollup = ['rollup', '--db', db, '--level', 'sprite', '--json']
  const original = success(run(rollup))
  assert.deepEqual(JSON.parse(original).rows[0].own.tokens.output, { known: 120, known_records: 1, unknown_records: 0 })
  assert.equal(success(run(args, record)), 'duplicate  once\n')
  assert.equal(success(run(rollup)), original)
  const mismatch = run(args, { ...record, tokens: { ...record.tokens, output: 121 } })
  assert.equal(mismatch.status, 1)
  assert.equal(mismatch.stdout, 'mismatch  once\n')
  assert.equal(mismatch.stderr, '')
  assert.equal(success(run(rollup)), original)
})

test('rollup does not create a missing ledger or succeed without one', (t) => {
  const dir = tempDir(t)
  const db = join(dir, 'missing.sqlite')
  const result = run(['rollup', '--db', db, '--level', 'party'])
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `error: no ledger at ${db}\n`)
})

test('ledger misuse does not exit with the wrong status or omit usage on stderr', (t) => {
  const dir = tempDir(t)
  const db = join(dir, 'ledger.sqlite')
  for (const args of [
    ['dispatch'], ['unknown'], ['append', '--db', db, '--bad'], ['rollup', '--db', db],
    ['rollup', '--db', db, '--level', 'party', '--by', 'repo'],
    ['rollup', '--db', db, '--level', 'wrong'], ['rollup', '--db', db, '--by', 'party,wrong'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^error: [^\n]+\nusage: swarm ledger [^\n]+\n$/)
  }
  assert.deepEqual(readdirSync(dir), [])
})

test('invalid records and malformed json are not accepted or echoed', (t) => {
  const dir = tempDir(t)
  const db = join(dir, 'ledger.sqlite')
  const entry = dispatch('sprite-1', 'sprite', null, null)
  success(run(['dispatch', '--db', db], entry))
  const text = 'private fixture text must not be printed'
  const file = join(dir, 'bad.json')
  writeFileSync(file, text)
  for (const result of [
    run(['append', '--db', db], { ...spend(entry.envelope, 'bad', 2), prompt: text }),
    run(['append', '--db', db, file]),
  ]) {
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, new RegExp(text))
    assert.match(result.stderr, /^error: [^\n]+\n$/)
  }
  const result = success(run(['rollup', '--db', db, '--level', 'sprite', '--json']))
  assert.equal(JSON.parse(result).rows[0].own.records, 0)
})

const benchRun = (runId: string, options: Partial<BenchRun> = {}): BenchRun => ({
  schema: 'bench-run@1', runId, level: 'sprite', parentId: null, taskId: 'fixture', repo: null,
  model: { provider: 'a', name: 'small' }, byModel: null, thinking: 'low', startedAt: time,
  endedAt: '2026-01-01T00:00:04.000Z', wallSeconds: 4, activeSeconds: 3.5, turns: 1, toolCalls: 2,
  tokens: { in: 8, out: 2, reasoning: null, cached: null }, costMicros: null,
  outcome: { state: 'done', reason: null }, changes: { files: 1, linesAdded: 1, linesRemoved: 1 }, reviewRounds: null,
  check: { result: 'pass', command: 'pnpm check' }, coverage: { tokens: 'partial' },
  complexity: { rating: { score: 2, size: 'S', reason: 'small scope', ratedBy: 'rater', ratedAt: time },
    proxies: { files: 1, lines: 2, reviewRounds: null, failedChecks: null, retries: null } },
  sprites: null,
  ...options,
})

test('bench append does not reject sprite runs, misattribute unbound runs, or count aggregates', (t) => {
  const db = join(tempDir(t), 'ledger.sqlite')
  const entry = dispatch('sprite-1', 'sprite', null, null)
  success(run(['dispatch', '--db', db], entry))
  const append = ['append', '--db', db]
  const bound = [...append, '--execution', 'sprite-1']
  assert.equal(success(run(bound, benchRun('leaf'))), 'appended  bench:leaf\n')
  assert.equal(success(run(bound, benchRun('leaf'))), 'duplicate  bench:leaf\n')
  assert.equal(success(run(append, benchRun('unbound'))), 'appended  bench:unbound\n')
  const { turns, toolCalls, tokens, costMicros } = benchRun('leaf')
  const aggregate = benchRun('mob-1', {
    level: 'mob', model: null, byModel: [{ provider: 'a', name: 'small', turns, toolCalls, tokens, costMicros }],
    sprites: { count: 1, wallSeconds: 4, activeSeconds: 3.5 },
  })
  assert.equal(success(run(append, aggregate)), 'skipped  aggregate\n')
  const invalid = run(append, { schema: 'bench-run@1' })
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout, 'skipped  invalid\n')
  assert.equal(invalid.stderr, '')
  const attributed = success(run(['rollup', '--db', db, '--level', 'sprite', '--json']))
  assert.deepEqual(JSON.parse(attributed).rows[0].own.tokens.output, { known: 2, known_records: 1, unknown_records: 0 })
  const quarantined = success(run(['rollup', '--db', db, '--unmatched', '--json']))
  const { rows: [unmatched] } = JSON.parse(quarantined)
  assert.equal(unmatched.coverage.unattributed, 1)
  assert.deepEqual(unmatched.tokens.output, { known: 2, known_records: 1, unknown_records: 0 })
})

test('rollup by does not group out-of-scope dispatches or omit the composite key', (t) => {
  const db = join(tempDir(t), 'ledger.sqlite')
  success(run(['dispatch', '--db', db], dispatch('sprite-1', 'sprite', null, null)))
  success(run(['dispatch', '--db', db], dispatch('spawner-1', 'spawner', null, null)))
  const args = ['rollup', '--db', db, '--by', 'party,execution_id', '--json']
  const output = success(run([...args, '--party', 'demo', '--repo', 'acme/web', '--work-id', 'web-1']))
  const { rows } = JSON.parse(output)
  assert.deepEqual(rows.map((row: { key: unknown }) => row.key), [{ party: 'demo', execution_id: 'sprite-1' }])
  const excluded = success(run([...args, '--execution', 'absent']))
  assert.deepEqual(JSON.parse(excluded), { rows: [] })
})

test('an active writer blocks dispatch without making rollup take a writer lock', (t) => {
  const db = join(tempDir(t), 'ledger.sqlite')
  const entry = dispatch('sprite-1', 'sprite', null, null)
  success(run(['dispatch', '--db', db], entry))
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const writer = new DatabaseSync(db)
  try {
    writer.exec('BEGIN IMMEDIATE')
    const locked = run(['dispatch', '--db', db], entry)
    assert.equal(locked.status, 1)
    assert.equal(locked.stdout, '')
    assert.equal(locked.stderr, 'error: ledger is locked by another process\n')
    const result = success(run(['rollup', '--db', db, '--level', 'sprite', '--json']))
    assert.deepEqual(JSON.parse(result).rows[0].key, { execution_id: 'sprite-1' })
  } finally {
    writer.close()
  }
})
