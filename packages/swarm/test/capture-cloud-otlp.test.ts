import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Book, createReceiver, jsonlLedger, type Envelope, type SpendRecord } from '../src/capture-cloud/index.ts'

const envelope: Envelope = { party: 'default', repo: 'plb', work_id: 'plb-111', attempt: 'att-1', tier: 'mob',
  parent: 'exec-1', session: 'sess-2', trace: { id: 'tr-1', execution_id: 'exec-2' } }
const session = 'canary-session', api = 'claude_code.api_request', email = 'private@example.test'
const attributes = (fields: Record<string, string | number | object>) => Object.entries(fields).map(([key, value]) =>
  ({ key, value: typeof value === 'string' ? { stringValue: value } : typeof value === 'number' ? { intValue: value } : value }))
const log = (id: string, overrides = {}, event = api, body = event) => ({ timeUnixNano: '1795348802345999999',
  body: { stringValue: body }, attributes: attributes({ 'event.name': event, request_id: id, model: 'claude-sonnet-4-6', ...overrides }) })
const payload = (logs = [log('r1')], sessionId = session) => ({ envelope: { ...envelope, work_id: 'payload-work' }, resourceLogs: [{
  resource: { attributes: attributes({ 'ccr.session.id': sessionId, 'user.email': email, model: 'not-claude' }) },
  scopeLogs: [{ scope: { name: 'com.anthropic.claude_code' }, logRecords: logs }],
}] })
const canary = payload([
  log('prompt-r1', {}, 'claude_code.user_prompt', 'private-prompt'),
  log('tool-r1', {}, 'claude_code.tool_result', 'private-tool'),
  log('r1', { input_tokens: { intValue: '10' }, output_tokens: { intValue: '3' }, cache_read_tokens: { intValue: '2' },
    cache_creation_tokens: { intValue: '0' }, duration_ms: { doubleValue: 345 }, extra: 'private-extra' }),
  log('r2', { input_tokens: { intValue: '7' }, output_tokens: { intValue: '4' }, 'ccr.session.id': session }, '', api),
])
const ok = { status: 200, body: '{}', retry: null }

function fixture(t: TestContext, tick = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-otlp-')), file = join(dir, 'spend.jsonl'), bookFile = join(dir, 'book.json')
  const initial = Date.parse('2026-11-22T12:01:00Z')
  let time = initial, server: Awaited<ReturnType<ReturnType<typeof createReceiver>['listen']>> | undefined
  const now = () => (time += tick), book = new Book({ file: bookFile, now })
  const bind = (id: string, ttlMs = 3_600_000, execution_id = envelope.trace.execution_id) => {
    const { capability } = book.issue({ ...envelope, trace: { ...envelope.trace, execution_id } }, { ttlMs })
    book.bind(capability, id)
    return capability
  }
  bind(session)
  t.after(async () => { await server?.close(); rmSync(dir, { recursive: true, force: true }) })
  const raw = () => existsSync(file) ? readFileSync(file, 'utf8') : ''
  return { initial, bind, book, file, raw, advance: (ms: number) => { time += ms },
    rows: (): SpendRecord[] => raw().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async listen() {
      await server?.close()
      server = await createReceiver({ book: new Book({ file: bookFile, now }), ledger: jsonlLedger(file), now }).listen(0)
      const url = `http://127.0.0.1:${server.port}/v1/logs`
      return async (data: unknown, init: RequestInit & { duplex?: 'half' } = {}) => {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data), signal: AbortSignal.timeout(5_000), ...init })
        return { status: res.status, body: await res.text(), retry: res.headers.get('retry-after') }
      }
    } }
}

// Catches keeping non-API logs or sensitive attributes, bad projection, and trusting payload attribution.
test('OTLP canary books only API usage without authorization', async (t) => {
  const f = fixture(t), post = await f.listen()
  assert.deepEqual(await post(canary), ok)
  assert.equal(f.rows().length, 2, 'only API requests belong in the ledger')
  for (const row of f.rows()) {
    assert.deepEqual(row.envelope, envelope, 'envelope must come from the Book')
    assert.equal(row.received, new Date(f.initial).toISOString())
    assert.equal(row.coverage.state, 'pending')
    assert.equal(row.actual_model, 'claude-sonnet-4-6')
    assert.deepEqual([row.occurred, row.ended, row.status], ['2026-11-22T12:00:02.345Z', '2026-11-22T12:00:02.345Z', 'completed'])
  }
  assert.deepEqual(f.rows().map(r => r.started), ['2026-11-22T12:00:02.000Z', null])
  assert.deepEqual(f.rows().map(r => r.tokens), [
    { input_total: null, input_uncached: 10, output: 3, cache_read: 2, cache_write: 0, reasoning: null },
    { input_total: null, input_uncached: 7, output: 4, cache_read: null, cache_write: null, reasoning: null },
  ])
  for (const secret of ['private-prompt', 'private-tool', email, 'private-extra']) assert.ok(!f.raw().includes(secret), `ledger leaked ${secret}`)
})

// Catches double booking a retry before or after restarting the receiver.
test('OTLP replay is idempotent across restart', async (t) => {
  const f = fixture(t), post = await f.listen()
  assert.deepEqual(await post(canary), ok)
  const first = f.raw()
  assert.equal(f.rows().length, 2)
  for (const retry of [post, async (data: unknown) => (await f.listen())(data)]) {
    assert.deepEqual(await retry(canary), ok)
    assert.equal(f.rows().length, 2, 'retry must not book more records')
    assert.equal(f.raw(), first)
  }
})

// Catches treating an unbound, expired, or revoked session as usable or revealing which one it is.
test('OTLP unusable sessions give the same 404; other events are ignored', async (t) => {
  const f = fixture(t), post = await f.listen()
  f.bind('expired-session', 1)
  f.book.revoke(f.bind('revoked-session'))
  f.advance(1)
  for (const id of ['unbound-session', 'expired-session', 'revoked-session']) {
    assert.deepEqual(await post(payload(undefined, id)), { ...ok, status: 404, body: '{"error":"unknown_envelope"}' }, id)
  }
  assert.deepEqual(await post(payload([log('tool', {}, 'claude_code.tool_result')], 'unbound-session')), ok)
  assert.deepEqual(f.rows(), [])
})

// Catches invalid claims or transport being accepted, and fractional tokens becoming reported zeros.
test('OTLP validates input and keeps missing token counts null', async (t) => {
  const f = fixture(t), post = await f.listen()
  const invalid = [log('', { request_id: {} }), log('bad-model', { model: 'other' }), log('negative', { output_tokens: -1 })]
  for (const row of invalid) assert.equal((await post(payload([row]))).status, 400)
  assert.equal((await post([])).status, 400)
  assert.equal((await post(null, { body: '{' })).status, 400)
  assert.equal((await post(payload(), { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  const body = JSON.stringify(payload()).padEnd(256 * 1024 + 1)
  assert.equal((await post(null, { body })).status, 413, 'OTLP Content-Length over 256 KiB')
  assert.equal((await post(null, { body: new Blob([body]).stream(), duplex: 'half' })).status, 413, 'OTLP streamed body over 256 KiB')
  assert.equal((await post(payload([log('cap', { output_tokens: 100_000_001 })]))).status, 422)
  assert.deepEqual(await post(payload([...invalid, log('fraction', { output_tokens: { doubleValue: 1.5 } })])), ok)
  assert.equal(f.rows().length, 1)
  assert.equal(f.rows()[0]?.tokens.output, null, 'fractional token count must be null')
})

// Catches booking past the session burst, ignoring an envelope cap, or continuing after a stop.
test('OTLP stops sequential booking at rate and record caps', async (t) => {
  const f = fixture(t), post = await f.listen()
  const batch = (offset: number, n = 20) => Array.from({ length: n }, (_, i) => log(`r${offset + i}`))
  f.bind('other-session', 3_600_000, 'exec-other')
  const other = log('other', { 'ccr.session.id': 'other-session' })
  const limited = await post(payload([...batch(0, 21), other]))
  assert.equal(limited.status, 429)
  assert.match(limited.retry ?? '', /^[1-9]\d*$/)
  assert.equal(f.rows().length, 20)
  for (let i = 20; i < 5_000; i += 20) { f.advance(4_000); assert.deepEqual(await post(payload(batch(i))), ok) }
  f.advance(4_000)
  assert.deepEqual(await post(payload([...batch(5_000, 1), other])), { ...ok, status: 422, body: '{"error":"record_cap"}' })
  assert.equal(f.rows().length, 5_000)
})

// Catches processing a 501st API request or counting ignored events toward the bound.
test('OTLP processes at most 500 API requests per batch', async (t) => {
  const f = fixture(t, 200), post = await f.listen()
  const logs = [log('ignored', {}, 'claude_code.tool_result'), ...Array.from({ length: 501 }, (_, i) => log(`r${i}`))]
  assert.deepEqual(await post(payload(logs)), ok)
  assert.equal(f.rows().length, 500, 'API request at position 501 must not be booked')
})

// Catches acknowledging failed appends instead of asking the exporter to retry.
test('OTLP ledger write failure is retryable', async (t) => {
  const f = fixture(t), post = await f.listen()
  mkdirSync(f.file)
  assert.deepEqual(await post(payload()), { ...ok, status: 503, body: '{"error":"unavailable"}' })
  rmSync(f.file, { recursive: true })
  assert.deepEqual(await post(payload()), ok)
  assert.equal(f.rows().length, 1)
})
