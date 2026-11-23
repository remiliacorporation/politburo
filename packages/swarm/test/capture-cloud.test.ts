import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync,
  readSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Book, createReceiver, jsonlLedger, type Claim, type Envelope, type SpendRecord }
  from '../src/capture-cloud/index.ts'

const envelope: Envelope = {
  party: 'default', repo: 'plb', work_id: 'plb-111', attempt: 'att-1', tier: 'mob',
  parent: 'exec-1', session: 'sess-2', trace: { id: 'tr-1', execution_id: 'exec-2' },
}
const session = 'canary-session'
const claim: Claim = {
  source_event_key: 'response-1', model: 'claude-canary', status: 'completed',
  started: '2026-11-22T12:00:00Z', ended: '2026-11-22T12:00:02Z', occurred: '2026-11-22T12:00:03Z',
  tokens: { input_uncached: 7, input_total: 11, output: 3, cache_read: 4, cache_write: 0, reasoning: 1 },
}

function paths(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-capture-cloud-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { bookFile: join(dir, 'book.json'), ledgerFile: join(dir, 'spend.jsonl') }
}

function records(path: string): SpendRecord[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function fixture(t: TestContext) {
  const { bookFile, ledgerFile } = paths(t)
  let time = Date.parse('2026-11-22T12:01:00Z')
  const now = () => time
  const book = new Book({ file: bookFile, now })
  const { capability } = book.issue(envelope, { ttlMs: 3_600_000 })
  book.bind(capability, session)
  const options = () => ({ book, ledger: jsonlLedger(ledgerFile), now })
  let close: (() => Promise<void>) | undefined
  t.after(() => close?.())
  return {
    book, bookFile, capability, now, options, advance: (ms: number) => { time += ms },
    records: () => records(ledgerFile),
    async listen() {
      await close?.()
      close = undefined
      const server = await createReceiver(options()).listen(0)
      close = server.close
      return `http://127.0.0.1:${server.port}`
    },
  }
}

async function post(url: string, capability: string, payload: unknown = claim,
  init: RequestInit & { duplex?: 'half' } = {}) {
  const response = await fetch(`${url}/v1/claims/${capability}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000), ...init,
  })
  return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') }
}

// Catches an auth requirement or incorrect attribution, receipt time, or spend in the canary record.
test('canary books a claim without an Authorization header', async (t) => {
  const f = fixture(t)
  assert.equal((await post(await f.listen(), f.capability)).status, 202)
  const [row, ...rest] = f.records()
  assert.ok(row && rest.length === 0, 'expected exactly one record')
  assert.deepEqual(row.envelope, envelope, 'envelope must come from the Book')
  assert.deepEqual(row.tokens, claim.tokens)
  assert.equal(row.actual_model, claim.model)
  assert.deepEqual([row.started, row.ended, row.occurred], [claim.started, claim.ended, claim.occurred])
  assert.equal(row.received, new Date(f.now()).toISOString(), 'receipt time must come from the receiver')
  assert.equal(row.coverage.state, 'pending')
  assert.equal(row.basis, 'unknown')
  assert.equal(row.amount, null)
})

test('ledger hides raw keys and separates colon-ambiguous claims', async (t) => {
  const { ledgerFile } = paths(t), book = new Book()
  const issue = (execution_id: string) => book.issue({ ...envelope, trace: { ...envelope.trace, execution_id } },
    { ttlMs: 60_000 }).capability
  const a = issue('exec:a'), b = issue('exec')
  const server = await createReceiver({ book, ledger: jsonlLedger(ledgerFile) }).listen(0)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.port}`
  for (const [cap, key] of [[a, a], [a, 'b'], [b, 'a:b']] as const) {
    assert.equal((await post(url, cap, { ...claim, source_event_key: key })).status, 202, `claim ${key === a ? 'with capability key' : key}`)
  }
  assert.equal(readFileSync(ledgerFile, 'utf8').includes(a), false, 'raw capability key in ledger')
  assert.equal(records(ledgerFile).length, 3)
})

// Catches a missing count turned into a reported zero.
test('unknown reasoning stays null', async (t) => {
  const f = fixture(t)
  assert.equal((await post(await f.listen(), f.capability, { ...claim, tokens: { ...claim.tokens, reasoning: null } })).status, 202)
  const [row] = f.records()
  assert.equal(row?.tokens.reasoning, null)
  assert.equal(row?.coverage.field_quality['tokens.reasoning'], 'unknown')
})

// Catches accepting or revealing why a capability is unusable.
test('unknown, expired and revoked capabilities are indistinguishable', async (t) => {
  const f = fixture(t)
  const url = await f.listen()
  const expired = f.book.issue(envelope, { ttlMs: 1 }).capability
  f.book.revoke(f.capability)
  f.advance(1)
  const unknown = await post(url, 'cap_unknown')
  assert.equal(unknown.status, 404, 'unknown capability')
  const nonJson = await post(url, 'cap_unknown', claim, { headers: { 'Content-Type': 'text/plain' } })
  assert.equal(nonJson.status, unknown.status, 'reject unknown capability before media validation')
  assert.equal(nonJson.body, unknown.body)
  for (const [kind, cap] of Object.entries({ expired, revoked: f.capability })) {
    const response = await post(url, cap)
    assert.equal(response.status, unknown.status, `${kind} status`)
    assert.equal(response.body, unknown.body, `${kind} body`)
  }
  assert.deepEqual(f.records(), [])
})

// Catches double counting, replacing an accepted claim, and losing dedupe on restart.
test('replay is idempotent across restart and conflicts keep the first claim', async (t) => {
  const f = fixture(t)
  const url = await f.listen()
  assert.equal((await post(url, f.capability)).status, 202)
  const first = f.records()
  assert.equal(first.length, 1)
  async function duplicate(at: string) {
    const response = await post(at, f.capability)
    assert.equal(response.status, 200, 'identical replay')
    assert.deepEqual(JSON.parse(response.body), { status: 'duplicate' })
    assert.deepEqual(f.records(), first)
  }
  await duplicate(url)
  const conflict = { ...claim, tokens: { ...claim.tokens, output: claim.tokens.output! + 1 } }
  assert.equal((await post(url, f.capability, conflict)).status, 409, 'conflicting replay')
  assert.deepEqual(f.records(), first)
  await duplicate(await f.listen())
})

// Catches accepting extra fields, invalid counts or times, oversized bodies, or non-JSON media.
test('ingress rejects invalid claims without writing', async (t) => {
  const f = fixture(t)
  const url = await f.listen()
  for (const [field, value] of Object.entries({ prompt: 'hello', received: claim.occurred, envelope,
    amount: { value: '1', unit: 'USD' }, coverage: { state: 'live' }, occurred: 'November 22',
    model: 'bedrock/free-text',
    tokens: { ...claim.tokens, extra: 1 } })) {
    assert.equal((await post(url, f.capability, { ...claim, [field]: value })).status, 400, field)
  }
  for (const output of [-1, 0.5, '3']) {
    assert.equal((await post(url, f.capability, { ...claim, tokens: { ...claim.tokens, output } })).status, 400, `output=${JSON.stringify(output)}`)
  }
  const body = JSON.stringify(claim).padEnd(8_193)
  assert.equal((await post(url, f.capability, claim, { body })).status, 413, 'oversize with Content-Length')
  const chunked = { body: new Blob([body]).stream(), duplex: 'half' as const }
  assert.equal((await post(url, f.capability, claim, chunked)).status, 413, 'oversize chunked body')
  assert.equal((await post(url, f.capability, claim, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.deepEqual(f.records(), [])
})

// Catches admitting an oversized token total even when each bucket is valid.
test('token caps reject both an oversized sum and an oversized bucket', async (t) => {
  const f = fixture(t)
  const url = await f.listen()
  for (const output of [100_000_000, 100_000_001]) {
    assert.equal((await post(url, f.capability, { ...claim, tokens: { ...claim.tokens, output } })).status, 422, `output=${output}`)
  }
  assert.deepEqual(f.records(), [])
})

// Catches accepting a 5001st distinct record for one envelope.
test('an envelope can book only 5000 records', async (t) => {
  const f = fixture(t)
  const url = await f.listen()
  for (let i = 1; i <= 5_001; i++) {
    f.advance(200)
    const response = await post(url, f.capability, { ...claim, source_event_key: `response-${i}` })
    assert.equal(response.status, i <= 5_000 ? 202 : 422, `record ${i}`)
  }
  assert.equal(f.records().length, 5_000)
})

// Catches missing, shared, or non-refilling capability and probe allowances.
test('bursts throttle one capability and unknown probes, then refill', async (t) => {
  const f = fixture(t)
  const url = await f.listen()
  const other = f.book.issue({ ...envelope, trace: { ...envelope.trace, execution_id: 'exec-3' } }, { ttlMs: 3_600_000 }).capability
  f.book.bind(other, 'another-session')
  async function burst(cap: (i: number) => string, expected: number) {
    for (let i = 0; i < 40; i++) {
      const response = await post(url, cap(i), { ...claim, source_event_key: `burst-${i}` })
      if (response.status === 429 && i > 0) {
        assert.match(response.retryAfter ?? '', /^[1-9]\d*$/)
        return
      }
      assert.equal(response.status, expected)
    }
    assert.fail(`burst never returned 429 (initial status ${expected})`)
  }
  await burst(() => f.capability, 202)
  assert.equal((await post(url, other)).status, 202)
  f.advance(4_000)
  assert.equal((await post(url, f.capability)).status, 202)
  await burst(i => `cap_unknown_${i}`, 404)
  f.advance(4_000)
  assert.equal((await post(url, 'cap_unknown')).status, 404)
})

// Catches exposing the default listener or bypassing the explicit unsafe bind opt-in.
test('receiver defaults to IPv4 loopback and requires opt-in to bind all', async (t) => {
  const f = fixture(t)
  const url = await f.listen()
  assert.equal((await post(url, f.capability)).status, 202)
  const lan = Object.values(networkInterfaces()).flat().find(ip => ip?.family === 'IPv4' && !ip.internal)
  if (lan) await assert.rejects(fetch(url.replace('127.0.0.1', lan.address), { signal: AbortSignal.timeout(5_000) }),
    (error: Error) => (error.cause as NodeJS.ErrnoException)?.code === 'ECONNREFUSED')
  const options = { ...f.options(), host: '0.0.0.0' }
  assert.throws(() => createReceiver(options), /non-loopback/)
  const all = await createReceiver({ ...options, unsafeBind: true }).listen(0)
  t.after(() => all.close())
  assert.equal((await post(`http://127.0.0.1:${all.port}`, f.capability)).status, 200)
})

test('receiver drops idle connections beyond 256 and recovers', async (t) => {
  const f = fixture(t), url = await f.listen(), sockets: Socket[] = []
  const signal = AbortSignal.timeout(1500)
  function open() {
    const socket = createConnection(Number(new URL(url).port), '127.0.0.1')
    sockets.push(socket)
    return socket
  }
  try {
    await Promise.all(Array.from({ length: 256 }, () => once(open(), 'connect', { signal })))
    await Promise.all(Array.from({ length: 44 }, () => once(open(), 'close', { signal }).catch(error => {
      if (error.code !== 'ECONNREFUSED') assert.fail('excess idle connection stayed open')
    })))
    assert.ok(sockets.slice(0, 256).every(socket => !socket.destroyed), 'first 256 stay open')
  } finally {
    await Promise.all(sockets.map(socket => socket.destroyed ? undefined : once(socket.destroy(), 'close')))
  }
  assert.equal((await post(url, f.capability)).status, 202)
})

// Catches double binding, invalid TTLs, lost bindings, and permissive Book file modes.
test('Book persists private, exclusive session bindings only until expiry', (t) => {
  const f = fixture(t)
  const mask = process.umask(0o022)
  let other: string
  try { other = f.book.issue(envelope, { ttlMs: 86_400_000 }).capability } finally { process.umask(mask) }
  assert.throws(() => f.book.bind(f.capability, 'another-session'), /already bound/)
  assert.throws(() => f.book.bind(other, session), /already bound/)
  for (const ttlMs of [0, 86_400_001]) assert.throws(() => f.book.issue(envelope, { ttlMs }), /invalid ttl/)
  assert.equal(statSync(f.bookFile).mode & 0o777, 0o600, 'Book permissions')
  const reopened = new Book({ file: f.bookFile, now: f.now })
  const entry = reopened.byCapability(f.capability, f.now())
  assert.deepEqual(entry?.envelope, envelope)
  assert.equal(entry?.session, session)
  assert.deepEqual(reopened.bySession(session, f.now()), entry)
  f.advance(3_600_000)
  assert.equal(reopened.byCapability(f.capability, f.now()), undefined)
  assert.equal(reopened.bySession(session, f.now()), undefined)
})

test('Book only loads private regular files, not symlinks', (t) => {
  const f = fixture(t), alias = `${f.bookFile}.alias`
  chmodSync(f.bookFile, 0o644)
  assert.throws(() => new Book({ file: f.bookFile }), /unsafe book file/)
  chmodSync(f.bookFile, 0o600)
  assert.ok(new Book({ file: f.bookFile }).byCapability(f.capability, f.now()))
  symlinkSync(f.bookFile, alias)
  assert.throws(() => new Book({ file: alias }), /unsafe book file/)
})

test('Book takes the lock and preserves both bind and revoke in either order', (t) => {
  const { bookFile } = paths(t), lock = `${bookFile}.lock`, issuer = new Book({ file: bookFile })
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid
  assert.ok(deadPid)
  for (const [i, bindFirst] of [true, false].entries()) {
    const bound = issuer.issue(envelope, { ttlMs: 60_000 }).capability
    const revoked = issuer.issue(envelope, { ttlMs: 60_000 }).capability
    const binder = new Book({ file: bookFile }), revoker = new Book({ file: bookFile })
    const bind = () => binder.bind(bound, `${session}-${i}`), revoke = () => revoker.revoke(revoked)
    writeFileSync(lock, `${deadPid}\n`)
    utimesSync(lock, 0, 0)
    for (const write of bindFirst ? [bind, revoke] : [revoke, bind]) write()
    const final = new Book({ file: bookFile })
    assert.equal(final.byCapability(bound, Date.now())?.session, `${session}-${i}`, 'binding was lost')
    assert.equal(final.byCapability(revoked, Date.now()), undefined, 'revocation was lost')
    assert.equal(existsSync(lock), false, 'dead holder lock was not replaced and released')
  }
})

// Catches stealing a live lock by age so a slow writer can restore a revoked capability.
test('Book does not steal a live lock as stale so a revoke cannot race a slow writer', (t) => {
  const { bookFile } = paths(t), lock = `${bookFile}.lock`, issuer = new Book({ file: bookFile })
  const { capability } = issuer.issue(envelope, { ttlMs: 60_000 })
  writeFileSync(lock, `${process.pid}\n`)
  utimesSync(lock, 0, 0)
  const other = new Book({ file: bookFile })
  assert.throws(() => other.revoke(capability), /book is locked/)
  assert.ok(other.byCapability(capability, Date.now()), 'revoked by stealing a live lock')
  unlinkSync(lock)
  other.revoke(capability)
  assert.equal(other.byCapability(capability, Date.now()), undefined)
})

// Catches a retry after a failed sync acknowledging an unsynced row.
test('retry after a failed sync acknowledges an unsynced row', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-capture-cloud-'))
  const ledgerFile = join(dir, 'spend.jsonl'), bookFile = join(dir, 'book.json')
  const ledger = jsonlLedger(ledgerFile)
  assert.equal(spawnSync('mkfifo', [ledgerFile]).status, 0)
  const fifo = openSync(ledgerFile, constants.O_RDWR | constants.O_NONBLOCK)
  t.after(() => {
    try { closeSync(fifo) } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  })
  const book = new Book({ file: bookFile })
  const { capability } = book.issue(envelope, { ttlMs: 3_600_000 })
  book.bind(capability, session)
  const server = await createReceiver({ book, ledger }).listen(0)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.port}`
  const first = await post(url, capability)
  assert.notEqual(first.status, 200, 'failed sync acknowledged as settled')
  const retry = await post(url, capability)
  assert.notEqual(retry.status, 200, 'retry acknowledged an unsynced row')
  const buf = Buffer.alloc(8192)
  let text = ''
  try { text = buf.subarray(0, readSync(fifo, buf)).toString('utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error }
  assert.equal(text.trim().split('\n').filter(Boolean).length, 1, 'expected exactly one record')
})