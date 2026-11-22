import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

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
const digest = { from, to, type: 'digest', ids: ['escalation', 'note-17', 'notice'],
  counts: { p0: 0, p1: 1, p2: 2, p3: 0 }, act_on: ['note-17', 'escalation'] }
const journalDigest = { ids: digest.ids, counts: digest.counts, act_on: digest.act_on }
const window = `${from}/${to}`

function parityFixture(t: TestContext, expected: object[]) {
  const dir = temp(t), behaviour = join(dir, 'recorded')
  mkdirSync(behaviour)
  const files = inputs.map((header) => ({ name: `${header.id}.md`, mtimeMs: Date.parse(now),
    content: `${header.summary}\n\`\`\`yaml\n${JSON.stringify(header)}\n\`\`\`\n` }))
  writeFileSync(join(behaviour, 'day.json'), JSON.stringify({ name: 'recorded window', now: to, files, expected }))
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
  ['digest membership', [...decisions, { ...digest, ids: ['escalation', 'note-17', 'substitute'] }],
    { id: window, expected: { ...journalDigest, ids: ['escalation', 'note-17', 'substitute'] }, got: journalDigest }],
  ['act_on order', [...decisions, { ...digest, act_on: ['escalation', 'note-17'] }],
    { id: window, expected: { ...journalDigest, act_on: ['escalation', 'note-17'] }, got: journalDigest }],
  ['message missing from live', [...decisions.slice(1), digest], { id, expected: null, got: ['p1_batch'] }],
  ['message missing from shadow', [...decisions, digest, { type: 'message', id: 'ghost', outcome: 'digest' }],
    { id: 'ghost', expected: ['digest'], got: null }],
] as const) {
  test(`diff reports ${mismatch}`, (t) => {
    const dir = temp(t), shadow = join(dir, 'decisions.jsonl'), live = join(dir, 'live.jsonl')
    const rows = [...decisions.map(({ id, outcome }) => ({ kind: 'accept', id, lane: outcome })),
      { kind: 'digest', window: { from, to }, items: digest.ids.map((id) => ({ id })), counts: digest.counts, act_on: digest.act_on }]
    writeFileSync(shadow, lines(...rows.map((row, key) => ({ v: 1, key: String(key), ...row }))))
    writeFileSync(live, lines('secretary-live@1', ...expected))
    const result = run('diff', '--shadow', shadow, '--live', live, '--json')
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), { result: 'diff', differences: [difference] })
  })

  test(`parity fails for ${mismatch}`, (t) => {
    const result = parityFixture(t, [...expected])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '1 cases, 1 failed\n')
  })
}

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
