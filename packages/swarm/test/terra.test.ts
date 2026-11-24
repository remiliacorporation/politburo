import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { appendAudit } from '../src/classifier/audit.ts'
import {
  compilePacket, createTerra, estimateTokens, piAdviser, readAudit, stubAdviser,
  type Adviser, type Answer, type TerraCase,
} from '../src/classifier/terra.ts'

const exception: TerraCase = {
  id: 'case-17', revision: 1, kind: 'check_retire_exception',
  question: 'Who should clarify the conflicting retirement receipts?',
  facts: [{ source: 'handoff', text: 'One reviewer has not signed off.', priority: 1 }],
}
const answer: Answer = {
  advice: 'Ask the spawner to reconcile the receipts.',
  next_step: 'ask_spawner', need_facts: [], confidence: 'high',
}
const reply = JSON.stringify(answer)

async function tempDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-terra-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const terra = (dir: string, adviser = stubAdviser(reply)) =>
  createTerra({ dir, adviser, model: 'test-model' })

test('a crowded packet overruns the cap, clips a fact, or loses required text', () => {
  const facts = Array.from({ length: 30 }, (_, i) => ({
    source: `receipt-${i}-source`,
    text: `Receipt ${i} starts. ${'A reviewer supplied a signed receipt. '.repeat(40)}End of receipt ${i}.`,
    priority: 30 - i,
  }))
  const packet = compilePacket({ ...exception, facts })
  assert.ok(estimateTokens(packet) <= 3_200, 'packet exceeds the token estimate cap')
  assert.ok(packet.includes(exception.question), 'question was lost')
  assert.match(packet, /exactly one JSON object/i)
  for (const field of Object.keys(answer)) assert.ok(packet.includes(`"${field}"`), field)

  let kept = 0
  for (const { source, text } of facts) {
    if (packet.includes(source) || packet.includes(text.slice(0, 24))) {
      assert.ok(packet.includes(text), `partial fact from ${source}`)
      kept++
    }
  }
  assert.ok(kept > 0 && kept < facts.length, 'some but not all facts should fit')
  assert.match(packet, new RegExp(`\\b${facts.length - kept}\\b[^\\n]*\\b(?:omitted|dropped)\\b`, 'i'))
})

test('a diff, fenced code, private key header, or bearer token leaks into a packet', () => {
  const unsafe = [
    'diff --git a/fixture b/fixture', '```ts\nconst fixture = 1\n```',
    '-----BEGIN PRIVATE KEY-----', 'Authorization: Bearer synthetic-fixture-token',
  ]
  const facts = unsafe.map((text, i) => ({
    source: `unsafe-receipt-${i}`, text: `unsafe-content-${i}\n${text}`, priority: 1,
  }))
  const packet = compilePacket({ ...exception, facts: [...exception.facts, ...facts] })
  assert.ok(packet.includes(exception.facts[0]!.text), 'safe fact was lost')
  for (const [i, fact] of facts.entries()) {
    assert.ok(!packet.includes(fact.source) && !packet.includes(`unsafe-content-${i}`)
      && !packet.includes(unsafe[i]!), `unsafe fact ${i} was included`)
  }
})

test('a repeated case calls the adviser again or loses its audited packet hash or answer', async (t) => {
  const dir = await tempDir(t)
  const packets: string[] = []
  let outcomesAtCall: string[] | undefined
  const adviser: Adviser = { async advise(packet) {
    outcomesAtCall = readAudit(dir).map((record) => record.outcome)
    packets.push(packet)
    return { text: reply }
  } }
  const first = await terra(dir, adviser).advise(exception)
  assert.deepEqual(outcomesAtCall, ['pending'], 'pending must be visible before the call')
  assert.deepEqual(first, { status: 'answered', answer, audited: true })
  assert.equal(packets.length, 1)
  const records = readAudit(dir)
  assert.deepEqual(records.map((record) => record.outcome), ['pending', 'answered'])
  const record = records[1]!
  assert.equal(record.case_id, exception.id)
  assert.equal(record.revision, exception.revision)
  assert.equal(record.packet_sha256, createHash('sha256').update(packets[0]!).digest('hex'))
  assert.equal(record.outcome, 'answered')
  assert.deepEqual(record.answer, answer)

  const replay = await terra(dir, adviser).advise(exception)
  assert.equal(packets.length, 1, 'replay called the adviser')
  assert.deepEqual(replay, { status: 'answered', answer: record.answer, audited: true })
  assert.deepEqual(readAudit(dir), records)
})

test('a new revision is mistaken for an already advised case', async (t) => {
  const dir = await tempDir(t)
  let calls = 0
  const updated = { ...answer, advice: 'The receipts now agree.' }
  const service = terra(dir, { async advise() { return { text: ++calls === 1 ? reply : JSON.stringify(updated) } } })
  await service.advise(exception)
  const result = await service.advise({ ...exception, revision: 2 })
  assert.equal(calls, 2)
  assert.deepEqual(result, { status: 'answered', answer: updated, audited: true })
  assert.deepEqual(readAudit(dir).map((record) => record.revision), [1, 1, 2, 2])
})

test('an adviser exception fails to wake the spawner or is not audited as unavailable', async (t) => {
  const dir = await tempDir(t)
  const result = await terra(dir, { async advise() { throw new Error('test adviser failed') } }).advise(exception)
  assert.equal(result.status, 'wake_spawner')
  assert.ok(!('answer' in result))
  assert.deepEqual(readAudit(dir).map((record) => [record.outcome, 'answer' in record]),
    [['pending', false], ['unavailable', false]])
})

test('an out-of-format answer is accepted or is not audited as invalid', async (t) => {
  const dir = await tempDir(t)
  const invalid = {
    'extra key': JSON.stringify({ ...answer, extra: true }),
    'long advice': JSON.stringify({ ...answer, advice: 'x'.repeat(601) }),
    merge: JSON.stringify({ ...answer, next_step: 'merge' }),
    push: JSON.stringify({ ...answer, next_step: 'push' }),
    'unknown next step': JSON.stringify({ ...answer, next_step: 'unknown' }),
    'surrounding prose': `Here is my advice: ${reply} Hope that helps.`,
  }
  for (const [revision, text] of Object.entries(invalid)) {
    const result = await terra(dir, stubAdviser(text)).advise({ ...exception, revision })
    assert.equal(result.status, 'wake_spawner', revision)
    assert.ok(!('answer' in result), revision)
  }
  assert.deepEqual(readAudit(dir).map((record) => [record.revision, record.outcome, 'answer' in record]),
    Object.keys(invalid).flatMap((revision) => [[revision, 'pending', false], [revision, 'invalid', false]]))
})

test('an ineligible kind reaches the adviser instead of being refused', async (t) => {
  const dir = await tempDir(t)
  let calls = 0
  const result = await terra(dir, { async advise() { calls++; return { text: reply } } })
    .advise({ ...exception, kind: 'routine_status' })
  assert.equal(calls, 0)
  assert.equal(result.status, 'wake_spawner')
  assert.deepEqual(readAudit(dir).map((record) => record.outcome), ['refused'])
})

test('concurrent callers invoke the adviser twice or receive different results', async (t) => {
  const dir = await tempDir(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const adviser: Adviser = { async advise() {
    calls++
    entered.resolve()
    await release.promise
    return { text: reply }
  } }
  const first = terra(dir, adviser).advise(exception)
  await entered.promise
  const second = terra(dir, adviser).advise(exception)
  release.resolve()
  const expected = { status: 'answered', answer, audited: true }
  assert.deepEqual(await Promise.all([first, second]), [expected, expected])
  assert.equal(calls, 1)
})

const auditCase = { case_id: exception.id, revision: exception.revision }
const pendingRecord = JSON.stringify({ ...auditCase, outcome: 'pending', reason: null })

test('replay calls again after an unfinished adviser call', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'terra.jsonl'), `${pendingRecord}\n`)
  let calls = 0
  const service = terra(dir, { async advise() { calls++; return { text: reply } } })
  assert.deepEqual(await service.advise(exception), { status: 'wake_spawner', reason: 'uncertain_previous_call' })
  assert.equal(calls, 0)
})

test('replay trusts an answered record with a bad or missing answer', async (t) => {
  const dir = await tempDir(t)
  const answered = { ...auditCase, outcome: 'answered', reason: null }
  const bad = { ...answered, answer: { ...answer, next_step: 'merge' } }
  const missing = { ...answered, revision: 2 }
  await writeFile(join(dir, 'terra.jsonl'), `${JSON.stringify(bad)}\n${JSON.stringify(missing)}\n`)
  let calls = 0
  const service = terra(dir, { async advise() { calls++; return { text: reply } } })
  for (const revision of [1, 2]) {
    assert.deepEqual(await service.advise({ ...exception, revision }), { status: 'wake_spawner', reason: 'corrupt_audit' })
  }
  assert.equal(calls, 0)
})

test('an unreadable middle line does not block replay or new calls', async (t) => {
  const dir = await tempDir(t)
  const answered = JSON.stringify({ ...auditCase, outcome: 'answered', reason: null, answer })
  await writeFile(join(dir, 'terra.jsonl'), `${answered}\n{\n${pendingRecord}\n`)
  let calls = 0
  const service = terra(dir, { async advise() { calls++; return { text: reply } } })
  for (const revision of [1, 2]) {
    assert.deepEqual(await service.advise({ ...exception, revision }), { status: 'wake_spawner', reason: 'corrupt_audit' })
  }
  assert.equal(calls, 0)
})

test('a torn tail blocks new advice or turns into middle-line corruption on append', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'terra.jsonl'), `${pendingRecord}\n{`)
  const updated = { ...exception, revision: 2 }
  const answered = { status: 'answered', answer, audited: true }
  assert.deepEqual(await terra(dir).advise(updated), answered)
  assert.deepEqual(await terra(dir, stubAdviser('')).advise(updated), answered)
  assert.deepEqual(await terra(dir).advise(exception), { status: 'wake_spawner', reason: 'uncertain_previous_call' })
})

test('a stale torn-tail repair erases another writer’s durable pending record and allows a second call', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'terra.jsonl')
  await writeFile(file, '{')
  const read = fs.readFileSync
  let reads = 0
  const hook = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => {
    const snapshot = read(...args)
    if (args[0] === file && ++reads === 2) {
      // The second read is for repair. Another writer commits before it returns.
      appendAudit(dir, {
        ...auditCase, outcome: 'pending', reason: null, at: new Date(0).toISOString(),
        kind: exception.kind, packet: '', packet_sha256: '', packet_tokens_est: 0, model: 'test-model',
      })
    }
    return snapshot
  })
  syncBuiltinESMExports()
  try {
    assert.deepEqual(await terra(dir).advise({ ...exception, revision: 2 }),
      { status: 'answered', answer, audited: true })
  } finally {
    hook.mock.restore()
    syncBuiltinESMExports()
  }

  let calls = 0
  const retry = terra(dir, { async advise() { calls++; return { text: reply } } })
  assert.deepEqual(await retry.advise(exception), { status: 'wake_spawner', reason: 'uncertain_previous_call' })
  assert.equal(calls, 0)
  assert.ok((await readFile(file, 'utf8')).startsWith('{\n'), 'repair replaced the original fragment')
})

test('a failed pending write still lets the adviser run', async (t) => {
  const dir = await tempDir(t)
  await symlink(join(dir, 'missing', 'audit'), join(dir, 'terra.jsonl'))
  let calls = 0
  const result = await terra(dir, { async advise() { calls++; return { text: reply } } }).advise(exception)
  assert.deepEqual(result, { status: 'wake_spawner', reason: 'audit write failed' })
  assert.equal(calls, 0)
})

test('pi retains or exposes the packet file or drops allowed or model environment keys', async (t) => {
  const packet = compilePacket(exception)
  let observed: { file: string; text: string; mode: number; env: Record<string, string | undefined> } | undefined
  const allowed = { PATH: '/fixture/bin', HOME: '/fixture', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TMPDIR: '/fixture/tmp' }
  const adviser = piAdviser({ env: allowed, model: 'test-model', thinking: 'low', async run(_command, [file], { env }) {
    assert.ok(file && dirname(dirname(file)) === tmpdir(), 'expected a temporary packet file')
    t.after(() => rm(dirname(file), { recursive: true, force: true }))
    observed = { file, text: await readFile(file, 'utf8'), mode: (await stat(file)).mode & 0o777, env }
    return { stdout: reply }
  } })
  assert.deepEqual(await adviser.advise(packet), { text: reply })
  assert.ok(observed)
  assert.equal(observed.text, packet)
  assert.equal(observed.mode, 0o600)
  assert.deepEqual(observed.env, { ...allowed, PI_MODEL: 'test-model', PI_THINKING: 'low' })
  await assert.rejects(stat(observed.file), { code: 'ENOENT' })
})

test('pi accepts an unlisted environment key instead of rejecting it before the runner can be called', () => {
  let calls = 0
  assert.throws(() => piAdviser({
    env: { PATH: '/fixture/bin', SENTINEL_SECRET: 'not-a-real-secret' }, model: 'test-model', thinking: 'low',
    async run() { calls++; return { stdout: reply } },
  }), /unlisted environment key/)
  assert.equal(calls, 0)
})
