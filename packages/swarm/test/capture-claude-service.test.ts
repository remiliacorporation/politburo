import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  createReceiver, fileRegistry, jsonlWriter, readJsonl, releaseQuarantine, type Envelope,
} from '../src/capture-claude/index.ts'

const session = 'native-1'
const now = () => new Date('2026-11-22T12:00:07Z')
const envelope: Envelope = {
  party: 'default', repo: 'acme/web', work_id: 'work-1', attempt: 'att-1', tier: 'spawner',
  parent: null, session: 'sess-1', trace: { id: 'tr-1', execution_id: 'exec-1' },
}

function log(nativeSession: string | null = session, requestId = 'req-1', outputTokens = 91) {
  return {
    body: { stringValue: 'private transcript excerpt' },
    attributes: Object.entries({
      'event.name': { stringValue: 'claude_code.api_request' },
      'session.id': { stringValue: nativeSession },
      request_id: { stringValue: requestId },
      input_tokens: { intValue: '240' },
      output_tokens: { intValue: outputTokens },
      cache_read_tokens: { intValue: 0 },
      prompt: { stringValue: 'private prompt' },
      'user.email': { stringValue: 'fixture@example.test' },
      'user.account_uuid': { stringValue: 'private-account-id' },
      'organization.id': { stringValue: 'private-org-id' },
      cwd: { stringValue: '/fixture/acme/web' },
      branch: { stringValue: 'main' },
      'session.name': { stringValue: envelope.session },
    }).map(([key, value]) => ({ key, value })),
  }
}

const batch = (...logRecords: ReturnType<typeof log>[]) => JSON.stringify({
  resourceLogs: [{ scopeLogs: [{ logRecords }] }],
})

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-service-'))
  const registryPath = join(dir, 'registry.json')
  const registry = fileRegistry(registryPath)
  const ledgerPath = join(dir, 'ledger.jsonl')
  const quarantinePath = join(dir, 'quarantine', 'spend.jsonl')
  mkdirSync(dirname(quarantinePath))
  const ledger = jsonlWriter(ledgerPath)
  const options = { registry, ledger, quarantine: jsonlWriter(quarantinePath), now }
  let running: ReturnType<typeof createReceiver> | undefined
  t.after(async () => {
    try { await running?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  return {
    registry, registryPath, ledger, ledgerPath, quarantinePath, options,
    async start(overrides: Partial<Parameters<typeof createReceiver>[0]> = {}) {
      const receiver = createReceiver({ ...options, ...overrides })
      const address = await receiver.listen()
      running = receiver
      return { address }
    },
  }
}

function send(address: { host: string; port: number }, body: string | Buffer,
  options: RequestOptions = {}, unfinished = false) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ ...address, path: '/v1/logs', method: 'POST', agent: false, ...options,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...options.headers },
    }, (res) => {
      res.setEncoding('utf8')
      let response = ''
      res.on('data', (part) => { response += part })
      res.on('error', reject)
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: response })
        if (unfinished) req.destroy()
      })
    })
    req.on('error', reject)
    req.setTimeout(3_000, () => req.destroy(new Error('no HTTP response')))
    if (unfinished) {
      req.flushHeaders()
      if (body.length > 0) req.write(body)
    } else req.end(body)
  })
}

function assertNoWrites(f: ReturnType<typeof fixture>) {
  assert.deepEqual(readJsonl(f.ledgerPath), [])
  assert.deepEqual(readJsonl(f.quarantinePath), [])
}

test('a bound gzip request is acknowledged only after the ledger has the reported counts, including unknowns', async (t) => {
  const f = fixture(t)
  f.registry.bind(session, envelope)
  const { address } = await f.start()
  assert.deepEqual(await send(address, gzipSync(batch(log())), { headers: { 'Content-Encoding': 'gzip' } }),
    { status: 200, body: '{}' })
  const rows = readJsonl(f.ledgerPath)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]?.envelope, envelope)
  assert.deepEqual(rows[0]?.tokens, {
    input_uncached: 240, input_total: null, output: 91, cache_read: 0, cache_write: null, reasoning: null,
  })
  assert.equal(rows[0]?.coverage.state, 'partial')
  assert.equal(rows[0]?.coverage.field_quality['tokens.cache_write'], 'unknown')
  assert.equal(rows[0]?.received, now().toISOString())
  assert.deepEqual(readJsonl(f.quarantinePath), [])
})

test('an unknown session never borrows a binding from cwd, branch or name', async (t) => {
  const f = fixture(t)
  f.registry.bind(session, envelope)
  const { address } = await f.start()
  assert.equal((await send(address, batch(log('unknown'), log(null)))).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath), [])
  const rows = readJsonl(f.quarantinePath)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.envelope, null)
  assert.equal(rows[0]?.coverage.state, 'unattributed')
  assert.equal(rows[0]?.tokens.output, 91)
})

test('replayed POSTs add no records and neither file retains prompt, transcript or account data', async (t) => {
  const f = fixture(t)
  f.registry.bind(session, envelope)
  const { address } = await f.start()
  const body = batch(log(), log('unbound'))
  const paths = [f.ledgerPath, f.quarantinePath]
  assert.equal((await send(address, body)).status, 200)
  const persisted = paths.map((path) => readFileSync(path, 'utf8'))
  assert.deepEqual(paths.map((path) => readJsonl(path).length), [1, 1])
  for (const contents of persisted) {
    assert.doesNotMatch(contents, /private prompt|private transcript excerpt|fixture@example\.test|private-account-id|private-org-id|"prompt"|"user\.email"|"user\.account_uuid"|"organization\.id"/)
  }
  assert.equal((await send(address, body)).status, 200)
  assert.deepEqual(paths.map((path) => readFileSync(path, 'utf8')), persisted)
})

test('a failed append returns 500, not a durable acknowledgement, and retry fills only the gap', async (t) => {
  const f = fixture(t)
  f.registry.bind(session, envelope)
  const { address } = await f.start()
  rmSync(dirname(f.quarantinePath), { recursive: true })
  const body = batch(log(), log('unbound', 'req-2', 42))
  assert.equal((await send(address, body)).status, 500)
  assert.deepEqual(readJsonl(f.ledgerPath).map((row) => row.tokens.output), [91])
  assert.deepEqual(readJsonl(f.quarantinePath), [])
  mkdirSync(dirname(f.quarantinePath))
  assert.equal((await send(address, body)).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath).map((row) => row.tokens.output), [91])
  assert.deepEqual(readJsonl(f.quarantinePath).map((row) => row.tokens.output), [42])
})

test('the receiver does not listen on a non-loopback host by default or without opt-in', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  assert.equal(address.host, '127.0.0.1')
  assert.ok(address.port > 0)
  assert.throws(() => createReceiver({ ...f.options, host: '0.0.0.0' }), /loopback/)
})

test('a foreign Host header gets 403 and cannot write records', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  assert.equal((await send(address, batch(log()), { headers: { Host: 'foreign.example:1234' } })).status, 403)
  assertNoWrites(f)
})

test('protobuf gets operator guidance, not an acknowledgement or a write', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  const result = await send(address, batch(log()), { headers: { 'Content-Type': 'application/x-protobuf' } })
  assert.equal(result.status, 415)
  assert.match(result.body, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/)
  assertNoWrites(f)
})

test('oversized plain and inflated bodies get 413 and cannot write records', async (t) => {
  const f = fixture(t)
  const { address } = await f.start({ maxBodyBytes: 512 })
  const body = batch(log()) + ' '.repeat(2048)
  const compressed = gzipSync(body)
  assert.ok(compressed.length < 512)
  assert.equal((await send(address, body, {}, true)).status, 413, 'respond before the upload ends')
  assert.equal((await send(address, compressed, { headers: { 'Content-Encoding': 'gzip' } })).status, 413)
  assertNoWrites(f)
})

test('wrong routes, methods and invalid JSON do not ingest or echo a body', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  assert.equal((await send(address, batch(log()), { path: '/v1/traces' })).status, 404)
  assert.equal((await send(address, batch(log()), { method: 'PUT' })).status, 405)
  const invalid = await send(address, '{"private prompt"')
  assert.equal(invalid.status, 400)
  assert.doesNotMatch(invalid.body, /private prompt/)
  assertNoWrites(f)
})

test('late bindings take effect on the next request, and an existing binding cannot change', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  assert.equal((await send(address, batch(log()))).status, 200)
  assert.equal(readJsonl(f.quarantinePath).length, 1)
  const binder = fileRegistry(f.registryPath)
  binder.bind(session, envelope)
  binder.bind(session, { ...envelope, trace: { execution_id: envelope.trace.execution_id, id: envelope.trace.id } })
  assert.throws(() => binder.bind(session, { ...envelope, work_id: 'other' }), /already bound/)
  assert.equal((await send(address, batch(log()))).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath).map((row) => row.envelope), [envelope])
  assert.equal(readJsonl(f.quarantinePath).length, 1)
})

test('a corrupt registry or malformed envelope goes to quarantine, not the ledger', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  writeFileSync(f.registryPath, '{')
  assert.equal((await send(address, batch(log()))).status, 200)
  writeFileSync(f.registryPath, JSON.stringify({ malformed: { ...envelope, tier: 'other' } }))
  assert.equal((await send(address, batch(log('malformed')))).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath), [])
  assert.deepEqual(readJsonl(f.quarantinePath).map((row) => row.envelope), [null, null])
})

test('release uses the exact native session, preserves evidence, and never adds a second successor', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  const nativeSession = 'fixture/%2F:session'
  assert.deepEqual(readJsonl(f.quarantinePath), [])
  assert.equal((await send(address, batch(log(nativeSession)))).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath), [])
  appendFileSync(f.quarantinePath, '{"truncated":')
  const records = readJsonl(f.quarantinePath)
  assert.equal(records.length, 1)
  const [original] = records
  const releaseTime = new Date('2026-11-22T12:01:00Z')
  const release = (ledger = f.ledger) => releaseQuarantine({
    records, registry: f.registry, ledger, actor: 'operator', reason: 'binding verified', now: releaseTime,
  })
  f.registry.bind('fixture', { ...envelope, work_id: 'other' })
  assert.deepEqual(release(), { released: 0, stillUnbound: 1 })
  assert.deepEqual(readJsonl(f.ledgerPath), [])
  f.registry.bind(nativeSession, envelope)
  assert.deepEqual(release(), { released: 1, stillUnbound: 0 })
  const persisted = readFileSync(f.ledgerPath, 'utf8')
  const [successor] = readJsonl(f.ledgerPath)
  assert.ok(successor && original)
  assert.notEqual(successor.record_id, original.record_id)
  assert.deepEqual(successor, {
    ...original, record_id: successor.record_id, envelope, revises: original.record_id,
    actor: 'operator', reason: 'binding verified', received: releaseTime.toISOString(),
    coverage: { ...original.coverage, state: 'partial' },
  })
  release(jsonlWriter(f.ledgerPath))
  assert.equal(readFileSync(f.ledgerPath, 'utf8'), persisted)
  assert.deepEqual(readJsonl(f.quarantinePath), records)
})

test('prototype-named sessions quarantine until explicitly bound, then keep distinct bindings', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  const names = ['__proto__', 'constructor']
  const body = batch(...names.map((name) => log(name)))
  f.registry.bind(session, envelope)
  assert.equal((await send(address, body)).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath), [])
  assert.deepEqual(readJsonl(f.quarantinePath).map((row) => row.envelope), [null, null])

  const binder = fileRegistry(f.registryPath)
  const bindings = names.map((name) => ({ ...envelope, work_id: name }))
  for (const [index, name] of names.entries()) binder.bind(name, bindings[index]!)
  assert.equal((await send(address, body)).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath).map((row) => row.envelope), bindings)
})

test('colon and path-like session IDs release both distinct requests even when their joined IDs match', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  const prefix = 'fixture/../%2F'
  const body = batch(log(`${prefix}:part`, 'req-1'), log(prefix, 'part:req-1', 42))
  assert.equal((await send(address, body)).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath), [])
  const records = readJsonl(f.quarantinePath)
  assert.equal(records.length, 2, 'distinct requests must not collapse in quarantine')
  assert.notEqual(records[0]?.evidence_ref, records[1]?.evidence_ref)

  f.registry.bind(`${prefix}:part`, envelope)
  const other = { ...envelope, work_id: 'other' }
  f.registry.bind(prefix, other)
  releaseQuarantine({
    records, registry: f.registry, ledger: f.ledger, actor: 'operator', reason: 'binding verified', now,
  })
  assert.equal((await send(address, body)).status, 200)
  assert.deepEqual(readJsonl(f.ledgerPath).map((row) => [row.envelope, row.tokens.output]), [[envelope, 91], [other, 42]])
})

test('a completed empty POST returns 400 without writing', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  assert.equal((await send(address, '', { headers: { 'Content-Length': 0 } })).status, 400)
  assertNoWrites(f)
})

test('stalled fixed-length and chunked POSTs time out without writing', async (t) => {
  const f = fixture(t)
  const { address } = await f.start({ requestTimeoutMs: 200 })
  const [missing, chunked, gzip] = await Promise.all([
    send(address, '', { headers: { 'Content-Length': 10 } }, true),
    send(address, '{', { headers: { 'Transfer-Encoding': 'chunked' } }, true),
    send(address, gzipSync(batch(log())), { headers: { 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked' } }, true),
  ])
  assert.deepEqual([missing.status, chunked.status, gzip.status], [408, 408, 408])
  assertNoWrites(f)
  assert.equal((await send(address, batch(log()))).status, 200, 'the listener still accepts valid requests')
})

test('listen rejects with EADDRINUSE on an occupied port without disturbing the listener', async (t) => {
  const f = fixture(t)
  const { address } = await f.start()
  const contender = createReceiver({ ...f.options, ...address })
  await assert.rejects(contender.listen(), { code: 'EADDRINUSE' })
  assert.equal((await send(address, batch(log()))).status, 200)
})
