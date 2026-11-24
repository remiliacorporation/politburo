import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { collectSprite, SpriteNotFinished } from '../src/capture/collect.ts'
import type { BenchRecord } from '../src/capture/collect.ts'
import { jsonlLedger } from '../src/capture/ledger.ts'
import { spendRecords } from '../src/capture/spend.ts'
import type { SpendContext } from '../src/capture/spend.ts'

const name = 'sprite-91'
const ctx = {
  envelope: {
    party: 'default', repo: 'plb', work_id: 'plb-482', attempt: 'att-42', tier: 'sprite',
    parent: 'exec-70', session: 'sess-91', trace: { id: 'tr-42', execution_id: 'exec-91' },
  },
  requested_route: 'fallback/codex-cursor',
  now: () => '2025-01-01T00:01:00.000Z',
  source_version: 'fixture-1',
} satisfies SpendContext

const usage = { input: 12, output: 4, cacheRead: 7, reasoning: 2 }
const unknownTokens = {
  input_uncached: null, input_total: null, output: null, cache_read: null, cache_write: null, reasoning: null,
}
const unknownCoverage = {
  state: 'partial',
  field_quality: { amount: 'unknown', ...Object.fromEntries(Object.keys(unknownTokens).map(k => [`tokens.${k}`, 'unknown'])) },
}

function turn(provider: string, model: string, counts?: Partial<typeof usage>, responseId = model) {
  return {
    type: 'message_end', message: {
      role: 'assistant', provider, model, responseId, timestamp: 1735689602000, stopReason: 'stop', usage: counts,
    },
  }
}

async function fixture(t: TestContext, events: object[], rc: number | null = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-capture-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const session = { type: 'session', id: 's1', timestamp: '2025-01-01T00:00:00.000Z' }
  await writeFile(join(dir, `${name}.jsonl`), [session, ...events].map(e => JSON.stringify(e)).join('\n') + '\n')
  if (rc !== null) await writeFile(join(dir, `${name}.rc`), `${rc}\n`)
  return dir
}

const benchRow: BenchRecord = {
  schema: 'bench-run@1', runId: name, model: { provider: 'openai', name: 'codex' },
  startedAt: '2025-01-01T00:00:00.000Z', endedAt: '2025-01-01T00:00:10.000Z', turns: 1,
  tokens: { in: 12, out: 4, cached: 7, reasoning: 2 }, coverage: { tokens: 'complete' },
  outcome: { state: 'done', reason: null }, rc: 0,
}

async function fakeCollector(dir: string, action: string) {
  const collectorPath = join(dir, 'collector.mjs')
  await writeFile(collectorPath, `
    import { rmSync, writeFileSync } from 'node:fs'
    const rcPath = ${JSON.stringify(join(dir, `${name}.rc`))}
    ${action}
    console.log(${JSON.stringify(JSON.stringify(benchRow))})
  `)
  return { dir, collectorPath }
}

test('two models in one sprite log are not summed or collapsed into one record', async t => {
  const dir = await fixture(t, [
    turn('openai', 'codex', { ...usage, reasoning: 0 }),
    turn('cursor', 'fallback', { ...usage, input: 3 }, 'response-2'),
    turn('cursor', 'fallback', { input: 2, output: 1, cacheRead: 1 }, 'response-3'),
  ])
  const rows = await collectSprite(name, { dir })
  assert.deepEqual(rows.map(row => row.rc), [0, 0])
  const records = spendRecords(rows, ctx)
  assert.deepEqual(records.map(r => [r.provider, r.actual_model, r.tokens.input_uncached, r.dedupe_key]), [
    ['openai', 'codex', 12, 'pi:exec-91:["openai","codex"]'],
    ['cursor', 'fallback', 5, 'pi:exec-91:["cursor","fallback"]'],
  ])
  for (const r of records) {
    assert.equal(r.evidence_ref, `sprite-log:${name}`)
    assert.equal(r.requested_route, ctx.requested_route)
    assert.deepEqual([r.amount, r.basis, r.envelope], [null, 'unknown', ctx.envelope])
  }
  assert.deepEqual(records[0]?.tokens, { ...unknownTokens, input_uncached: 12, output: 4, cache_read: 7, reasoning: 0 })
  assert.equal(records[0]?.coverage.field_quality['tokens.reasoning'], 'provider_reported')
  assert.equal(records[0]?.coverage.state, 'closed_reconciled')
})

test('slashes and missing provider/model names do not collide in capture keys', () => {
  const models = [{ provider: 'a/b', name: 'c' }, { provider: 'a', name: 'b/c' }, null, { provider: 'none', name: 'none' }]
  const keys = ['["a/b","c"]', '["a","b/c"]', '[null,null]', '["none","none"]']
  const records = spendRecords(models.map(model => ({ ...benchRow, model })), ctx)
  assert.deepEqual(records.map(r => r.dedupe_key), keys.map(key => `pi:exec-91:${key}`))
  assert.deepEqual(records.map(r => r.source_event_key), keys.map(key => `exec-91:${key}`))
})

test('partial sums survive without claiming full provider coverage on disk', async t => {
  const dir = await fixture(t, [
    turn('openai', 'codex', usage, 'response-1'),
    turn('openai', 'codex', { output: 1, cacheRead: 0 }, 'response-2'),
  ])
  const [record] = spendRecords(await collectSprite(name, { dir }), ctx)
  assert.ok(record)
  const tokens = { ...unknownTokens, input_uncached: 12, output: 5, cache_read: 7, reasoning: 2 }
  const coverage = {
    state: 'partial', field_quality: {
      ...unknownCoverage.field_quality, 'tokens.input_uncached': 'provider_reported_partial',
      'tokens.output': 'provider_reported_partial', 'tokens.cache_read': 'provider_reported_partial',
      'tokens.reasoning': 'provider_reported_partial',
    },
  }
  assert.deepEqual(record.tokens, tokens)
  assert.deepEqual(record.coverage, coverage)
  await jsonlLedger(dir).append(record)
  const written = JSON.parse(await readFile(join(dir, 'spend.jsonl'), 'utf8'))
  assert.deepEqual([written.tokens, written.coverage], [tokens, coverage])
})

test('a usage-less assistant turn leaves token buckets unknown, not zero', async t => {
  for (const counts of [undefined, {}]) {
    const dir = await fixture(t, [turn('openai', 'codex', counts)])
    const [record] = spendRecords(await collectSprite(name, { dir }), ctx)
    assert.deepEqual([record?.status, record?.tokens, record?.coverage], ['completed', unknownTokens, unknownCoverage])
  }
})

test('a zero-usage Cursor answer is not reported as zero or mixed with OpenAI usage', async t => {
  const dir = await fixture(t, [
    turn('cursor', 'fallback', { input: 0, output: 0, reasoning: 0, cacheRead: 0 }),
    turn('openai', 'codex', usage),
  ])
  const [cursor, openai] = spendRecords(await collectSprite(name, { dir }), ctx)
  assert.deepEqual([cursor?.tokens, cursor?.coverage], [unknownTokens, unknownCoverage])
  assert.deepEqual(openai?.tokens, { ...unknownTokens, input_uncached: 12, output: 4, cache_read: 7, reasoning: 2 })
  assert.equal(openai?.coverage.state, 'closed_reconciled')
})

test('zero/null placeholders stay unknown without erasing reported cache or reasoning', async t => {
  for (const [description, tokens, bucket, count] of [
    ['cache-only usage survives zero in/out', { in: 0, out: 0, cached: 7, reasoning: 0 }, 'cache_read', 7],
    ['reasoning-only usage survives zero in/out', { in: 0, out: 0, cached: 0, reasoning: 2 }, 'reasoning', 2],
    ['mixed zero and null placeholders stay unknown', { in: null, out: 0, cached: 0, reasoning: null }, null, null],
  ] as const) {
    await t.test(description, () => {
      const [record] = spendRecords([{ ...benchRow, tokens }], ctx)
      if (bucket === null) assert.deepEqual([record?.tokens, record?.coverage], [unknownTokens, unknownCoverage])
      else {
        assert.equal(record?.tokens[bucket], count)
        assert.equal(record?.coverage.field_quality[`tokens.${bucket}`], 'provider_reported')
      }
    })
  }
})

test('a missing .rc reports unfinished without running the collector', async t => {
  const dir = await fixture(t, [], null)
  const opts = await fakeCollector(dir, 'writeFileSync(rcPath, "0\\n")')
  await assert.rejects(collectSprite(name, opts), SpriteNotFinished)
  await assert.rejects(readFile(join(dir, `${name}.rc`)), { code: 'ENOENT' })
})

test('collection rejects a changed or removed .rc and does not confuse collector failure with unfinished', async t => {
  for (const [description, action, error] of [
    ['rewritten .rc rejects an inconsistent snapshot', 'writeFileSync(rcPath, "137\\n")',
      { name: 'Error', message: 'sprite exit code changed during collection' }],
    ['removed .rc reports unfinished', 'rmSync(rcPath)', SpriteNotFinished],
    ['collector exit 3 with .rc present is a collector failure', 'process.exit(3)',
      { name: 'Error', message: 'sprite collector failed' }],
  ] as const) {
    await t.test(description, async t => {
      const opts = await fakeCollector(await fixture(t, []), action)
      await assert.rejects(collectSprite(name, opts), error)
    })
  }
})

for (const [rc, status] of [[124, 'failed'], [137, 'canceled']] as const) {
  test(`exit ${rc} is not lost or misclassified on either model's record`, async t => {
    const dir = await fixture(t, [turn('openai', 'codex', usage), turn('cursor', 'fallback', usage)], rc)
    const rows = await collectSprite(name, { dir })
    assert.deepEqual(rows.map(row => row.rc), [rc, rc])
    assert.deepEqual(spendRecords(rows, ctx).map(r => [r.status, r.exit_reason]), [[status, `exit ${rc}`], [status, `exit ${rc}`]])
  })
}

test('a restart with a different execution ID gets a separate dedupe key', () => {
  const retry = { ...ctx, envelope: { ...ctx.envelope, trace: { ...ctx.envelope.trace, execution_id: 'exec-92' } } }
  assert.deepEqual([ctx, retry].flatMap(c => spendRecords([benchRow], c).map(r => r.dedupe_key)), [
    'pi:exec-91:["openai","codex"]', 'pi:exec-92:["openai","codex"]',
  ])
})

test('spend records never copy prompt text, assistant output, or credentials from sprite logs', async t => {
  const prompt = 'private fixture prompt'
  const reply = 'private fixture reply'
  const apiKey = 'synthetic fixture key'
  const user = { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: 1735689602000 } }
  const assistant = turn('openai', 'codex', usage)
  const answered = await fixture(t, [user, { ...assistant, message: { ...assistant.message, content: [{ type: 'text', text: reply }], apiKey } }])
  const canceled = await fixture(t, [user], 143)
  const [answer] = spendRecords(await collectSprite(name, { dir: answered }), ctx)
  const [noAnswer] = spendRecords(await collectSprite(name, { dir: canceled }), ctx)
  assert.equal(answer?.actual_model, 'codex')
  assert.deepEqual([noAnswer?.actual_model, noAnswer?.tokens, noAnswer?.status, noAnswer?.exit_reason,
    noAnswer?.evidence_ref], [null, unknownTokens, 'canceled', 'exit 143', `sprite-log:${name}`])
  for (const text of [prompt, reply, apiKey]) assert.ok(!JSON.stringify([answer, noAnswer]).includes(text), `${text} leaked`)
})
