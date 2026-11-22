import { spawnSync as spawnSwarm } from 'node:child_process'
import { test as routingTest } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { run } from '../src/digest/cli.ts'
import { exceptionDigest, postDigest, type MessageHeader } from '../src/digest/digest.ts'
import { memoryMail } from '../src/digest/mail-port.ts'
import { policyNotices } from '../src/digest/notices.ts'

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-digest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// memoryMail() fakes the mail transport; the clock is fixed unless advanced for a retry.
const now = '2026-11-20T21:30:00Z'
const clock = () => new Date(now)
const mailboxes = { dispatch: 'shared-inbox', mail: 'shared-inbox', watch: 'watch-inbox' }
const before = 'fixture-model-citrine'
const after = 'fixture-model-ultramarine'
const previous = { tiers: { models: { core: before, adviser: before } } }
const next = { tiers: { models: { core: after, adviser: after } } }

test('one notice per mailbox per version: repeats or crash retries duplicate mail, or a new version is suppressed', async (t) => {
  const mail = memoryMail()
  const sentPath = join(tempDir(t), 'sent.jsonl')
  const id = 'policy:shared-inbox:v41'
  const input = { version: 41, previous, next, mailboxes, mail, sentPath, now: clock }

  assert.deepEqual(await policyNotices(input), { sent: [id], skipped: [] })
  const landed = mail.messages
  assert.deepEqual(landed.map((message) => message.mailbox), ['shared-inbox'])
  assert.deepEqual(await policyNotices(input), { sent: [], skipped: [id] })
  assert.deepEqual(mail.messages, landed)

  // Lose the sent record as if delivery landed just before a crash.
  rmSync(sentPath)
  const restarted = { ...input, now: () => new Date('2026-11-20T21:31:00Z') }
  assert.deepEqual(await policyNotices(restarted), { sent: [], skipped: [id] })
  assert.deepEqual(mail.messages, landed)
  assert.deepEqual(await policyNotices({ ...restarted, version: 42 }), {
    sent: ['policy:shared-inbox:v42'], skipped: [],
  })
  assert.deepEqual(mail.messages.map((message) => message.id), [id, 'policy:shared-inbox:v42'])
})

test('unknown config path: a mailbox misses the fallback notice', async () => {
  const mail = memoryMail()
  await policyNotices({ version: 41, previous: {}, next: { future_field: true }, mailboxes, mail })
  assert.deepEqual(mail.messages.map((message) => message.mailbox).sort(), ['shared-inbox', 'watch-inbox'])
})

test('policy notice payload: text or block omits rollout details or leaks config values', async () => {
  const mail = memoryMail()
  await policyNotices({ version: 413, previous, next, mailboxes, mail })
  const [notice] = mail.messages
  assert.ok(notice?.block, 'policy notice must include a structured block')
  for (const payload of [notice.text, JSON.stringify(notice.block)]) {
    assert.match(payload, /\b413\b|\bv413\b/)
    assert.match(payload, /tiers\.models\.core/)
    assert.match(payload, /tiers\.models\.adviser/)
    assert.ok(!payload.includes(before) && !payload.includes(after), 'notice leaked a config value')
  }
})

const window = { from: '2026-11-20T21:00:00Z', to: now }
const args = { repo: 'acme/example', window, now }
function header(id: string, urgency: MessageHeader['urgency'], extra: Partial<MessageHeader> = {}): MessageHeader {
  return { id, urgency, class: 'sec.retry', state: 'open', createdAt: window.from, summary: id, ...extra }
}

test('digest window and counts: ineligible mail is counted or p3 gets a row', () => {
  const digest = exceptionDigest({ ...args, headers: [
    header('routine', 'p2'), header('log', 'p3'), header('handled', 'p1', { state: 'handled' }),
    header('expired', 'p2', { expires: '2026-11-20T21:25:00Z' }),
    header('before', 'p0', { createdAt: '2026-11-20T20:59:59Z' }),
    header('next-window', 'p0', { createdAt: window.to }),
  ] })
  assert.deepEqual(digest.items.map((item) => item.id), ['routine'])
  assert.deepEqual(digest.counts, { p0: 0, p1: 0, p2: 1, p3: 1 })
})

test('actionable digest headers: p1 jumps ahead of p0 or a body is exposed', () => {
  const p1 = { ...header('decision', 'p1'), body: 'fixture message body' }
  const p0 = { ...header('outage', 'p0', { createdAt: '2026-11-20T21:20:00Z' }), body: p1.body }
  const digest = exceptionDigest({ ...args, headers: [p1, p0] })
  assert.deepEqual(digest.act_on, ['outage', 'decision'])
  assert.deepEqual(digest.items.map((item) => item.id), digest.act_on)
  assert.doesNotMatch(JSON.stringify(digest), /"body"\s*:|fixture message body/)
})

test('overdue policy acknowledgment: an outstanding rollout disappears or acked and fresh notices are escalated', () => {
  const older = { version: 41, noticeAt: '2026-11-20T20:29:00Z' }
  const digest = exceptionDigest({ ...args, headers: [], acks: [
    { ...older, mailbox: 'waiting', acked: false },
    { ...older, mailbox: 'done', acked: true },
    { ...older, mailbox: 'fresh', acked: false, noticeAt: '2026-11-20T20:31:00Z' },
  ] })
  assert.deepEqual(digest.items.map(({ id, class: kind, urgency }) => [id, kind, urgency]), [
    ['policy:waiting:v41', 'policy', 'p1'],
  ])
  assert.deepEqual(digest.act_on, ['policy:waiting:v41'])
})

test('one digest per window: recomputing a batch duplicates mail or blocks the next window', async () => {
  const mail = memoryMail()
  const target = { mailbox: 'shared-inbox', mail }
  const headers = [header('outage', 'p0')]
  const digest = exceptionDigest({ ...args, headers })
  assert.equal(digest.batch, 'ex-2026-11-20T21:30Z')
  assert.equal(await postDigest({ ...target, digest }), 'posted')
  const replay = exceptionDigest({ ...args, headers, now: '2026-11-20T21:31:00Z' })
  assert.equal(await postDigest({ ...target, digest: replay }), 'existing')
  assert.deepEqual(mail.messages.map(({ block }) => block), [{ schema: 'swarm-digest@1', data: digest }])

  const later = exceptionDigest({ ...args, window: { ...window, to: '2026-11-20T22:00:00Z' }, headers })
  assert.equal(await postDigest({ ...target, digest: later }), 'posted')
  assert.equal(mail.messages.length, 2)
})

test('empty digest: an inbox receives a message with no exceptions', async () => {
  const mail = memoryMail()
  const digest = exceptionDigest({ ...args, headers: [] })
  assert.equal(await postDigest({ digest, mailbox: 'shared-inbox', mail }), 'empty')
  assert.deepEqual(mail.messages, [])
})

function noticeArgs(t: TestContext) {
  const dir = tempDir(t)
  const argv = ['digest', 'notices', '--version', '41']
  for (const [name, data] of Object.entries({ previous, next: { ...next, heartbeat_minutes: 8 }, mailboxes })) {
    const path = join(dir, `${name}.json`)
    writeFileSync(path, JSON.stringify(data))
    argv.push(`--${name}`, path)
  }
  return argv
}

test('notices dry-run: preview sends mail or does not print one line per mailbox', async (t) => {
  const mail = memoryMail()
  const out: string[] = [], err: string[] = []
  const status = await run([...noticeArgs(t), '--dry-run'], {
    createMail: () => mail, now: clock, stdout: (line) => out.push(line), stderr: (line) => err.push(line),
  })
  assert.deepEqual(mail.messages, [])
  assert.equal(status, 0, err.join('\n'))
  assert.deepEqual(out.sort(), ['shared-inbox  would send', 'watch-inbox  would send'])
})

test('notices without a transport: a real send is mistaken for a successful preview', async (t) => {
  const out: string[] = [], err: string[] = []
  const status = await run(noticeArgs(t), { stdout: (line) => out.push(line), stderr: (line) => err.push(line) })
  assert.equal(status, 2)
  assert.deepEqual(err, ['error: no mail transport configured'])
  assert.deepEqual(out, [])
})

routingTest('swarm digest reaches its area: a bad subcommand is the area\'s misuse, not an unknown command', () => {
  const result = spawnSwarm(process.execPath, ['src/cli.ts', 'digest', 'bogus'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 2 || /unknown command/.test(result.stderr)) {
    throw new Error(`not routed to digest: ${result.status} ${result.stderr}`)
  }
})
