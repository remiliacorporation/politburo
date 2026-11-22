import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
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
  const adviser: Adviser = { async advise(packet) { packets.push(packet); return { text: reply } } }
  const first = await terra(dir, adviser).advise(exception)
  assert.deepEqual(first, { status: 'answered', answer, audited: true })
  assert.equal(packets.length, 1)
  const records = readAudit(dir)
  assert.equal(records.length, 1)
  const record = records[0]!
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
  assert.deepEqual(readAudit(dir).map((record) => record.revision), [1, 2])
})

test('an adviser exception fails to wake the spawner or is not audited as unavailable', async (t) => {
  const dir = await tempDir(t)
  const result = await terra(dir, { async advise() { throw new Error('test adviser failed') } }).advise(exception)
  assert.equal(result.status, 'wake_spawner')
  assert.ok(!('answer' in result))
  assert.deepEqual(readAudit(dir).map((record) => [record.outcome, 'answer' in record]), [['unavailable', false]])
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
    Object.keys(invalid).map((revision) => [revision, 'invalid', false]))
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

test('a failed audit write loses the answer or is hidden from the caller', async (t) => {
  const file = join(await tempDir(t), 'not-a-directory')
  await writeFile(file, '')
  const result = await terra(file).advise(exception)
  assert.equal(result.status, 'answered')
  assert.deepEqual(result.answer, answer)
  assert.equal(result.audited, false)
  assert.match(result.reason, /audit write failed/i)
})

test('pi retains or exposes the packet file or inherits the parent environment', async (t) => {
  const sentinel = `SWARM_TERRA_TEST_${randomUUID()}`
  process.env[sentinel] = 'synthetic-test-secret'
  t.after(() => { delete process.env[sentinel] })
  const packet = compilePacket(exception)
  let observed: { file: string; text: string; mode: number; envKeys: string[]; hasSentinel: boolean } | undefined
  const adviser = piAdviser({ model: 'test-model', thinking: 'low', async run(_command, [file], { env }) {
    assert.ok(file && dirname(dirname(file)) === tmpdir(), 'expected a temporary packet file')
    t.after(() => rm(dirname(file), { recursive: true, force: true }))
    observed = {
      file, text: await readFile(file, 'utf8'), mode: (await stat(file)).mode & 0o777,
      envKeys: env ? Object.keys(env).sort() : [], hasSentinel: !!env && sentinel in env,
    }
    return { stdout: reply }
  } })
  assert.deepEqual(await adviser.advise(packet), { text: reply })
  assert.ok(observed)
  assert.equal(observed.text, packet)
  assert.equal(observed.mode, 0o600)
  assert.equal(observed.hasSentinel, false, 'the parent secret was passed to pi')
  assert.deepEqual(observed.envKeys, ['HOME', 'PATH', 'PI_MODEL', 'PI_THINKING'])
  await assert.rejects(stat(observed.file), { code: 'ENOENT' })
})
