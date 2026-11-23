import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, open, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { jsonlLedger } from '../src/capture/ledger.ts'
import type { Envelope, SpendRecord } from '../src/capture/types.ts'

const envelope: Envelope = {
  party: 'default', repo: 'plb', work_id: 'plb-482', attempt: 'att-42', tier: 'sprite',
  parent: 'exec-70', session: 'sess-91', trace: { id: 'tr-42', execution_id: 'exec-91' },
}

const record: SpendRecord = {
  record_id: 'sp:fixture', dedupe_key: 'fixture', revises: null, envelope,
  source: 'pi_json', source_version: 'fixture-1', source_event_key: 'fixture',
  evidence_ref: 'sprite-log:sprite-91', provider: 'openai', requested_route: 'codex',
  actual_model: 'codex', auth_class: null,
  tokens: { input_uncached: 12, input_total: null, output: 4, cache_read: 7, cache_write: null, reasoning: 2 },
  amount: null, basis: 'unknown', occurred: null, received: '2025-01-01T00:01:00.000Z',
  started: null, ended: null, status: 'completed', exit_reason: 'normal',
  coverage: {
    state: 'closed_reconciled',
    field_quality: {
      amount: 'unknown', 'tokens.input_uncached': 'provider_reported', 'tokens.input_total': 'unknown',
      'tokens.output': 'provider_reported', 'tokens.cache_read': 'provider_reported',
      'tokens.cache_write': 'unknown', 'tokens.reasoning': 'provider_reported',
    },
  },
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, spend: join(dir, 'spend.jsonl'), envelopes: join(dir, 'envelopes.jsonl') }
}

const exec = promisify(execFile)

for (const kind of ['spend', 'envelopes'] as const) {
  test(`two processes cannot write a duplicate ${kind} row or bypass a live ledger lock`, async t => {
    const { dir, [kind]: path } = await fixture(t)
    const lock = join(dir, '.lock')
    await writeFile(lock, `${process.pid}\n`, { flag: 'wx' })
    const code = `
      import { jsonlLedger } from ${JSON.stringify(new URL('../src/capture/ledger.ts', import.meta.url).href)}
      const ledger = jsonlLedger(process.argv[1])
      const row = JSON.parse(process.argv[2])
      console.log('ready')
      ${kind === 'spend' ? 'console.log((await ledger.append(row)).written)' : 'await ledger.registerEnvelope(row)'}
    `
    const row = kind === 'spend' ? record : envelope
    const children = [0, 1].map(() => exec(process.execPath, ['--input-type=module', '-e', code, dir, JSON.stringify(row)], {
      timeout: 10_000,
    }))
    const done = Promise.all(children)
    // Always release the fixture lock and wait for the children, even on assertion failure.
    const before = await (async () => {
      try {
        await Promise.race([Promise.all(children.map(({ child }) => once(child.stdout!, 'data'))), done])
        await sleep(100)
        return await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      } finally {
        await unlink(lock)
        await done
      }
    })()
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    assert.equal(lines.length, 1, 'duplicate row on disk')
    assert.deepEqual(JSON.parse(lines[0]!), row)
    assert.equal(before, undefined, 'a writer bypassed a live lock')
    if (kind === 'spend') assert.deepEqual((await done).map(result => result.stdout.trim().split('\n').at(-1)).sort(), ['false', 'true'])
    await assert.rejects(readFile(lock), { code: 'ENOENT' })
  })
}

test('a live lock older than 60 seconds is not stolen; the waiting writer times out', async t => {
  const { dir, spend } = await fixture(t)
  const lock = join(dir, '.lock')
  const owner = `${process.pid}\n`
  await writeFile(lock, owner)
  const old = new Date(Date.now() - 61_000)
  await utimes(lock, old, old)

  await assert.rejects(jsonlLedger(dir).append(record), /capture ledger lock timed out/)
  assert.equal(await readFile(lock, 'utf8'), owner)
  await assert.rejects(readFile(spend), { code: 'ENOENT' })
  await unlink(lock)
  assert.deepEqual(await jsonlLedger(dir).append(record), { written: true })
})

test('two concurrent writers recover a dead PID lock and only one writes the dedupe key', async t => {
  const { dir, spend } = await fixture(t)
  const lock = join(dir, '.lock')
  const dead = exec(process.execPath, ['-e', ''])
  const pid = dead.child.pid!
  await dead
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await writeFile(lock, `${pid}\n`)

  const code = `
    import { once } from 'node:events'
    import { jsonlLedger } from ${JSON.stringify(new URL('../src/capture/ledger.ts', import.meta.url).href)}
    const start = once(process.stdin, 'end')
    process.stdin.resume()
    console.log('ready')
    await start
    const ledger = jsonlLedger(process.argv[1])
    console.log((await ledger.append(JSON.parse(process.argv[2]))).written)
  `
  const children = [0, 1].map(() => exec(process.execPath, ['--input-type=module', '-e', code, dir, JSON.stringify(record)], {
    timeout: 10_000,
  }))
  const done = Promise.all(children)
  try {
    await Promise.race([Promise.all(children.map(({ child }) => once(child.stdout!, 'data'))), done])
  } finally {
    for (const { child } of children) child.stdin!.end()
    await Promise.allSettled(children)
  }
  const results = (await done).map(({ stdout }) => stdout.trim().split('\n').at(-1)).sort()
  assert.deepEqual(results, ['false', 'true'])
  const lines = (await readFile(spend, 'utf8')).split('\n')
  assert.equal(lines.pop(), '', 'last row was not newline-terminated')
  assert.deepEqual(lines.map(line => JSON.parse(line)), [record])
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
})

test('a read failure after lock creation removes the lock and allows the next append', async t => {
  const { dir, spend } = await fixture(t)
  const lock = join(dir, '.lock')
  await mkdir(spend) // Reading the ledger fails before any append can occur.
  const ledger = jsonlLedger(dir)
  await assert.rejects(ledger.append(record), { code: 'EISDIR' })
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
  await rm(spend, { recursive: true })
  assert.deepEqual(await ledger.append(record), { written: true })
})

test('a replay after reopening the ledger does not write a second line', async t => {
  const { dir, spend } = await fixture(t)
  assert.deepEqual(await jsonlLedger(dir).append(record), { written: true })
  const original = await readFile(spend, 'utf8')
  assert.deepEqual(await jsonlLedger(dir).append(structuredClone(record)), { written: false })
  assert.equal(await readFile(spend, 'utf8'), original)
})

for (const [description, tail] of [
  ['unterminated partial JSON', '{"dedupe_key":'],
  ['unterminated valid JSON', JSON.stringify({ ...record, status: 'failed' })],
  ['newline-terminated invalid JSON', '{"dedupe_key":\n'],
] as const) {
  test(`a torn tail with ${description} does not block or poison later appends`, async t => {
    const { dir, spend } = await fixture(t)
    const first = { ...record, record_id: 'sp:earlier', dedupe_key: 'earlier', actual_model: '雪' }
    await jsonlLedger(dir).append(first)
    await appendFile(spend, tail)
    assert.deepEqual(await jsonlLedger(dir).append(record), { written: true })
    const lines = (await readFile(spend, 'utf8')).split('\n')
    assert.equal(lines.pop(), '', 'last row was not newline-terminated')
    assert.deepEqual(lines.map(line => JSON.parse(line)), [first, record])
    for (const row of [first, record]) {
      assert.deepEqual(await jsonlLedger(dir).append(row), { written: false })
    }
  })
}

test('concurrent registration of the same envelope across handles does not add a second line', async t => {
  const { dir, envelopes } = await fixture(t)
  await Promise.all([
    jsonlLedger(dir).registerEnvelope(envelope),
    jsonlLedger(dir).registerEnvelope(structuredClone(envelope)),
  ])
  assert.equal(await readFile(envelopes, 'utf8'), JSON.stringify(envelope) + '\n')
})

test('a different envelope for the same execution ID is rejected without changing the ledger', async t => {
  const { dir, envelopes } = await fixture(t)
  await jsonlLedger(dir).registerEnvelope(envelope)
  await assert.rejects(jsonlLedger(dir).registerEnvelope({ ...envelope, session: 'other' }), /execution_id conflict/)
  assert.equal(await readFile(envelopes, 'utf8'), JSON.stringify(envelope) + '\n')
})

for (const [description, change, conflict] of [
  ['a token change under the same dedupe key', { tokens: { ...record.tokens, output: 9 } }, /dedupe_key conflict/],
  ['a status change under the same dedupe key', { status: 'failed' }, /dedupe_key conflict/],
  ['a model change under the same dedupe key', { actual_model: 'other-model' }, /dedupe_key conflict/],
  ['record ID reuse under a different dedupe key', { dedupe_key: 'different' }, /record_id conflict/],
] as const) {
  test(`${description} is rejected without changing the ledger`, async t => {
    const { dir, spend } = await fixture(t)
    await jsonlLedger(dir).append(record)
    const original = await readFile(spend, 'utf8')
    await assert.rejects(jsonlLedger(dir).append({ ...record, ...change }), conflict)
    assert.equal(await readFile(spend, 'utf8'), original)
  })
}

for (const [description, field, quality] of [
  ['non-null token with unknown quality', 'tokens.output', 'unknown'],
  ['null token with reported quality', 'tokens.cache_write', 'provider_reported'],
] as const) {
  test(`a ${description} is rejected before it is written`, async t => {
    const { dir, spend } = await fixture(t)
    const coverage = { ...record.coverage, field_quality: { ...record.coverage.field_quality, [field]: quality } }
    await assert.rejects(jsonlLedger(dir).append({ ...record, coverage }), /inconsistent field_quality/)
    await assert.rejects(readFile(spend), { code: 'ENOENT' })
  })
}

for (const kind of ['spend', 'envelopes'] as const) {
  test(`${kind} append does not report success when syncing the written line fails`, async t => {
    const { dir, [kind]: path } = await fixture(t)
    const probe = await open(path, 'a')
    await probe.close()
    const failure = new Error('fixture datasync failure')
    t.mock.method(Object.getPrototypeOf(probe), 'datasync', async () => {
      const lines = (await readFile(path, 'utf8')).split('\n')
      assert.equal(lines.pop(), '', 'line was not written before syncing')
      assert.deepEqual(lines.map(line => JSON.parse(line)), [kind === 'spend' ? record : envelope])
      throw failure
    })
    const ledger = jsonlLedger(dir)
    const append = kind === 'spend' ? ledger.append(record) : ledger.registerEnvelope(envelope)
    await assert.rejects(append, error => error === failure)
    await assert.rejects(readFile(join(dir, '.lock')), { code: 'ENOENT' })
  })
}

test('disk rows omit extra prompt, output, and credential fields without losing allowed data', async t => {
  const { dir, spend, envelopes } = await fixture(t)
  const ledger = jsonlLedger(dir)
  const extraEnvelope = { ...envelope, trace: { ...envelope.trace, apiKey: 'fake trace key' } }
  const extraRecord = {
    ...record, envelope: extraEnvelope, prompt: 'private fixture prompt', output: 'private fixture reply',
    tokens: { ...record.tokens, text: 'private fixture text' },
    coverage: { ...record.coverage, field_quality: { ...record.coverage.field_quality, apiKey: 'fake key' } },
  }
  await ledger.registerEnvelope(extraEnvelope)
  await ledger.append(extraRecord)
  assert.deepEqual(JSON.parse(await readFile(envelopes, 'utf8')), envelope)
  assert.deepEqual(JSON.parse(await readFile(spend, 'utf8')), record)
})
