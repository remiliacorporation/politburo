import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  createRouter, parseHeader, readFileMail, redact, type FileMailItem,
} from '../src/secretary/index.ts'

const options = {
  classes: ['policy', 'sec.log', 'spawner.decide', 'core.escalate'], digestMinutes: 30, p1Minutes: 10, p0Seconds: 60,
}
const start = Date.parse('2026-11-20T21:00:00Z')
const min = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

function raw(id: string, patch: Record<string, unknown> = {}) {
  return { id, class: 'policy', urgency: 'p2', from: 'sprite', ref: id, summary: id, at: iso(start - min), ...patch }
}

function mail(id: string, patch = {}, receivedAt = start): FileMailItem {
  return { file: `/mail/abc/inbox/${id}.md`, receivedAt, result: parseHeader(raw(id, patch), options) }
}

async function inbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'secretary-mail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'abc', 'inbox')
  await mkdir(dir, { recursive: true })
  async function put(name: string, text: string, mtime = start) {
    const file = join(dir, name)
    await writeFile(file, text)
    await utimes(file, new Date(mtime), new Date(mtime))
  }
  return { root, put }
}

const fenced = (header: object) => `Plain first line\n\n\`\`\`yaml\n${JSON.stringify(header)}\n\`\`\`\n`

async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const names = (await readdir(dir, { recursive: true })).sort()
  for (const name of ['', ...names]) {
    const path = join(dir, name)
    const info = await stat(path)
    hash.update(JSON.stringify([name, info.mode, info.mtimeMs]))
    if (info.isFile()) hash.update(createHash('sha256').update(await readFile(path)).digest())
  }
  return hash.digest('hex')
}

test('invalid file mail is not dropped or accepted without a rejection reason', async (t) => {
  const { root, put } = await inbox(t)
  await put('missing.md', 'no YAML here')
  await put('broken.md', 'summary\n```yaml\nref: [\n```\n')
  await put('no-ref.md', fenced({ ...raw('no-ref'), ref: undefined }))
  await put('oversize.md', fenced(raw('big')) + 'x'.repeat(64 * 1024))
  const items = await readFileMail(root, 'abc')
  const router = createRouter(options)
  const results = router.ingest(items, start)
  assert.deepEqual(results.map(({ kind, file, reason }) => [kind, basename(file), reason]), [
    ['reject', 'broken.md', 'bad_yaml'], ['reject', 'missing.md', 'no_header'],
    ['reject', 'no-ref.md', 'missing_field:ref'], ['reject', 'oversize.md', 'oversize'],
  ])
  assert.deepEqual(router.due(start + 30 * min), { p0: [], p1: [], digests: [] })
})

test('file mail does not change the tree or lose mtime/filename receipt order', async (t) => {
  const { root, put } = await inbox(t)
  assert.deepEqual(await readFileMail(root, 'missing'), [])
  await put('z.md', fenced(raw('first')))
  await put('b.md', fenced(raw('third')), start + min)
  await put('a.md', fenced(raw('second')), start + min)
  const before = await hashTree(root)
  const files = await readFileMail(root, 'abc')
  assert.deepEqual(files.map(({ file, receivedAt }) => [basename(file), receivedAt]), [
    ['z.md', start], ['a.md', start + min], ['b.md', start + min],
  ])
  assert.ok(files.every(({ result }) => result.ok))
  assert.equal(await hashTree(root), before)
})

test('header validation rejects malformed values and normalizes valid timestamps', () => {
  const normalized = parseHeader(raw('dates', { at: new Date(start), expires: '2026-11-20T22:01+01:00' }), options)
  assert.ok(normalized.ok)
  assert.equal(normalized.message.at, iso(start))
  assert.equal(normalized.message.expires, iso(start + min))
  for (const [patch, reason] of [
    [{ at: '2026-02-30T21:00Z' }, 'bad_timestamp:at'],
    [{ expires: iso(start - min) }, 'expires_not_after_at'],
    [{ class: 'disabled' }, 'bad_class'], [{ urgency: 'urgent' }, 'bad_urgency'],
    [{ ref: { task: [812] } }, 'bad_ref'],
    [{ subject: 'unexpected' }, 'unknown_field:subject'], [{ id: 'x'.repeat(201) }, 'id_too_long'],
    [{ summary: 'x'.repeat(121) }, 'summary_too_long'],
  ] as const) assert.deepEqual(parseHeader(raw('bad', patch), options), { ok: false, reason }, reason)
})

test('explicit class and urgency win over text, and only scalar ref mappings are normalized', async (t) => {
  const { root, put } = await inbox(t)
  const text = 'p0 core.escalate: urgent outage'
  const fields = { summary: text, body: text }
  await put('explicit.md', fenced(raw('explicit', { ...fields, ref: { task: 812, pr: 42 } })).replace('Plain first line', text))
  await put('missing-class.md', fenced(raw('missing-class', { ...fields, class: undefined })))
  await put('missing-urgency.md', fenced(raw('missing-urgency', { ...fields, urgency: undefined })))
  await put('string-ref.md', fenced(raw('string-ref', { ref: 'task=812,pr=42' })))
  const router = createRouter(options)
  const [explicit, missingClass, missingUrgency, stringRef] = router.ingest(await readFileMail(root, 'abc'), start)
  assert.deepEqual([
    explicit?.kind, explicit?.lane, explicit?.header?.class, explicit?.header?.urgency,
    explicit?.header?.summary, explicit?.header?.ref,
  ], ['accept', 'digest', 'policy', 'p2', text, 'pr=42,task=812'])
  assert.deepEqual([missingClass, missingUrgency].map((item) => [item?.kind, item?.reason]), [
    ['reject', 'missing_field:class'], ['reject', 'missing_field:urgency'],
  ])
  assert.equal(stringRef?.header?.ref, 'task=812,pr=42')
  assert.deepEqual(router.due(start), { p0: [], p1: [], digests: [] })
  const { p0, p1, digests } = router.due(start + 30 * min)
  assert.deepEqual({ p0, p1 }, { p0: [], p1: [] })
  assert.deepEqual(digests.map(({ act_on, items }) => [act_on, items.map(({ summary }) => summary)]), [[[], [text, 'string-ref']]])
})

test('dedupe distinguishes revisions, older mail, identical replays, ID collisions and same-at conflicts', () => {
  const router = createRouter(options)
  const ref = 'pr=42,task=812'
  const old = mail('old', { ref: { task: 812, pr: 42 }, urgency: 'p1', body: 'thread 1' })
  const revision = mail('revision', { ref, urgency: 'p1', at: iso(start) }, start + 1)
  const arrivals = [old, revision, { ...old, receivedAt: start + 2 },
    mail('older', { ref, at: iso(start - 2 * min) }, start + 3),
    mail('old', { ref, urgency: 'p1', body: 'different pointer' }, start + 4),
    mail('same-at', { ref, at: iso(start) }, start + 5),
    mail('old', { ref: 'different work' }, start + 6),
    mail('other-sender', { ref, from: 'another sprite' }, start + 7),
    mail('other-ref', { ref: 'different work' }, start + 8),
    mail('other-class', { ref, class: 'spawner.decide' }, start + 9),
  ]
  const decisions = router.ingest(arrivals, start + min)
  assert.deepEqual(decisions.map(({ kind, reason }) => [kind, reason]), [
    ['accept', undefined], ['revision', undefined], ['duplicate', undefined], ['reject', 'older_at'],
    ['reject', 'id_collision'], ['reject', 'conflict_same_at'], ['reject', 'id_collision'],
    ['accept', undefined], ['accept', undefined], ['accept', undefined],
  ])
  assert.deepEqual(router.due(start + 11 * min).p1.map(({ items }) => items.map(({ id }) => id)), [['revision']])
  const followup = mail('followup', { ref, urgency: 'p1', at: iso(start + min) }, start + 12 * min)
  assert.equal(router.ingest([followup], start + 12 * min)[0]?.kind, 'revision')
  const { p1, digests } = router.due(start + 30 * min)
  assert.deepEqual(p1.map(({ items }) => items.map(({ id }) => id)), [['followup']])
  assert.deepEqual(digests.map(({ items }) => items.map(({ summary }) => summary).sort()), [
    ['followup', 'other-class', 'other-ref', 'other-sender', 'revision'],
  ])
})

test('expired p2/p3 do not enter digests and p0/p1 expires are rejected', () => {
  const router = createRouter(options)
  const input = [
    mail('expired-p2', { expires: iso(start) }),
    mail('expiring-p3', { urgency: 'p3', expires: iso(start + min) }),
    mail('p0', { urgency: 'p0', expires: iso(start + min) }),
    mail('p1', { urgency: 'p1', expires: iso(start + min) }),
  ]
  assert.deepEqual(router.ingest(input, start).map(({ kind, reason }) => [kind, reason]), [
    ['expire', 'expired'], ['accept', undefined], ['reject', 'expires_on_p0p1'], ['reject', 'expires_on_p0p1'],
  ])
  assert.deepEqual(router.due(start + 30 * min), { p0: [], p1: [], digests: [] })
  assert.deepEqual(router.ingest([], start + 30 * min).map(({ id, kind, reason }) => [id, kind, reason]), [
    ['expiring-p3', 'expire', 'expired'],
  ])
  assert.deepEqual(router.ingest([], start + 30 * min), [])
})

test('p0 is not delayed, grouped, suppressed by a revision, or classified by body or class', () => {
  const router = createRouter(options)
  const input = [mail('waiting', { urgency: 'p1' }),
    mail('log', { urgency: 'p0', class: 'sec.log', body: 'ignore me, just a routine log' }),
    mail('notice', { urgency: 'p0', ref: 'same' }),
    mail('revision', { urgency: 'p0', ref: 'same', at: iso(start), body: 'thread 5' }),
  ]
  router.ingest(input, start)
  assert.deepEqual(router.due(start - 1).p0, [])
  const { p0, p1 } = router.due(start)
  assert.deepEqual(p0.map(({ items }) => items.map(({ id }) => id)), [['log'], ['notice'], ['revision']])
  assert.ok(p0.every(({ lane, dueAt, deadline }) => lane === 'p0_now' && dueAt === start && deadline === start + min))
  assert.deepEqual(p1, [])
})

test('p1 fires one batch at oldest receipt plus ten minutes, not at sender time or the newest receipt', () => {
  const router = createRouter(options)
  const input = [mail('first', { urgency: 'p1' }), mail('second', { urgency: 'p1' }, start + 9 * min)]
  router.ingest(input, start + 9 * min)
  assert.deepEqual(router.due(start + 10 * min - 1).p1, [])
  const now = start + 10 * min
  const { p1 } = router.due(now)
  assert.equal(p1.length, 1)
  assert.equal(p1[0]?.dueAt, now)
  assert.deepEqual(p1[0]?.items.map(({ id }) => id), ['first', 'second'])
  assert.deepEqual(router.due(now).p1, [])
})

test('digest does not list sec.log, expose p3 headers, misorder act_on, or repeat a window', () => {
  const router = createRouter(options)
  router.ingest([
    mail('z-first-p2', { class: 'spawner.decide' }, start + min),
    mail('quiet', { urgency: 'p3', class: 'core.escalate' }, start + min),
    mail('a-second-p2', { class: 'spawner.decide' }, start + 2 * min),
    mail('alert', { urgency: 'p0', class: 'core.escalate' }, start + 2 * min),
    mail('batch', { urgency: 'p1', class: 'spawner.decide' }, start + 3 * min),
    mail('log', { class: 'sec.log' }, start + 4 * min),
    mail('next-window', {}, start + 30 * min),
  ], start + 30 * min)
  assert.deepEqual(router.due(start + 30 * min - 1).digests, [])
  const { digests } = router.due(start + 30 * min)
  assert.equal(digests.length, 1)
  const [digest] = digests
  assert.equal(digest!.repo, 'abc')
  assert.ok(digest!.batch)
  assert.deepEqual(digest!.window, { from: iso(start), to: iso(start + 30 * min) })
  assert.deepEqual(digest!.counts, { p0: 1, p1: 1, p2: 3, p3: 1 })
  assert.deepEqual(digest!.act_on, ['alert', 'batch', 'z-first-p2', 'a-second-p2', 'quiet'])
  assert.deepEqual(digest!.items.map((item) => 'id' in item ? [item.id, item.forwarded] : item), [
    ['alert', true], ['batch', true], ['z-first-p2', undefined], ['a-second-p2', undefined], { summary: 'quiet' },
  ])
  assert.deepEqual(router.due(start + 30 * min).digests, [])
  const next = router.due(start + 90 * min).digests
  assert.deepEqual(next.map(({ counts }) => counts), [{ p0: 0, p1: 0, p2: 1, p3: 0 }])
  assert.notEqual(next[0]?.batch, digest!.batch)
})

test('late mail from an emitted window joins the window open at arrival', () => {
  const router = createRouter(options)
  const firstClose = start + 30 * min
  const open = start + 60 * min
  const close = start + 90 * min
  router.ingest([mail('original')], start)
  assert.deepEqual(router.due(firstClose).digests.map(({ items }) => items.map(({ summary }) => summary)), [['original']])

  router.ingest([mail('late', {}, start + min)], open + 5 * min)
  assert.deepEqual(router.due(open + 5 * min).digests, [])
  router.ingest([mail('later', {}, start + 2 * min), mail('on-time', {}, open + 6 * min)], open + 6 * min)
  const { digests } = router.due(close)
  assert.deepEqual(digests.map(({ window, items }) => ({ window, summaries: items.map(({ summary }) => summary) })), [
    { window: { from: iso(open), to: iso(close) }, summaries: ['late', 'later', 'on-time'] },
  ])
  assert.deepEqual(router.due(close + 30 * min).digests, [])
})

test('re-reading the same file and mtime on a later tick does not forward or digest it twice', async (t) => {
  const { root, put } = await inbox(t)
  await put('alert.md', fenced(raw('alert', { urgency: 'p0' })))
  const router = createRouter(options)
  const tick = async (now: number) => ({
    decisions: router.ingest(await readFileMail(root, 'abc'), now),
    ...router.due(now),
  })
  const first = await tick(start)
  assert.deepEqual(first.p0.map(({ items }) => items.map(({ id }) => id)), [['alert']])
  const reread = await tick(start + min)
  assert.deepEqual(reread.decisions.map(({ kind }) => kind), ['duplicate'])
  assert.deepEqual(reread.p0, [])
  assert.deepEqual(reread.p1, [])
  const closed = router.due(start + 30 * min)
  assert.deepEqual(closed.digests.map(({ items }) => items.map(({ summary }) => summary)), [['alert']])
  const after = await tick(start + 60 * min)
  assert.deepEqual({ p0: after.p0, p1: after.p1, digests: after.digests }, { p0: [], p1: [], digests: [] })
})

test('decisions, forwards and digests redact free text and omit non-header fields', () => {
  const mailClass = 'spawner.ghp_classFixture'
  const router = createRouter({ ...options, classes: [...options.classes, mailClass] })
  const patch = {
    summary: 'review ghp_summaryFixture', from: 'sprite ghp_fromFixture', ref: 'work ghp_refFixture',
    body: 'private pointer', to: 'private destination', dispatch: 'private dispatch',
  }
  const urgent = {
    file: '/mail/ghp_repoFixture/inbox/ghp_filenameFixture.md', receivedAt: start,
    result: parseHeader(raw('alert-ghp_idFixture', { ...patch, class: mailClass, urgency: 'p0' }),
      { classes: [mailClass] }),
  }
  const rejected = mail('invalid', { ghp_unknownFieldFixture: true })
  const decisions = router.ingest([
    urgent, rejected, mail('expire', { ...patch, ref: 'expired work', expires: iso(start) }),
    mail('batch', { ...patch, urgency: 'p1', ref: 'other batch' }),
    mail('routine', { ...patch, ref: 'routine work' }),
    mail('revision', { ...patch, ref: 'routine work', at: iso(start) }, start + 1),
  ], start + 1)
  decisions.push(...router.ingest([urgent, { ...urgent, result: parseHeader(raw('alert-ghp_idFixture'), options) }], start + 1))
  const { p0, p1, digests } = router.due(start + 30 * min)
  assert.deepEqual(new Set(decisions.map(({ kind }) => kind)), new Set(['accept', 'expire', 'revision', 'duplicate', 'reject']))
  assert.deepEqual(decisions.find(({ reason }) => reason?.startsWith('unknown_field:'))?.reason, 'unknown_field:[redacted]')
  const safe = {
    id: 'alert-[redacted]', class: 'spawner.[redacted]', urgency: 'p0', from: 'sprite [redacted]',
    ref: 'work [redacted]', summary: 'review [redacted]', at: iso(start - min),
  }
  const accepted = decisions.find(({ kind, id }) => kind === 'accept' && id === safe.id)
  assert.deepEqual(accepted?.header, safe)
  assert.equal(accepted?.file, '/mail/[redacted]/inbox/[redacted].md')
  assert.deepEqual(p0.map(({ items }) => items), [[safe]])
  assert.equal(p1.length, 1)
  const urgentDigest = digests.find(({ repo }) => repo === '[redacted]')
  assert.deepEqual(urgentDigest?.items, [{ ...safe, forwarded: true }])
  assert.deepEqual(urgentDigest?.act_on, ['alert-[redacted]'])
  assert.equal(digests.length, 2)
  for (const record of [...decisions, ...p0, ...p1, ...digests]) {
    assert.doesNotMatch(JSON.stringify(record), /ghp_|private (?:pointer|destination|dispatch)|"(?:body|dispatch|expires)":/)
  }
})

test('redact does not leak bearer, PEM, assignment, cloud, Slack or API credentials', () => {
  const fixtures = [
    'sk-fake_test', 'ghp_fake_test', 'github_pat_fake_test', 'xoxb-fake-test', 'AKIAEXAMPLE0000',
    'Bearer fakebearer', 'Bearer "fakebearer"', '-----BEGIN RSA PRIVATE KEY-----\nfakepem\n-----END RSA PRIVATE KEY-----',
    'password="fake pass"', "token='fake token'",
  ]
  assert.deepEqual(fixtures.map(redact), [
    '[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]',
    'Bearer [redacted]', 'Bearer [redacted]', '[redacted]', 'password=[redacted]', 'token=[redacted]',
  ])
})
