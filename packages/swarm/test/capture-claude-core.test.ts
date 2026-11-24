import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import * as capture from '../src/capture-claude/index.ts'
import type { Envelope } from '../src/capture-claude/index.ts'

const { buildRecord, jsonlWriter, parseOtlpLogs, parseTranscript, reconcile } = capture

const session = 'native-1'
const now = new Date('2026-11-22T12:00:07Z')
const envelope: Envelope = {
  party: 'default', repo: 'acme/web', work_id: 'work-1', attempt: 'att-1', tier: 'spawner',
  parent: null, session: 'sess-1', trace: { id: 'tr-1', execution_id: 'exec-1' },
}

function log(attributes: Record<string, object> = {}) {
  return {
    timeUnixNano: '1795348806000000123',
    attributes: Object.entries({
      'event.name': { stringValue: 'claude_code.api_request' },
      'session.id': { stringValue: session },
      request_id: { stringValue: 'req-1' },
      'message.id': { stringValue: 'msg-1' },
      model: { stringValue: 'claude-example' },
      input_tokens: { intValue: '240' },
      output_tokens: { intValue: 91 },
      cache_read_tokens: { intValue: 0 },
      ...attributes,
    }).map(([key, value]) => ({ key, value })),
  }
}

function batch(...logRecords: object[]) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords }] }] }
}

function assistant(usage?: object, requestId = 'req-1', id = 'msg-1') {
  return {
    type: 'assistant', requestId, timestamp: '2026-11-22T13:00:06+01:00',
    message: { id, model: 'claude-example', usage },
  }
}

function transcript(...rows: object[]) {
  return parseTranscript(rows.map((row) => JSON.stringify(row)).join('\n'), session).facts
}

function spendPath(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-claude-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'spend.jsonl')
}

test('OTLP preserves reported zero and leaves missing or malformed counts null', () => {
  const { facts } = parseOtlpLogs(batch(log(), log({
    input_tokens: { intValue: -1 }, output_tokens: { doubleValue: 1.5 }, cache_read_tokens: { stringValue: '12' },
  })))
  assert.deepEqual(facts[0]?.tokens, {
    input_uncached: 240, input_total: null, output: 91, cache_read: 0, cache_write: null, reasoning: null,
  })
  assert.equal(facts[0]?.occurred, '2026-11-22T12:00:06.000Z')
  assert.deepEqual(facts[1]?.tokens, {
    input_uncached: null, input_total: null, output: null, cache_read: null, cache_write: null, reasoning: null,
  })
})

test('transcript numeric strings stay unknown and reported zero stays zero', () => {
  const [row] = transcript(assistant({ input_tokens: '12', output_tokens: 0 }))
  assert.equal(row?.tokens.input_uncached, null)
  assert.equal(row?.tokens.output, 0)
  assert.equal(row?.tokens.cache_read, null)
  assert.equal(row?.occurred, '2026-11-22T12:00:06.000Z')
})

test('OTLP accepts a body-named request and rejects a request without a session', () => {
  const named = { ...log({ 'event.name': {} }), body: { stringValue: 'api_request' } }
  const { facts, rejected } = parseOtlpLogs(batch(named, log({ 'session.id': {} })))
  assert.equal(rejected, 1)
  assert.deepEqual(facts.map((fact) => fact.nativeSession), [session])
})

test('OTLP tool_result events produce no request facts', () => {
  const unrelated = log({ 'event.name': { stringValue: 'tool_result' } })
  assert.deepEqual(parseOtlpLogs(batch(unrelated)), { facts: [], rejected: 0 })
})

test('prompt text, account data, tool input, and paths stay out of facts and JSONL', (t) => {
  const { facts } = parseOtlpLogs(batch(log({
    prompt: { stringValue: 'private prompt' }, 'user.email': { stringValue: 'fixture@example.test' },
  })))
  const row = assistant({ output_tokens: 5 }, 'req-2', 'msg-2')
  const rows = transcript({ ...row, cwd: '/private/fixture', message: { ...row.message, content: [
    { text: 'private response' }, { input: { command: 'private tool input' } },
  ] } })
  const path = spendPath(t)
  const writer = jsonlWriter(path)
  for (const item of reconcile(facts, rows).records) writer.append(buildRecord(item, envelope, now))
  const persisted = readFileSync(path, 'utf8')
  assert.equal(facts.length, 1)
  assert.equal(rows.length, 1)
  assert.deepEqual(persisted.trimEnd().split('\n').map((line) => JSON.parse(line).tokens.output), [91, 5])
  const serialized = JSON.stringify({ facts, rows }) + persisted
  for (const secret of ['private prompt', 'fixture@example.test', '/private/fixture', 'private response', 'private tool input']) {
    assert.ok(!serialized.includes(secret), `captured ${secret}`)
  }
})

test('transcript counts each response once without combining usage snapshots', () => {
  const rows = transcript(
    assistant({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100 }),
    assistant({ input_tokens: 8, output_tokens: 9 }),
    assistant({ input_tokens: 2, output_tokens: 4 }),
    assistant({ output_tokens: 1 }, 'req-1', 'msg-2'),
  )
  assert.deepEqual(rows.map(({ responseId, tokens }) => [responseId, tokens.input_uncached, tokens.output, tokens.cache_read]), [
    ['msg-1', 8, 9, null], ['msg-2', null, 1, null],
  ])
})

test('transcript preserves identified usage gaps but skips user and anonymous empty rows', () => {
  const rows = transcript(assistant(), assistant(undefined, '', ''), {
    ...assistant({ output_tokens: 12 }, 'req-2', 'msg-2'), type: 'user',
  })
  assert.deepEqual(rows.map((fact) => [fact.responseId, fact.tokens]), [['msg-1', {
    input_uncached: null, input_total: null, output: null, cache_read: null, cache_write: null, reasoning: null,
  }]])
})

test('transcript counts a truncated JSON line and reads both neighbours', () => {
  const before = assistant({ output_tokens: 3 })
  const after = assistant({ output_tokens: 5 }, 'req-2', 'msg-2')
  const { facts, badLines } = parseTranscript([
    JSON.stringify(before), '{"type":"assistant","message":{"usage":{"output_tokens":', JSON.stringify(after), '',
  ].join('\n'), session)
  assert.equal(badLines, 1)
  assert.deepEqual(facts.map((fact) => [fact.responseId, fact.tokens.output]), [['msg-1', 3], ['msg-2', 5]])
})

test('transcript skips synthetic model rows even when they report tokens', () => {
  const row = assistant({ output_tokens: 10 })
  assert.deepEqual(transcript({ ...row, message: { ...row.message, model: '<synthetic>' } }), [])
})

test('reconciliation counts a matched or replayed request once and keeps uncovered requests', () => {
  const payload = batch(log())
  const otlp = [...parseOtlpLogs(payload).facts, ...parseOtlpLogs(payload).facts]
  const rows = transcript(assistant({ output_tokens: 91 }, '', 'msg-1'), assistant({ output_tokens: 5 }, 'req-2', 'msg-1'))
  const { records, counters } = reconcile(otlp, rows)
  assert.deepEqual(counters, { matched: 1, mismatched: 0, transcriptOnly: 1, otlpOnly: 0 })
  assert.deepEqual(records.map(({ state, fact }) => [state, fact.source, fact.requestId]), [
    ['matched', 'otlp', 'req-1'], ['transcript_only', 'transcript', 'req-2'],
  ])
  assert.deepEqual(reconcile(otlp, []).records.map((row) => row.state), ['otlp_only'])
  assert.deepEqual(reconcile(otlp, rows.slice(1)).records.map((row) => row.state), ['otlp_only', 'transcript_only'])
  const [matched, uncovered] = records.map((row) => buildRecord(row, envelope, now))
  assert.equal(matched?.coverage.state, 'closed_reconciled')
  assert.equal(matched?.tokens.output, 91)
  assert.equal(matched?.tokens.cache_read, 0)
  assert.equal(matched?.coverage.field_quality['tokens.cache_read'], 'provider_reported')
  assert.equal(matched?.tokens.cache_write, null)
  assert.equal(matched?.coverage.field_quality['tokens.cache_write'], 'unknown')
  assert.equal(uncovered?.source, 'claude_local_transcript')
  assert.equal(uncovered?.coverage.state, 'partial')
})

test('reconciliation keeps distinct conflicting OTLP facts and drops their replays', () => {
  const disagreement = log({ output_tokens: { intValue: 90 } })
  const { facts } = parseOtlpLogs(batch(log(), disagreement, disagreement))
  const result = reconcile(facts, [])
  assert.equal(result.counters.mismatched, 1)
  assert.deepEqual(result.records.map(({ state, fact }) => [state, fact.tokens.output]), [
    ['mismatch', 91], ['mismatch', 90],
  ])
})

test('an unbound session stays unattributed', () => {
  const [resolved] = reconcile(parseOtlpLogs(batch(log())).facts, []).records
  const record = buildRecord(resolved!, null, now)
  assert.equal(record.envelope, null)
  assert.equal(record.coverage.state, 'unattributed')
  assert.equal(record.received, now.toISOString())
})

test('JSONL retains both sides of a cross-source conflict and replay adds no lines', (t) => {
  const path = spendPath(t)
  const appendMismatch = () => {
    const { facts } = parseOtlpLogs(batch(log()))
    const rows = transcript(assistant({ output_tokens: 90 }))
    const writer = jsonlWriter(path)
    for (const item of reconcile(facts, rows).records) writer.append(buildRecord(item, envelope, now))
  }
  appendMismatch()
  const first = readFileSync(path, 'utf8')
  const lines = first.trimEnd().split('\n')
  assert.equal(lines.length, 2, 'one persisted line per conflicting source')
  const records = lines.map((line) => JSON.parse(line))
  assert.deepEqual(records.map((record) => [record.source, record.tokens.output, record.coverage.state]), [
    ['claude_local_request', 91, 'conflict'], ['claude_local_transcript', 90, 'conflict'],
  ])
  appendMismatch()
  assert.equal(readFileSync(path, 'utf8'), first)
})

test('JSONL counts undisputed spend once before and after reopening', (t) => {
  const path = spendPath(t)
  const [resolved] = reconcile(parseOtlpLogs(batch(log())).facts, []).records
  const writer = jsonlWriter(path)
  writer.append(buildRecord(resolved!, envelope, now))
  const first = readFileSync(path, 'utf8')
  assert.equal(JSON.parse(first).tokens.output, 91)
  writer.append(buildRecord(resolved!, envelope, now))
  assert.equal(readFileSync(path, 'utf8'), first, 'replay with the same writer')
  jsonlWriter(path).append(buildRecord(resolved!, envelope, now))
  assert.equal(readFileSync(path, 'utf8'), first, 'replay after reopening')
})

const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n')
const outputs = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).tokens.output)
function reported(output = 91, requestId = 'req-1') {
  const { facts } = parseOtlpLogs(batch(log({ request_id: { stringValue: requestId }, output_tokens: { intValue: output } })))
  return buildRecord(reconcile(facts, []).records[0]!, envelope, now)
}

test('transcript binds rows to its native session', () => {
  const { facts, foreign, unscoped } = parseTranscript(jsonl(
    { ...assistant({ output_tokens: 1 }, 'foreign-request'), sessionId: 'other-session' },
    { ...assistant({ output_tokens: 2 }), sessionId: session },
    assistant({ output_tokens: 3 }, 'other-request'),
  ), session)
  assert.deepEqual(facts.map((fact) => fact.tokens.output), [2])
  assert.equal(foreign, 1)
  assert.equal(unscoped, 1)
})

test('identifiers cannot carry paths, emails, or malformed values into spend', (t) => {
  const path = spendPath(t)
  const writer = jsonlWriter(path)
  const bad = ['/private/fixture', 'fixture@example.test', 'a'.repeat(129), 'valid\n']
  for (const value of bad) {
    const attr = { stringValue: value }
    const { facts, rejected } = parseOtlpLogs(batch(log({ 'session.id': attr }),
      log({ request_id: attr, model: attr }), log({ 'message.id': attr, response_id: attr })))
    const row = assistant({ output_tokens: 5 }, value)
    const rows = transcript({ ...row, message: { ...row.message, model: value } }, assistant(undefined, 'req-2', value))
    for (const item of reconcile(facts, rows).records) writer.append(buildRecord(item, envelope, now))
    const escaped = JSON.stringify(value).slice(1, -1)
    assert.ok(!JSON.stringify([...facts, ...rows]).includes(escaped), 'identifier leaked into facts')
    assert.ok(!readFileSync(path, 'utf8').includes(escaped), 'identifier leaked into records')
    assert.equal(rejected, 1)
    assert.deepEqual([...facts, ...rows].map(({ requestId, responseId, model }) => [requestId, responseId, model]), [
      [null, 'msg-1', null], ['req-1', null, 'claude-example'], [null, 'msg-1', null], ['req-2', null, 'claude-example'],
    ])
  }
})

test('both parsers count anonymous usage instead of booking it as an identified request', () => {
  const { facts, rejected } = parseOtlpLogs(batch(log({ request_id: {}, 'message.id': {} })))
  assert.equal(rejected, 1)
  assert.deepEqual(facts.map((fact) => [fact.requestId, fact.responseId, fact.gap]), [[null, null, 1]])
  const rows = parseTranscript(jsonl(assistant({ output_tokens: 4 }, '', '')), session)
  assert.equal(rows.facts.length, 0, 'anonymous transcript usage')
  assert.equal(rows.noId, 1)
})

test('same-request responses reconcile separately and both reach disk', (t) => {
  const { facts } = parseOtlpLogs(batch(log(), log({ 'message.id': { stringValue: 'msg-2' }, output_tokens: { intValue: 7 } })))
  const rows = transcript(assistant({ output_tokens: 7 }, 'req-1', 'msg-2'), assistant({ output_tokens: 91 }))
  const result = reconcile(facts, rows)
  assert.deepEqual(result.counters, { matched: 2, mismatched: 0, transcriptOnly: 0, otlpOnly: 0 })
  const path = spendPath(t)
  const writer = jsonlWriter(path)
  for (const item of result.records) writer.append(buildRecord(item, envelope, now))
  assert.deepEqual(outputs(path), [91, 7])
  for (const missing of ['request_id', 'message.id']) {
    const partial = parseOtlpLogs(batch(log({ [missing]: {} }))).facts
    assert.equal(reconcile(partial, rows.slice(1)).counters.matched, 1)
  }
})

test('evidence references round-trip a session without exposing it as a path', () => {
  const native = 'local%2Fsession/child%'
  const { facts } = parseTranscript(jsonl(assistant()), native)
  const ref = buildRecord(reconcile([], facts).records[0]!, null, now).evidence_ref
  assert.ok(!ref.includes(native), 'raw session leaked into the reference')
  assert.equal(ref.split('/').length, 3)
  assert.equal(capture.sessionFromEvidenceRef(ref), native)
  assert.equal(capture.sessionFromEvidenceRef('/private/fixture'), null)
  assert.equal(capture.sessionFromEvidenceRef('claude/%ZZ/request'), null)
})

test('open writers see records appended by another writer', (t) => {
  const path = spendPath(t)
  const first = jsonlWriter(path)
  const second = jsonlWriter(path)
  first.append(reported())
  second.append(reported())
  assert.deepEqual(outputs(path), [91])
})

test('JSONL skips a torn tail but rejects a malformed middle line', (t) => {
  const path = spendPath(t)
  const line = JSON.stringify(reported())
  writeFileSync(path, `${line}\n{"unfinished":`)
  jsonlWriter(path).append(reported(8, 'another-request'))
  assert.equal(JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!).tokens.output, 8)
  writeFileSync(path, `${line}\n{"unfinished":\n${line}\n`)
  assert.throws(() => jsonlWriter(path), SyntaxError)
})

test('JSONL starts a new line after an append throws', (t) => {
  const dir = spendPath(t)
  mkdirSync(dir)
  const path = join(dir, 'spend.jsonl')
  const writer = jsonlWriter(path)
  writer.append(reported())
  const other = reported(8, 'another-request')
  renameSync(dir, `${dir}.saved`)
  assert.throws(() => writer.append(other), { code: 'ENOENT' })
  renameSync(`${dir}.saved`, dir)
  writer.append(other)
  assert.ok(readFileSync(path, 'utf8').includes('\n\n'), 'retry starts on a fresh line')
  assert.deepEqual(outputs(path), [91, 8])
})

test('JSONL distinguishes changed tokens from replays and exposes the original ID', (t) => {
  const path = spendPath(t)
  const original = reported()
  const writer = jsonlWriter(path)
  jsonlWriter(path).append(original)
  for (const key of Object.keys(original.tokens) as (keyof typeof original.tokens)[]) {
    const changed = { ...reported(), tokens: { ...original.tokens, [key]: 1 } }
    assert.equal(writer.append(changed), 'differs', `change to ${key}`)
  }
  const replay = reported()
  assert.equal(writer.append(replay), 'duplicate')
  assert.equal(writer.existing(replay.dedupe_key)?.record_id, original.record_id)
  const other = reported(8, 'another-request')
  assert.equal(writer.existing(other.dedupe_key), null)
  assert.equal(writer.append(other), 'written')
  assert.deepEqual(outputs(path), [91, 8])
})

test('distinct same-source conflicts persist, but their replays do not', (t) => {
  const path = spendPath(t)
  const writer = jsonlWriter(path)
  const { facts } = parseOtlpLogs(batch(log(), log({ output_tokens: { intValue: 90 } })))
  for (let i = 0; i < 2; i++) {
    for (const item of reconcile(facts, []).records) writer.append(buildRecord(item, envelope, now))
  }
  assert.deepEqual(outputs(path), [91, 90])
})

test('a mixed transcript does not book a row with no sessionId onto the bound session', () => {
  const { facts, foreign, unscoped } = parseTranscript(jsonl(
    { ...assistant({ output_tokens: 1 }, 'foreign-request'), sessionId: 'other-session' },
    { ...assistant({ output_tokens: 2 }), sessionId: session },
    assistant({ output_tokens: 3 }, 'other-request'),
  ), session)
  assert.deepEqual(facts.map((fact) => [fact.nativeSession, fact.tokens.output]), [[session, 2]])
  assert.equal(foreign, 1)
  assert.equal(unscoped, 1)
})

test('a request with neither id is stored as a gap so check cannot match', (t) => {
  const path = spendPath(t)
  const anonymous = { request_id: {}, 'message.id': {}, response_id: {} }
  const { facts, rejected } = parseOtlpLogs(batch(log(), log(anonymous), log({
    ...anonymous, output_tokens: { intValue: 4 },
  })))
  assert.equal(rejected, 2)
  const rows = transcript(assistant({ output_tokens: 91 }))
  const { records, counters } = reconcile(facts, rows)
  const writer = jsonlWriter(path)
  for (const item of records) writer.append(buildRecord(item, envelope, now))
  const stored = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
  const gaps = stored.filter((record) => String(record.evidence_ref).includes('/gap:'))
  assert.equal(gaps.length, 2, 'each unidentified request has its own durable record')
  assert.deepEqual(gaps.map((record) => record.coverage.state), ['partial', 'partial'])
  assert.equal(counters.matched, 1)
  assert.ok(counters.otlpOnly >= 1)
  const verdict = counters.mismatched || counters.transcriptOnly || counters.otlpOnly ? 'differs' : 'match'
  assert.equal(verdict, 'differs')
  const gap = records.find((item) => item.fact.gap === 1)
  assert.equal(writer.append(buildRecord(gap!, envelope, now)), 'duplicate')
  assert.equal(readFileSync(path, 'utf8').trimEnd().split('\n').length, stored.length)
})

test('a later conflicting report revises the current head', (t) => {
  const path = spendPath(t)
  const writer = jsonlWriter(path)
  const original = reported()
  writer.append(original)
  const successors = [90, 89, 88].map((value) => capture.conflictSuccessor(original, reported(value), 'reviewer'))
  for (const record of successors) assert.equal(writer.append(record), 'written')
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((record) => record.tokens.output), [91, 90, 89, 88])
  assert.equal(lines[1].revises, original.record_id)
  assert.equal(lines[2].revises, lines[1].record_id)
  assert.equal(lines[3].revises, lines[2].record_id)
  const revised = new Set(lines.map((record) => record.revises).filter((id) => id !== null))
  const heads = lines.filter((record) => !revised.has(record.record_id))
  assert.deepEqual(heads.map((record) => record.record_id), [lines[3].record_id])
})

test('recovery after a torn append restarts without a malformed middle line', (t) => {
  const path = spendPath(t)
  const line = JSON.stringify(reported())
  writeFileSync(path, `${line}\n{"unfinished":`)
  jsonlWriter(path).append(reported(8, 'another-request'))
  const reopened = jsonlWriter(path)
  assert.equal(reopened.append(reported(4, 'third-request')), 'written')
  assert.deepEqual(outputs(path), [91, 8, 4])
  assert.equal(readFileSync(path, 'utf8').includes('unfinished'), false)
})

test('conflict successors preserve distinct changed reports and link to the original', (t) => {
  const path = spendPath(t)
  const writer = jsonlWriter(path)
  const original = reported()
  writer.append(original)
  for (const value of [90, 89, 90]) writer.append(capture.conflictSuccessor(original, reported(value), 'reviewer'))
  const [transcriptReport] = reconcile([], transcript(assistant({ input_tokens: 240, output_tokens: 90, cache_read_input_tokens: 0 }))).records
  writer.append(capture.conflictSuccessor(original, buildRecord(transcriptReport!, envelope, now), 'reviewer'))
  assert.deepEqual(outputs(path), [91, 90, 89, 90])
  const successors = readFileSync(path, 'utf8').trimEnd().split('\n').slice(1).map((line) => JSON.parse(line))
  assert.equal(successors[0].revises, original.record_id)
  assert.equal(successors[1].revises, successors[0].record_id)
  assert.equal(successors[2].revises, successors[1].record_id)
  for (const record of successors) {
    assert.deepEqual([record.coverage.state, record.actor, record.reason],
      ['conflict', 'reviewer', 'conflicting report'])
  }
})
