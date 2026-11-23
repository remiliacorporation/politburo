import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createShadow, type CasePacket, type DecisionRecord } from '../src/secretary/index.ts'

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'secretary', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 180_000,
  })
  if (result.error) throw result.error
  return result
}

function temp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-secretary-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const lines = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const now = '2026-01-01T00:01:00.000Z'
const message = { id: 'note-17', class: 'spawner.decide', urgency: 'p1', from: 'someone',
  ref: 'task-17', summary: 'a decision', at: now }
const content = `${message.summary}\n\`\`\`yaml\n${JSON.stringify(message)}\n\`\`\`\n`

for (const seed of [1, 7]) {
  test(`replay seed ${seed} agrees with the recorded decisions, forwards, and digest windows without leaks`, (t) => {
    const result = run('replay', '--seed', String(seed), '--dir', temp(t))
    assert.equal(result.status, 0, result.stderr || result.stdout.slice(0, 500))
    assert.equal(result.stdout, 'zero diff\n')
  })
}

const from = '2026-01-01T00:00:00.000Z', to = '2026-01-01T00:30:00.000Z'
const inputs = [message, { ...message, id: 'escalation', ref: 'task-18', class: 'core.escalate', urgency: 'p2' },
  { ...message, id: 'notice', ref: 'task-19', class: 'policy', urgency: 'p2' }]
const decisions = inputs.map(({ id, urgency }) => ({ type: 'message', id, outcome: urgency === 'p1' ? 'p1_batch' : 'digest' }))
const { id } = message
const items = (...ids: string[]) => ids.map((id) => ({ id }))
const digest = { from, to, type: 'digest', items: items('note-17', 'escalation', 'notice'),
  counts: { p0: 0, p1: 1, p2: 2, p3: 0 }, act_on: ['note-17', 'escalation'] }
const journalDigest = { items: digest.items, counts: digest.counts, act_on: digest.act_on }
const forwardAt = '2026-01-01T00:11:00.000Z'
const forward = { type: 'forward', at: forwardAt, lane: 'p1_batch', ids: [id] }
const window = `${from}/${to}`

test('ref-less deliveries survive a durable restart without leaking into the journal, packet or diff', async (t) => {
  const dir = temp(t), tag = 'test-repo', mailDir = join(dir, 'mail'), outDir = join(dir, 'shadow')
  const inbox = join(mailDir, tag, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const canary = 'ghp_SYNTHETIC_REFLESS_CANARY_NOT_A_SECRET'
  const annotations = { needs: canary, reply_to: 'parent', thread: 'thread-1', status: 'open',
    review_by: 'core', default_if_unanswered: 'hold', answered_at: now }
  function put(id: string, receivedAt: string) {
    const path = join(inbox, `${id}.md`)
    const fields = { ...message, id, ref: undefined, ...annotations }
    writeFileSync(path, `Summary\n\n\`\`\`yaml\n${JSON.stringify(fields)}\n\`\`\`\n`)
    utimesSync(path, new Date(receivedAt), new Date(receivedAt))
  }
  const packets: CasePacket[] = []
  const opts = { mailDir, outDir, tag, waker: { async wake(packet: CasePacket) {
    packets.push(packet)
    return { delivered: false, detail: 'test' }
  } } }
  const first = await createShadow(opts)
  try {
    put('first', now)
    await first.tick(Date.parse(now))
  } finally { await first.close() }
  rmSync(join(inbox, 'first.md')) // Only the journal can restore the first pending delivery.
  const restarted = await createShadow(opts)
  try {
    put('second', '2026-01-01T00:02:00.000Z')
    await restarted.tick(Date.parse(to))
  } finally { await restarted.close() }

  const shadow = join(outDir, tag, 'decisions.jsonl'), live = join(dir, 'live.jsonl')
  const journal = readFileSync(shadow, 'utf8')
  const log: DecisionRecord[] = journal.trim().split('\n').map((line) => JSON.parse(line))
  const ids = ['first', 'second']
  assert.deepEqual(packets.map((p) => p.items.map((item) => item.id)), [ids])
  assert.deepEqual(log.flatMap((row) => row.kind === 'digest' ? [row.items] : [])
    .map((members) => members.map((item) => 'id' in item ? item.id : undefined)), [ids])

  // Omit one expected digest member so diff renders the actual membership rather than just 'zero diff'.
  writeFileSync(live, lines('secretary-live@1', ...ids.map((id) => ({ type: 'message', id, outcome: 'p1_batch' })),
    { type: 'forward', lane: 'p1_batch', at: to, ids },
    { ...digest, counts: { p0: 0, p1: 2, p2: 0, p3: 0 }, act_on: ids, items: items('first') }))
  const result = run('diff', '--shadow', shadow, '--live', live, '--json')
  assert.equal(result.status, 1, result.stderr)
  const diff = JSON.parse(result.stdout)
  assert.deepEqual(diff.differences.map((row: { id: string; got: { items: object[] } }) => [row.id, row.got.items]),
    [[window, items(...ids)]])
  for (const [label, output] of [
    ['journal', journal], ['packet', JSON.stringify(packets)], ['diff', result.stdout],
  ] as const) {
    assert.ok(!output.includes(canary), `${label} leaks the annotation credential`)
    for (const key of ['ref', ...Object.keys(annotations)]) {
      assert.doesNotMatch(output, new RegExp(`"${key}"\\s*:`), `${label} leaks ${key}`)
    }
  }
})

function parityFixture(t: TestContext, expected: object[]) {
  const dir = temp(t), behaviour = join(dir, 'recorded')
  mkdirSync(behaviour)
  const files = inputs.map((header) => ({ name: `${header.id}.md`, mtimeMs: Date.parse(now),
    content: `${header.summary}\n\`\`\`yaml\n${JSON.stringify(header)}\n\`\`\`\n` }))
  writeFileSync(join(behaviour, 'day.json'), JSON.stringify({ name: 'recorded window', now: to,
    files, expected: [...expected, { ...forward, at: to }] }))
  return run('parity', '--dir', dir)
}

test('parity passes a matching recorded digest and decisions', (t) => {
  const result = parityFixture(t, [...decisions, digest])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stdout, '1 cases, 0 failed\n')
})

for (const [mismatch, expected, difference] of [
  ['lane', [{ ...decisions[0], outcome: 'digest' }, ...decisions.slice(1), digest],
    { id, expected: ['digest'], got: ['p1_batch'] }],
  ['digest membership', [...decisions, { ...digest, items: items('note-17', 'escalation', 'substitute') }],
    { id: window, expected: { ...journalDigest, items: items('note-17', 'escalation', 'substitute') }, got: journalDigest }],
  ['act_on order', [...decisions, { ...digest, act_on: ['escalation', 'note-17'] }],
    { id: window, expected: { ...journalDigest, act_on: ['escalation', 'note-17'] }, got: journalDigest }],
  ['message missing from live', [...decisions.slice(1), digest], { id, expected: null, got: ['p1_batch'] }],
  ['message missing from shadow', [...decisions, digest, { type: 'message', id: 'ghost', outcome: 'digest' }],
    { id: 'ghost', expected: ['digest'], got: null }],
] as const) {
  test(`diff reports ${mismatch}`, (t) => {
    const rows = [...decisions.map(({ id, outcome }) => ({ kind: 'accept', id, lane: outcome })),
      { kind: 'lane', lane: forward.lane, at: Date.parse(forwardAt), items: items(id) },
      { kind: 'wake', lane: forward.lane, at: Date.parse(forwardAt), ids: [id] },
      { kind: 'digest', window: { from, to }, ...journalDigest }]
    const result = diffFixture(t, rows, [...expected, forward], '--json')
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), { result: 'diff', differences: [difference] })
  })

  test(`parity fails for ${mismatch}`, (t) => {
    const result = parityFixture(t, [...expected])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '1 cases, 1 failed\n')
  })
}

function diffFixture(t: TestContext, rows: object[], expected: object[], ...flags: string[]) {
  const dir = temp(t), shadow = join(dir, 'decisions.jsonl'), live = join(dir, 'live.jsonl')
  writeFileSync(shadow, lines(...rows.map((row, key) => ({ v: 1, key: String(key), ...row }))))
  writeFileSync(live, lines('secretary-live@1', ...expected))
  return run('diff', '--shadow', shadow, '--live', live, ...flags)
}

test('diff redacts IDs and nested strings in text and JSON without merging comparison keys', (t) => {
  const canaries = ['ghp_SYNTHETIC_LIVE', 'ghp_SYNTHETIC_SHADOW']
  const [liveId, shadowId] = canaries
  const rows = [{ kind: 'accept', id: shadowId, lane: 'digest' },
    { kind: 'digest', window: { from, to }, items: [{ id: shadowId }], counts: digest.counts, act_on: [shadowId] }]
  const expected = [{ type: 'message', id: liveId, outcome: 'digest' },
    { ...digest, items: [{ id: liveId }], act_on: [liveId] }]
  const outputs = [[], ['--json']].map((flags) => diffFixture(t, rows, expected, ...flags))
  assert.deepEqual(outputs.map(({ status, stdout }) => [status, canaries.some((token) => stdout.includes(token))]),
    [[1, false], [1, false]])
  assert.equal(outputs[0]!.stdout.trim().split('\n').length, 3)
  assert.equal(JSON.parse(outputs[1]!.stdout).differences.length, 3)
})

test('diff detects missing p3 digest summaries even when counts match', (t) => {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 2 }
  const row = { kind: 'digest', window: { from, to }, counts, act_on: [], items: [
    { summary: 'one [redacted]' }, { summary: 'two' },
  ] }
  const expected = [{ from, to, type: 'digest', counts, act_on: [], items: [
    { summary: 'one ghp_SYNTHETIC_SUMMARY' }, { summary: 'two' },
  ] }]
  for (const [items, status] of [[row.items, 0], [row.items.slice(0, 1), 1], [[...row.items].reverse(), 1]] as const) {
    const result = diffFixture(t, [{ ...row, items }], expected, '--json')
    assert.equal(result.status, status, result.stderr || result.stdout)
    if (status) assert.equal(JSON.parse(result.stdout).differences[0].id, window)
  }
})

test('diff reports swapped digest items of the same urgency', (t) => {
  const rows = [{ kind: 'digest', window: { from, to }, ...journalDigest,
    items: items('note-17', 'notice', 'escalation') }]
  const result = diffFixture(t, rows, [digest], '--json')
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.equal(JSON.parse(result.stdout).differences[0].id, window)
})

test('diff checks each expected forward against both journal records, including empty expectations', (t) => {
  const lane = { kind: 'lane', lane: 'p1_batch', at: Date.parse(now), wakeId: 'receipt', items: [{ id }] }
  const wake = { kind: 'wake', lane: 'p1_batch', at: Date.parse(now), wakeId: 'receipt', ids: [id], delivered: false }
  const accepted = { kind: 'accept', id, lane: 'p1_batch' }
  const expected = { type: 'message', id, outcome: 'p1_batch' }
  const forward = { type: 'forward', at: now, lane: 'p1_batch', ids: [id] }
  const cases = [
    { name: 'match', records: [lane, wake], forwards: [forward], want: 'zero diff' },
    { name: 'missing lane', records: [wake], forwards: [forward], want: 'diff' },
    { name: 'missing wake', records: [lane], forwards: [forward], want: 'diff' },
    { name: 'wrong lane', records: [{ ...lane, lane: 'p0_now' }, wake], forwards: [forward], want: 'diff' },
    { name: 'wrong lane member', records: [{ ...lane, items: [{ id: 'other' }] }, wake], forwards: [forward], want: 'diff' },
    { name: 'wrong wake lane', records: [lane, { ...wake, lane: 'p0_now' }], forwards: [forward], want: 'diff' },
    { name: 'wrong wake member', records: [lane, { ...wake, ids: ['other'] }], forwards: [forward], want: 'diff' },
    { name: 'unexpected wake', records: [wake], forwards: [], want: 'diff' },
    { name: 'unexpected empty wake', records: [{ ...wake, ids: [] }], forwards: [], want: 'diff' },
  ]
  assert.deepEqual(cases.map(({ name, records, forwards }) => {
    const result = diffFixture(t, [accepted, ...records], [expected, ...forwards], '--json')
    return [name, result.status, result.stdout ? JSON.parse(result.stdout).result : result.stderr]
  }), cases.map(({ name, want }) => [name, want === 'diff' ? 1 : 0, want]))
})

test('diff compares rejection reasons containing spaces', (t) => {
  const reason = 'unknown_field:unknown key'
  const row = { kind: 'reject', id, reason }
  const expected = { type: 'message', id, outcome: 'reject', reason }
  const match = diffFixture(t, [row], [expected])
  assert.equal(match.status, 0, match.stderr || match.stdout)
  assert.equal(match.stdout, 'zero diff\n')
  const mismatch = diffFixture(t, [row], [{ ...expected, reason: 'unknown_field:different key' }], '--json')
  assert.equal(mismatch.status, 1)
  assert.equal(JSON.parse(mismatch.stdout).differences[0].id, id)
})

test('diff reports missing, extra, misaddressed and wrong-reason reject notices', (t) => {
  const expected = { type: 'notice', file: 'bad.md', to: 'sprite', reason: 'unknown_field:unknown key' }
  const { type: _type, ...fields } = expected
  const notice = { kind: 'notice', ...fields, file: join(temp(t), 'bad.md') }
  for (const [name, rows, live, status] of [
    ['match', [notice], [expected], 0],
    ['missing', [], [expected], 1],
    ['extra', [notice], [], 1],
    ['wrong sender', [{ ...notice, to: 'other sprite' }], [expected], 1],
    ['wrong reason', [{ ...notice, reason: 'bad_class' }], [expected], 1],
    ['wrong file', [{ ...notice, file: 'other.md' }], [expected], 1],
  ] as const) {
    const result = diffFixture(t, [...rows], [...live], '--json')
    assert.equal(result.status, status, `${name}: ${result.stderr || result.stdout}`)
    assert.equal(JSON.parse(result.stdout).result, status ? 'diff' : 'zero diff', name)
  }
})

test('diff reports missing and extra occurrences of the same reject notice tuple', (t) => {
  const file = 'bad.md', reason = 'bad_class', to = 'sprite'
  const target = { to, reason }
  const notice = { type: 'notice', file, ...target }
  const reject = { type: 'message', id: file, outcome: 'reject', reason }
  const rejects = [1, 2].map((receivedAt) => ({ kind: 'reject', file, reason, receivedAt }))
  const notices = [1, 2, 3].map((n) => ({ kind: 'notice', key: `notice-${n}`, file, ...target }))
  const actual = [2, 1, 3].map((count) => {
    const result = diffFixture(t, [...rejects, ...notices.slice(0, count)], [reject, reject, notice, notice], '--json')
    assert.equal(result.stderr, '')
    return [result.status, JSON.parse(result.stdout)]
  })
  assert.deepEqual(actual, [
    [0, { result: 'zero diff', differences: [] }],
    ...[1, 3].map((count) => [1, { result: 'diff', differences: [
      { id: `notice ${file}`, expected: [target, target], got: Array(count).fill(target) },
    ] }]),
  ])
})

function mailbox(dir: string) {
  const mail = join(dir, 'mail'), inbox = join(mail, 'pb', 'inbox')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'note.md'), content)
  return mail
}

function snapshot(dir: string) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name)
    return [path, entry.isDirectory() ? null : readFileSync(path)]
  }).sort(([a], [b]) => String(a).localeCompare(String(b)))
}

test('shadow --once appends without changing the mail tree', (t) => {
  const dir = temp(t), mail = mailbox(dir), before = snapshot(mail), out = join(dir, 'out')
  const args = ['shadow', '--once', '--mail', mail, '--tag', 'pb', '--out', out]
  const result = run(...args)
  assert.equal(result.status, 0, result.stderr)
  const log = join(out, 'pb', 'decisions.jsonl'), first = readFileSync(log, 'utf8')
  assert.ok(first.trim().split('\n').some((line) => {
    const record = JSON.parse(line)
    return record.kind === 'accept' && record.id === message.id
  }))
  const repeated = run(...args)
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.equal(readFileSync(log, 'utf8'), first)
  assert.deepEqual(snapshot(mail), before)
})

test('shadow refuses nested output before it writes into mail', (t) => {
  const mail = mailbox(temp(t)), before = snapshot(mail)
  const result = run('shadow', '--once', '--mail', mail, '--tag', 'pb', '--out', join(mail, 'nested'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^error: [^\n]+\n$/)
  assert.deepEqual(snapshot(mail), before)
})

test('parity does not fail when the fixture directory is absent or empty', (t) => {
  const dir = temp(t)
  for (const path of [join(dir, 'absent'), dir]) {
    const result = run('parity', '--dir', path)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '0 cases\n')
  }
})

test('an unknown secretary subcommand is misuse rather than a runtime error', () => {
  const result = run('not-a-command')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /^error: unknown secretary command /)
})

test('a missing required flag is misuse rather than a runtime error', () => {
  const result = run('diff', '--shadow', 'unused.jsonl')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /^error: missing --live\n$/)
})

test('scorecard does not count wakes outside the requested range or turn unknown spend into zero', (t) => {
  const out = temp(t), tag = 'pb', dir = join(out, tag)
  mkdirSync(dir)
  const since = '2026-01-02', until = '2026-01-03'
  writeFileSync(join(dir, 'decisions.jsonl'), lines(...[Date.parse(since) - 1, Date.parse(since), Date.parse(until) + 1]
    .map((at) => ({ kind: 'wake', at, delivered: false, shadow: true }))))
  const result = run('scorecard', '--out', out, '--tag', tag, '--since', since, '--until', until)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^wakes_per_day +1$/m)
  assert.match(result.stdout, /^tokens_per_merged_pr +unknown$/m)
})
