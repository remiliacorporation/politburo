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
const log = (id: string, overrides = {}, event: string | null = api, body = event) => ({ timeUnixNano: '1795348802345999999',
  body: { stringValue: body }, attributes: attributes({ ...(event === null ? {} : { 'event.name': event }),
    request_id: id, model: 'claude-sonnet-4-6', ...overrides }) })
const payload = (logs = [log('r1')], sessionId = session) => ({ envelope: { ...envelope, work_id: 'payload-work' }, resourceLogs: [{
  resource: { attributes: attributes({ 'ccr.session.id': sessionId, 'user.email': email, model: 'not-claude' }) },
  scopeLogs: [{ scope: { name: 'com.anthropic.claude_code' }, logRecords: logs }],
}] })
const canary = payload([
  log('prompt-r1', {}, 'claude_code.user_prompt', 'private-prompt'),
  log('tool-r1', {}, 'claude_code.tool_result', 'private-tool'),
  log('r1', { input_tokens: { intValue: '10' }, output_tokens: { intValue: '3' }, cache_read_tokens: { intValue: '2' },
    cache_creation_tokens: { intValue: '0' }, duration_ms: { doubleValue: 345 }, extra: 'private-extra' }),
  log('r2', { input_tokens: { intValue: '7' }, output_tokens: { intValue: '4' }, 'ccr.session.id': session }, null, api),
])
const ok = { status: 200, body: '{}', retry: null }
const partial = (rejectedLogRecords: number) => ({ ...ok,
  body: JSON.stringify({ partialSuccess: { rejectedLogRecords, errorMessage: 'rejected' } }) })
const error = (status: number, message: string) => ({ ...ok, status, body: JSON.stringify({ error: message }) })
const batch = (offset: number, n = 20) => Array.from({ length: n }, (_, i) => log(`r${offset + i}`))

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
    async listen(ledger = jsonlLedger(file)) {
      await server?.close()
      server = await createReceiver({ book: new Book({ file: bookFile, now }), ledger, now }).listen(0)
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
  assert.deepEqual(await post(payload(batch(0, 25), 'unbound-session')), error(404, 'unknown_envelope'))
  const ignored = payload([log('tool', {}, 'claude_code.tool_result')], 'unbound-session')
  for (let i = 0; i < 16; i++) assert.deepEqual(await post(ignored), ok)
  assert.equal((await post(ignored)).status, 429, 'address allowance is charged once per request')
  assert.deepEqual(f.rows(), [])
})

test('OTLP event.name takes precedence over an API body marker', async (t) => {
  const f = fixture(t), post = await f.listen()
  assert.deepEqual(await post(payload([log('prompt', {}, 'claude_code.user_prompt', api)])), ok)
  assert.deepEqual(f.rows(), [])
})

// Catches invalid claims or transport being accepted.
test('OTLP validates claims and transport', async (t) => {
  const f = fixture(t), post = await f.listen()
  const invalid = [log('', { request_id: {} }), log('bad-model', { model: 'other' }), log('negative', { output_tokens: -1 })]
  for (const row of invalid) assert.equal((await post(payload([row]))).status, 400)
  assert.equal((await post([])).status, 400)
  assert.equal((await post(null, { body: '{' })).status, 400)
  assert.equal((await post(payload(), { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  const body = JSON.stringify(payload()).padEnd(256 * 1024 + 1)
  assert.equal((await post(null, { body })).status, 413, 'OTLP Content-Length over 256 KiB')
  assert.equal((await post(null, { body: new Blob([body]).stream(), duplex: 'half' })).status, 413, 'OTLP streamed body over 256 KiB')
  assert.deepEqual(f.rows(), [])
})

test('OTLP rejects present invalid numeric attributes', async (t) => {
  const f = fixture(t), post = await f.listen()
  const invalid = [log('long', { input_tokens: { intValue: '9'.repeat(309) } }),
    log('negative-duration', { duration_ms: -1 }), log('long-duration', { duration_ms: 86_400_001 }),
    log('fraction', { output_tokens: { doubleValue: 1.5 } }), log('over-max', { output_tokens: 100_000_001 }),
    log('exponent', { input_tokens: { intValue: '1e3' } }), log('missing-value', { input_tokens: {} })]
  for (const [i, row] of invalid.entries()) assert.deepEqual(await post(payload([row])), error(400, 'invalid'), `numeric case ${i + 1}`)
  assert.deepEqual(f.rows(), [])
  assert.deepEqual(await post(payload([...invalid, log('valid')])), partial(invalid.length))
  assert.equal(f.rows().length, 1)
  assert.equal(f.rows()[0]?.tokens.input_uncached, null)
})

test('OTLP rejects rounded token counts and inexact or unsafe numeric timestamps', async (t) => {
  const f = fixture(t), post = await f.listen()
  const tokens = JSON.stringify(payload([log('inexact', { input_tokens: 100_000_000 })]))
    .replace('"intValue":100000000', '"intValue":100000000.000000001')
  const withStamp = (id: string, value: string) => JSON.stringify(payload([log(id)]))
    .replace('"1795348802345999999"', value)
  assert.deepEqual([
    await post(null, { body: tokens }),
    await post(null, { body: withStamp('fractional-stamp', '1000000.00000000001') }),
    await post(null, { body: withStamp('unsafe-stamp', '1795348802345999999') }),
  ], Array.from({ length: 3 }, () => error(400, 'invalid')))
  assert.deepEqual(f.rows(), [])
})

test('an AnyValue with both intValue and doubleValue is rejected', async (t) => {
  const f = fixture(t), post = await f.listen()
  const both = log('both', { input_tokens: { intValue: 10, doubleValue: 3 } })
  assert.deepEqual(await post(payload([both])), error(400, 'invalid'))
  assert.deepEqual(f.rows(), [])
  assert.deepEqual(await post(payload([both, log('valid')])), partial(1))
  assert.equal(f.rows().length, 1)
  assert.equal(f.rows()[0]?.tokens.input_uncached, null)
})

test('OTLP duplicate session attributes book to neither envelope', async (t) => {
  const f = fixture(t), post = await f.listen()
  f.bind('other-session', 3_600_000, 'exec-other')
  const row = log('duplicate-session', { 'ccr.session.id': session })
  row.attributes.push(...attributes({ 'ccr.session.id': 'other-session' }))
  assert.deepEqual(await post(payload([row])), error(400, 'invalid'))
  assert.deepEqual(f.rows(), [])
})

test('OTLP throttled batch makes progress on retry without charging replays', async (t) => {
  const f = fixture(t), post = await f.listen(), data = payload(batch(0, 25))
  const limited = await post(data)
  assert.equal(limited.status, 429)
  assert.match(limited.retry ?? '', /^[1-9]\d*$/)
  assert.equal(f.rows().length, 20)
  f.advance(4_000)
  assert.deepEqual(await post(data), ok, 'in-memory duplicates must not exhaust the burst')
  assert.equal(f.rows().length, 25)
  assert.deepEqual(await (await f.listen())(data), ok, 'ledger duplicates must refund the burst after restart')
  assert.equal(f.rows().length, 25)
})

test('a late refund after the bucket refilled does not credit a second burst', async (t) => {
  const f = fixture(t)
  let post = await f.listen()
  assert.deepEqual(await post(payload(batch(0, 20))), ok)
  assert.equal(f.rows().length, 20)
  const inner = jsonlLedger(f.file)
  let releaseHeld = () => {}
  const held = new Promise<void>(resolve => { releaseHeld = resolve })
  let started = 0
  let releaseStarted = () => {}
  const allStarted = new Promise<void>(resolve => { releaseStarted = resolve })
  post = await f.listen({ async append(record) {
    const result = await inner.append(record)
    if (result === 'duplicate') {
      if (++started === 20) releaseStarted()
      await held
    }
    return result
  } })
  const dupes = Array.from({ length: 20 }, (_, i) => post(payload([log(`r${i}`)])))
  await allStarted
  f.advance(4_000)
  assert.deepEqual(await post(payload(batch(20, 20))), ok)
  assert.equal(f.rows().length, 40)
  releaseHeld()
  for (const dupe of await Promise.all(dupes)) assert.deepEqual(dupe, ok)
  const third = await post(payload(batch(40, 20)))
  assert.equal(third.status, 429, 'late duplicate refunds must not credit a refilled bucket')
  assert.equal(f.rows().length, 40)
})

test('a late duplicate refund credits only the unrefilled part of the debit', async (t) => {
  const f = fixture(t)
  let post = await f.listen()
  assert.deepEqual(await post(payload(batch(0, 20))), ok)
  const inner = jsonlLedger(f.file)
  let releaseHeld = () => {}
  const held = new Promise<void>(resolve => { releaseHeld = resolve })
  let started = 0
  let releaseStarted = () => {}
  const startedDupe = new Promise<void>(resolve => { releaseStarted = resolve })
  post = await f.listen({ async append(record) {
    const result = await inner.append(record)
    if (result === 'duplicate') {
      if (++started === 1) releaseStarted()
      await held
    }
    return result
  } })
  const dupe = post(payload([log('r0')]))
  await startedDupe
  assert.deepEqual(await post(payload(batch(20, 19))), ok)
  f.advance(100) // Refill pays half the duplicate's debit before the write returns.
  releaseHeld()
  assert.deepEqual(await dupe, ok)
  assert.deepEqual(await post(payload([log('r39')])), ok)
  f.advance(100)
  assert.equal((await post(payload([log('r40')]))).status, 429,
    'a refund must not credit the part of the debit that refill already paid')
})

test('OTLP mixed batches report permanent rejects without losing valid records', async (t) => {
  const f = fixture(t), post = await f.listen()
  const capped = log('cap', { input_tokens: 100_000_000, output_tokens: 1 })
  const conflict = log('r0', { input_tokens: 1 })
  for (const [i, rejected] of [log('unknown', { 'ccr.session.id': 'unbound' }), conflict, capped].entries()) {
    assert.deepEqual(await post(payload([log(`r${i}`), rejected])), partial(1))
    assert.equal(f.rows().length, i + 1)
  }
  assert.deepEqual(await post(payload([log('r0'), conflict])), partial(1), 'duplicates count as success')
  assert.deepEqual(await post(payload([conflict, capped])), error(400, 'invalid'))
  assert.deepEqual(await post(payload([capped, conflict])), error(422, 'count_cap'))
  assert.equal(f.rows().length, 3)
})

test('OTLP stops on rate limit but continues past a record-capped session', async (t) => {
  const f = fixture(t), post = await f.listen()
  f.bind('other-session', 3_600_000, 'exec-other')
  const other = log('other', { 'ccr.session.id': 'other-session' })
  const limited = await post(payload([...batch(0, 21), other]))
  assert.equal(limited.status, 429)
  assert.match(limited.retry ?? '', /^[1-9]\d*$/)
  assert.equal(f.rows().length, 20)
  for (let i = 20; i < 5_000; i += 20) { f.advance(4_000); assert.deepEqual(await post(payload(batch(i))), ok) }
  f.advance(4_000)
  assert.deepEqual(await post(payload(batch(5_000, 1))), error(422, 'record_cap'))
  assert.equal(f.rows().length, 5_000)
  assert.deepEqual(await post(payload([...batch(5_000, 1), other])), partial(1))
  assert.equal(f.rows().length, 5_001)
  assert.equal(f.rows().at(-1)?.envelope?.trace.execution_id, 'exec-other')
})

test('OTLP rejects over 500 API requests before booking any', async (t) => {
  const f = fixture(t, 200), post = await f.listen()
  const logs = [log('ignored', {}, 'claude_code.tool_result'), ...batch(0, 500)]
  const over = await post(payload([...logs, log('excess')]))
  assert.deepEqual({ response: over, booked: f.rows().length }, { response: error(413, 'too_many_records'), booked: 0 })
  assert.deepEqual(await post(payload(logs)), ok)
  assert.equal(f.rows().length, 500, 'ignored events do not count toward the limit')
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