import { spawnSync as spawnSwarm } from 'node:child_process'
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
const previous = { tiers: { models: { sprite: { thinking: before } } } }
const next = { tiers: { models: { sprite: { thinking: after } } } }

test('notice crash retry: the port must report existing and keep one notice per mailbox', async () => {
  const mail = memoryMail(), id = 'policy:shared-inbox:party:v41'
  const input = { version: 41, previous, next, mailboxes }
  await assert.rejects(policyNotices({ ...input, mail: { async post(message) {
    await mail.post(message)
    throw new Error('lost reply after delivery')
  } } }), /lost reply after delivery/)
  let outcome: string | undefined
  const retry = await policyNotices({ ...input, mail: { async post(message) {
    const result = await mail.post(message)
    outcome = result.landed
    return result
  } } })
  assert.equal(outcome, 'existing')
  assert.deepEqual(retry, { sent: [], skipped: [id] })
  assert.deepEqual(mail.messages.map((message) => message.id), [id])
})

test('notice routing: heartbeat misses mail, a dotted key impersonates a path, or an unknown reader is accepted', async () => {
  const readers = { claims: 'claims-inbox', dispatch: 'dispatch-inbox', mail: 'mail-inbox', ui: 'ui-inbox', watch: 'watch-inbox' }
  for (const [next, boxes] of [
    [{ heartbeat_minutes: 8 }, Object.values(readers)],
    [{ mail: { digest_minutes: 20 } }, ['mail-inbox']],
    [{ tiers: { models: { sprite: { thinking: 'medium' } } } }, ['dispatch-inbox']],
    [{ review: { code: { review_rounds: 2 } } }, ['claims-inbox']],
    [{ names: { sprite_items: { implement: ['fixture'] } } }, ['ui-inbox']],
    [{ trackers: { 'acme/example': { sources: ['github'] } } }, ['watch-inbox']],
    [{ 'mail.future': true }, Object.values(readers)],
    [{ mail: { future_field: true } }, Object.values(readers)],
  ] as const) {
    const mail = memoryMail()
    await policyNotices({ version: 1, previous: {}, next, mailboxes: readers, mail })
    assert.deepEqual(mail.messages.map((message) => message.mailbox), boxes)
  }
  const mail = memoryMail()
  await assert.rejects(policyNotices({ version: 1, previous, next, mailboxes: { ...readers, watchers: 'other' }, mail }),
    /unrecognized reader name "watchers"/)
  assert.deepEqual(mail.messages, [])
})

test('notice routing broadcasts unknown descendants when a scalar replaces an object or vice versa', async () => {
  const readers = { dispatch: 'dispatch-inbox', mail: 'mail-inbox', watch: 'watch-inbox' }
  const configs = ['forward_now', { future: true }].map((p0) => ({ mail: { urgency: { p0 } } }))
  for (const i of [0, 1]) {
    const mail = memoryMail()
    await policyNotices({ version: 1, previous: configs[i], next: configs[1 - i], mailboxes: readers, mail })
    assert.deepEqual(mail.messages.map(({ mailbox }) => mailbox), Object.values(readers))
  }
})

test('policy notice paths: values, unknown segments or dynamic keys leak in text, block or receipt', async () => {
  const dataKey = ['fixture', 'private', 'entry'].join('_')
  const tracker = `acme/${dataKey}`
  const mail = memoryMail()
  const receipt = await policyNotices({ version: 413, previous, mailboxes, mail, next: {
    ...next, trackers: { [tracker]: { sources: ['github'] } },
    mail: { [dataKey]: true, 'urgency.p1': true, urgency: { p1: { forward_within_minutes: 20 } } },
  } })
  const paths = ['mail', 'tiers.models.sprite.thinking', 'trackers']
  const boxes = ['shared-inbox', 'watch-inbox']
  assert.deepEqual(receipt, { sent: boxes.map((box) => `policy:${box}:party:v413`), skipped: [] })
  // Whitelist the complete notice, so no config values or private keys can appear even after the fetch instruction.
  assert.deepEqual(mail.messages, boxes.map((mailbox) => ({
    id: `policy:${mailbox}:party:v413`, mailbox, class: 'policy', urgency: 'p1',
    block: { schema: 'swarm-policy@1', data: { record: 'party', version: 413, changed_paths: paths } },
    text: `config party v413 changed: ${paths.join(', ')}. fetch this committed record from the config thread on the party board.`,
  })))
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
    header('deadline-p2', 'p2', { expires: now }), header('deadline-p3', 'p3', { expires: now }),
    header('before', 'p0', { createdAt: '2026-11-20T20:59:59Z' }),
    header('next-window', 'p0', { createdAt: window.to }),
  ] })
  assert.deepEqual(digest.items.map((item) => item.id), ['routine'])
  assert.deepEqual(digest.counts, { p0: 0, p1: 0, p2: 1, p3: 1 })
})

test('digest rejects malformed timestamps and expiry on p0/p1, naming even filtered headers', () => {
  for (const [bad, field] of [
    [header('bad-created', 'p2', { createdAt: '2026-02-30T21:01:00Z' }), 'createdAt'],
    [header('offset-created', 'p2', { createdAt: '2026-11-20T21:01:00+00:00' }), 'createdAt'],
    [header('lowercase-expiry', 'p3', { expires: '2026-11-20t21:30:00z' }), 'expires'],
    [header('bad-expiry', 'p3', { expires: '', state: 'handled' }), 'expires'],
    ...(['p0', 'p1'] as const).map((urgency) => [header(`urgent-${urgency}`, urgency, { expires: now }), 'expires'] as const),
  ] as const) {
    assert.throws(() => exceptionDigest({ ...args, headers: [bad] }), new RegExp(`${field}.*header "${bad.id}"`))
  }
})

test('digest rejects sub-millisecond expiry instead of dropping a live header', () => {
  const live = header('live', 'p2', { expires: '2026-11-20T21:30:00.0009Z' })
  assert.throws(() => exceptionDigest({ ...args, headers: [live] }), /expires.*header "live"/)
})

test('digest rejects sub-millisecond createdAt instead of tying distinct duplicate versions', () => {
  const headers = ['0001', '0009'].map((fraction, i) => header('dup', 'p2', {
    createdAt: `2026-11-20T21:01:00.${fraction}Z`, summary: i === 0 ? 'older' : 'newer',
  }))
  assert.throws(() => exceptionDigest({ ...args, headers }), /createdAt.*header "dup"/)
})

test('digest ordering: duplicate ids choose newest and distinct ids tie-break by code units', () => {
  const headers = [header('é', 'p1'), header('e\u0301', 'p1'),
    header('dup', 'p1', { createdAt: '2026-11-20T21:01:00Z', summary: 'newest' }),
    header('dup', 'p1', { createdAt: '2026-11-20T21:01:00Z', summary: 'tied' }),
    header('dup', 'p1', { summary: 'old' })]
  for (const order of [headers, [...headers].reverse()]) {
    const digest = exceptionDigest({ ...args, headers: order })
    assert.deepEqual(digest.act_on, ['e\u0301', 'é', 'dup'])
    assert.equal(digest.items[2]?.summary, 'newest')
  }
})

test('actionable digest headers: p1 jumps ahead of p0 or a body is exposed', () => {
  const p1 = { ...header('decision', 'p1'), body: 'fixture message body' }
  const p0 = { ...header('outage', 'p0', { createdAt: '2026-11-20T21:20:00Z' }), body: p1.body }
  const digest = exceptionDigest({ ...args, headers: [p1, p0] })
  assert.deepEqual(digest.act_on, ['outage', 'decision'])
  assert.deepEqual(digest.items.map((item) => item.id), digest.act_on)
  assert.doesNotMatch(JSON.stringify(digest), /"body"\s*:|fixture message body/)
})

test('notice and overdue ack identity: two repo records at v1 collide or lose their fetch reference', async () => {
  const mail = memoryMail(), version = 1, mailbox = 'shared-inbox'
  const records = ['repo:acme/example', 'repo:acme/extras']
  const ids = records.map((record) => `policy:${mailbox}:${record}:v1`)
  for (const record of records) await policyNotices({ record, version, previous, next, mail, mailboxes })
  assert.deepEqual(mail.messages.map(({ id }) => id), ids)
  for (const [index, record] of records.entries()) assert.ok(mail.messages[index]?.text.includes(`${record} v1`))
  const older = { version, mailbox, noticeAt: '2026-11-20T20:29:00Z', acked: false }
  const digest = exceptionDigest({ ...args, headers: [], acks: [
    ...records.map((record) => ({ ...older, record })),
    { ...older, record: 'done', acked: true },
    { ...older, record: 'fresh', noticeAt: '2026-11-20T20:31:00Z' },
  ] })
  assert.deepEqual(digest.act_on, ids)
  assert.deepEqual(digest.items.map(({ class: kind, urgency }) => [kind, urgency]), [['policy', 'p1'], ['policy', 'p1']])
})

const invalidBounds = [
  ['to', '2026-11-20 21:30:000.0001Z'], ['to', '2026-11-20 21:30:000.0009Z'],
  ['to', '2026-11-20T21:30:00.0001Z'], ['to', '2026-11-20T21:30:00.0009Z'],
  ['from', '2026-11-20T21:00:00.0001Z'], ['from', '2026-11-20 21:00:00Z'],
  ['from', '2026-11-20T21:00:00+01:00'], ['from', '2026-02-30T21:00:00Z'],
  ['from', '2026-11-20T21:00:00.Z'], ['to', ''],
] as const

test('digest rejects non-UTC-ISO window bounds instead of colliding delivery ids', async () => {
  const headers = [header('outage', 'p0')], digest = exceptionDigest({ ...args, headers })
  const mail = memoryMail()
  for (const [bound, value] of invalidBounds) {
    const bounds = { ...window, [bound]: value }, error = { message: `invalid window ${bound}` }
    assert.throws(() => exceptionDigest({ ...args, window: bounds, headers }), error, JSON.stringify(value))
    await assert.rejects(postDigest({ mailbox: 'shared-inbox', mail, digest: { ...digest, window: bounds } }),
      error, JSON.stringify(value))
  }
  assert.deepEqual(mail.messages, [])
})

test('digest show names the invalid --from or --to bound and prints no digest', async () => {
  const out: string[] = [], err: string[] = []
  const io = { read: async () => '[]', stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) }
  for (const [bound, value] of invalidBounds) {
    const bounds = { ...window, [bound]: value }
    const status = await run(['show', '--repo', args.repo, '--headers', 'headers.json',
      '--from', bounds.from, '--to', bounds.to], io)
    assert.deepEqual([status, err.pop()], [1, `error: invalid window ${bound}`], JSON.stringify(value))
  }
  assert.deepEqual(out, [])
})

test('digest delivery: repo or window ids collide, retries duplicate, or extra fields serialize', async () => {
  const mailbox = 'shared-inbox', store = memoryMail()
  const mail: typeof store = { get messages() { return store.messages }, async post(message) {
    return store.post(JSON.parse(JSON.stringify(message)))
  } }
  const body = ['fixture', 'body'].join(' ')
  class DecoratedItems extends Array<MessageHeader> {
    body = body
    toJSON() { return { body: this.body } }
  }
  const headers = [header('outage', 'p0', { createdAt: '2026-11-20T21:20:00Z' })]
  for (const [repo, bounds] of [[args.repo, window], ['acme/extras', window],
    [args.repo, { ...window, from: '2026-11-20T21:01:00Z' }],
    [args.repo, { ...window, to: '2026-11-20T21:30:00.001Z' }]] as const) {
    const digest = exceptionDigest({ ...args, repo, window: bounds, headers })
    const items = new DecoratedItems()
    for (const item of digest.items) {
      const decorated = { ...item, body, toJSON: () => ({ body }) }
      items.push(decorated)
    }
    const extra = { ...digest, body, items }
    assert.equal(digest.batch, 'ex-2026-11-20T21:30Z')
    assert.equal(await postDigest({ mailbox, mail, digest: extra }), 'posted')
    assert.deepEqual(mail.messages.at(-1)?.block, { schema: 'swarm-digest@1', data: digest })
    assert.equal(mail.messages.at(-1)?.id,
      `digest:${mailbox}:${repo}:${new Date(bounds.from).toISOString()}:${new Date(bounds.to).toISOString()}`)
    assert.equal(await postDigest({ mailbox, mail, digest }), 'existing')
  }
  assert.equal(mail.messages.length, 4)
})

test('empty digest: an inbox receives a message with no exceptions', async () => {
  const mail = memoryMail()
  const digest = exceptionDigest({ ...args, headers: [] })
  assert.equal(await postDigest({ digest, mailbox: 'shared-inbox', mail }), 'empty')
  assert.deepEqual(mail.messages, [])
})

function noticeArgs(t: TestContext, readers = mailboxes) {
  const dir = tempDir(t)
  const argv = ['digest', 'notices', '--version', '41']
  for (const [name, data] of Object.entries({
    previous, next: { ...next, trackers: { 'acme/example': { sources: ['github'] } } }, mailboxes: readers,
  })) {
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

test('notices reject invalid mailbox ids before output or delivery and no longer accept --sent', async (t) => {
  const mail = memoryMail(), out: string[] = [], err: string[] = []
  const io = { createMail: () => mail, stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) }
  const invalid = noticeArgs(t, { ...mailboxes, watch: 'watch-inbox\nforged-row' })
  for (const argv of [invalid, [...invalid, '--dry-run']]) {
    assert.equal(await run(argv, io), 1)
    assert.match(err.pop() ?? '', /^error: invalid mailbox id:/)
  }
  assert.equal(await run([...noticeArgs(t), '--dry-run', '--sent', 'obsolete'], io), 2)
  assert.deepEqual(err, ['error: invalid digest options'])
  assert.deepEqual(out, [])
  assert.deepEqual(mail.messages, [])
  await assert.rejects(postDigest({ mailbox: 'bad/box', mail,
    digest: exceptionDigest({ ...args, headers: [header('outage', 'p0')] }) }), /invalid mailbox id/)
  assert.deepEqual(mail.messages, [])
})

test('swarm digest reaches its handler: exact misuse and successful show --json', (t) => {
  const spawn = (...argv: string[]) => spawnSwarm(process.execPath, ['src/cli.ts', 'digest', ...argv], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  })
  const bad = spawn('bogus')
  assert.equal(bad.status, 2)
  assert.equal(bad.stderr.trimEnd(), 'error: expected digest notices or show')
  const path = join(tempDir(t), 'headers.json')
  writeFileSync(path, JSON.stringify([header('outage', 'p0')]))
  const show = () => spawn('show', '--json', '--repo', args.repo, '--from', '2026-11-20T21:00:00.0Z',
    '--to', '2026-11-20T21:30:00.00Z', '--headers', path)
  const good = show()
  assert.equal(good.status, 0, good.stderr)
  assert.deepEqual(JSON.parse(good.stdout).act_on, ['outage'])
  writeFileSync(path, JSON.stringify([{ ...header('bad', 'p2'), expires: 'not-a-date' }]))
  const malformed = show()
  assert.equal(malformed.status, 1)
  assert.equal(malformed.stderr.trimEnd(), 'error: invalid expires for header "bad"')
})
