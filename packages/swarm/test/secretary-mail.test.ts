import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  compilePacket, createRouter, parseHeader, readFileMail, redact, type FileMailItem,
} from '../src/secretary/index.ts'

const options = {
  classes: ['policy', 'sec.log', 'spawner.decide', 'core.escalate'], digestMinutes: 30, p1Minutes: 10, p0Seconds: 60,
}
const start = Date.parse('2026-11-20T21:00:00Z')
const min = 60_000
const statFile = stat
const redactedId = (id: string) => `[redacted:${createHash('sha256').update(id).digest('hex').slice(0, 8)}]`
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
  await put('no-from.md', fenced({ ...raw('no-from'), from: undefined }))
  await put('oversize.md', fenced(raw('big')) + 'x'.repeat(64 * 1024))
  const items = await readFileMail(root, 'abc')
  const router = createRouter(options)
  const results = router.ingest(items, start)
  assert.deepEqual(results.map(({ kind, file, reason }) => [kind, basename(file), reason]), [
    ['reject', 'broken.md', 'bad_yaml'], ['reject', 'missing.md', 'no_header'],
    ['reject', 'no-from.md', 'missing_field:from'], ['reject', 'oversize.md', 'oversize'],
  ])
  assert.deepEqual(router.due(start + 30 * min), { p0: [], p1: [], digests: [] })
})

test('rejected file mail carries only a bounded string sender claim', async (t) => {
  const { root, put } = await inbox(t)
  const sender = '🐝'.repeat(200)
  for (const [i, from] of [sender + 'x', '', 42, undefined].entries()) {
    await put(`${i}.md`, fenced(raw('bad', { class: 'disabled', from, body: 'private pointer' })))
  }
  assert.deepEqual((await readFileMail(root, 'abc')).map(({ result }) => result), [
    { ok: false, reason: 'bad_class', from: sender },
    { ok: false, reason: 'bad_class' },
    { ok: false, reason: 'bad_class' },
    { ok: false, reason: 'missing_field:from' },
  ])
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

test('dedupe distinguishes revisions, older mail, identical replays and ID collisions', () => {
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
    ['reject', 'id_collision'], ['reject', 'less_urgent_same_at'], ['reject', 'id_collision'],
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
    id: redactedId('alert-ghp_idFixture'), class: 'spawner.[redacted]', urgency: 'p0', from: 'sprite [redacted]',
    ref: 'work [redacted]', summary: 'review [redacted]', at: iso(start - min),
  }
  const accepted = decisions.find(({ kind, id }) => kind === 'accept' && id === safe.id)
  assert.deepEqual(accepted?.header, safe)
  assert.equal(accepted?.file, '/mail/[redacted]/inbox/[redacted].md')
  assert.deepEqual(p0.map(({ items }) => items), [[safe]])
  assert.equal(p1.length, 1)
  const urgentDigest = digests.find(({ repo }) => repo === '[redacted]')
  assert.deepEqual(urgentDigest?.items, [{ ...safe, forwarded: true }])
  assert.deepEqual(urgentDigest?.act_on, [safe.id])
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

test('file mail refuses tag and inbox links outside the real mail root', async (t) => {
  const { root } = await inbox(t)
  const outside = await inbox(t)
  await outside.put('outside.md', fenced(raw('outside')))
  await symlink(join(outside.root, 'abc'), join(root, 'tag-link'), 'dir')
  await mkdir(join(root, 'inbox-link'))
  await symlink(join(outside.root, 'abc', 'inbox'), join(root, 'inbox-link', 'inbox'), 'dir')
  for (const tag of ['tag-link', 'inbox-link']) {
    await assert.rejects(readFileMail(root, tag), { message: 'symlink' }, tag)
  }
})

test('symlink and non-file mail entries receive symlink rejection decisions', async (t) => {
  const { root, put } = await inbox(t)
  await put('valid.md', fenced(raw('valid')))
  const dir = join(root, 'abc', 'inbox')
  await symlink('valid.md', join(dir, 'link.md'))
  await mkdir(join(dir, 'directory.md'))
  const decisions = createRouter(options).ingest(await readFileMail(root, 'abc'), start)
  assert.deepEqual(decisions.map(({ file, kind, reason }) => [basename(file), kind, reason]), [
    ['directory.md', 'reject', 'symlink'], ['link.md', 'reject', 'symlink'], ['valid.md', 'accept', undefined],
  ])
})

test('file mail caps reads even when a path stat understates the file size', async (t) => {
  const { root, put } = await inbox(t)
  const cap = 64 * 1024
  const text = fenced(raw('at-cap'))
  await put('at-cap.md', text.padEnd(cap, 'x'))
  await put('over-cap.md', text.padEnd(cap + 1, 'x'))
  await put('sparse.md', text)
  const sparse = join(root, 'abc', 'inbox', 'sparse.md')
  await truncate(sparse, 2 ** 31) // A full read hits Node's file-size limit without allocating gigabytes.
  // Simulate a stale path stat at the filesystem boundary; open/read still use the real file.
  const pathStat = t.mock.method(fs, 'stat', async (path: string) => {
    const info = await statFile(path)
    if (path === sparse) info.size = text.length
    return info
  })
  syncBuiltinESMExports()
  try {
    const files = await readFileMail(root, 'abc')
    assert.deepEqual(files.map(({ file, result }) => [basename(file), result.ok ? 'ok' : result.reason]).sort(), [
      ['at-cap.md', 'ok'], ['over-cap.md', 'oversize'], ['sparse.md', 'oversize'],
    ])
  } finally {
    pathStat.mock.restore()
    syncBuiltinESMExports()
  }
})

test('file mail rejects invalid UTF-8 instead of accepting replacement characters', async (t) => {
  const { root } = await inbox(t)
  const text = Buffer.from(fenced(raw('bad-utf8', { summary: 'placeholder' })))
  text[text.indexOf('placeholder')] = 0xff
  await writeFile(join(root, 'abc', 'inbox', 'invalid.md'), text)
  const [item] = await readFileMail(root, 'abc')
  assert.deepEqual(item?.result, { ok: false, reason: 'bad_encoding' })
})

test('redact masks the whole quoted Bearer value across escaped quotes', () => {
  for (const input of [String.raw`Bearer "fake\"remaining" done`, String.raw`Bearer 'fake\'remaining' done`]) {
    assert.equal(redact(input), 'Bearer [redacted] done')
  }
})

test('distinct redacted ids stay distinct in decisions, forwards, digest items and act_on', () => {
  const router = createRouter(options)
  const ids = ['ghp_fixtureOne', 'ghp_fixtureTwo']
  const safeIds = ids.map(redactedId)
  const decisions = router.ingest(ids.map((id, i) => mail(id, {
    class: 'spawner.decide', urgency: i === 0 ? 'p0' : 'p1', ref: `ref-${i}`, summary: `summary-${i}`,
  }, start + i)), start + 1)
  const { p0, p1, digests } = router.due(start + 30 * min)
  assert.notEqual(decisions[0]?.id, decisions[1]?.id)
  assert.deepEqual(decisions.map(({ id, header }) => [id, header?.id]), safeIds.map((id) => [id, id]))
  assert.deepEqual([...p0, ...p1].map(({ items }) => items.map(({ id }) => id)), safeIds.map((id) => [id]))
  assert.deepEqual(digests[0]?.items.map((item) => 'id' in item ? item.id : undefined), safeIds)
  assert.deepEqual(digests[0]?.act_on, safeIds)
  assert.doesNotMatch(JSON.stringify({ decisions, p0, p1, digests }), /ghp_fixture/)
})

test('an already expired revision does not cancel pending live p1 or p2 mail', () => {
  const router = createRouter(options)
  router.ingest([mail('live-p1', { urgency: 'p1' }), mail('live-p2')], start)
  const decisions = router.ingest(['live-p1', 'live-p2'].map((ref) => mail(`expired-${ref}`, {
    ref, at: iso(start), expires: iso(start + 1),
  }, start + 1)), start + 1)
  assert.deepEqual(decisions.map(({ kind, reason }) => [kind, reason]), [['expire', 'expired'], ['expire', 'expired']])
  const { p1, digests } = router.due(start + 30 * min)
  assert.deepEqual(p1.map(({ items }) => items.map(({ id }) => id)), [['live-p1']])
  assert.deepEqual(digests.map(({ items }) => items.map(({ summary }) => summary)), [['live-p1', 'live-p2']])
})

test('older-at and same-at p0 forward alone on warm and fresh routers', async (t) => {
  const { root, put } = await inbox(t)
  for (const ref of ['older', 'same']) {
    await put(`routine-${ref}.md`, fenced(raw(`routine-${ref}`, { ref })), start + min)
  }
  const warm = createRouter(options)
  warm.ingest(await readFileMail(root, 'abc'), start + min)
  await put('alert-older.md', fenced(raw('alert-older', { ref: 'older', urgency: 'p0', at: iso(start - 2 * min) })))
  await put('alert-same.md', fenced(raw('alert-same', { ref: 'same', urgency: 'p0' })))
  const files = await readFileMail(root, 'abc')
  const now = start + 2 * min
  for (const [label, router] of [['warm', warm], ['fresh', createRouter(options)]] as const) {
    router.ingest(files, now)
    const { p0, p1 } = router.due(now)
    assert.deepEqual(p0.map(({ items }) => items.map(({ id }) => id)), [['alert-older'], ['alert-same']], label)
    assert.deepEqual(p1, [], label)
    const decisions = router.ingest([
      mail('alert-same', { ref: 'same', urgency: 'p0' }),
      mail('alert-older', { ref: 'changed', urgency: 'p0' }),
    ], now)
    assert.deepEqual(decisions.map(({ kind, reason }) => [kind, reason]), [['reject', 'id_collision'], ['duplicate', undefined]])
    assert.deepEqual(router.due(now).p0, [])
  }
})

test('older-at rejects reserve their ids against reuse with a different ref', () => {
  const router = createRouter(options)
  router.ingest([mail('latest', { ref: 'task', at: iso(start) })], start)
  const old = mail('stale', { ref: 'task' })
  assert.equal(router.ingest([old], start)[0]?.reason, 'older_at')
  assert.equal(router.ingest([mail('stale', { ref: 'other' })], start)[0]?.reason, 'id_collision')
  assert.equal(router.ingest([old], start)[0]?.kind, 'duplicate')
})

test('scalar ref mappings escape delimiters and cannot collide during file mail dedupe', async (t) => {
  const { root, put } = await inbox(t)
  await put('one.md', fenced(raw('one', { ref: { a: 'x,b=y' } })))
  await put('two.md', fenced(raw('two', { ref: { b: 'y', a: 'x' } })))
  await put('three.md', fenced(raw('three', { ref: { 'c%,=': 'x%2Cb%3Dy' } })))
  const decisions = createRouter(options).ingest(await readFileMail(root, 'abc'), start)
  assert.deepEqual(decisions.map(({ kind, header }) => [kind, header?.ref]), [
    ['accept', 'a=x%2Cb%3Dy'], ['accept', 'c%25%2C%3D=x%252Cb%253Dy'], ['accept', 'a=x,b=y'],
  ])
})

test('restarted router gives a changed member set in the same digest window a new key', () => {
  function replay(ids: string[]) {
    const router = createRouter(options)
    router.ingest(ids.map((id, i) => mail(id, { class: 'sec.log' }, start + i)), start + min)
    const { digests } = router.due(start + 30 * min)
    assert.equal(digests.length, 1)
    return digests[0]!
  }
  const first = replay(['a', 'b'])
  const changed = replay(['a', 'c'])
  assert.equal(first.window.from, changed.window.from)
  assert.equal(first.repo, changed.repo)
  assert.notEqual(first.key, changed.key)
  assert.equal(first.key, replay(['b', 'a']).key)
})

test('id and summary length limits count Unicode code points', () => {
  const id = '🐝'.repeat(200)
  const summary = '🐝'.repeat(120)
  assert.ok(parseHeader(raw(id, { summary: 'short' }), options).ok, '200 code points in id')
  assert.ok(parseHeader(raw('short', { summary }), options).ok, '120 code points in summary')
  assert.deepEqual(parseHeader(raw(`${id}a`, { summary }), options), { ok: false, reason: 'id_too_long' })
  assert.deepEqual(parseHeader(raw(id, { summary: `${summary}a` }), options), { ok: false, reason: 'summary_too_long' })
})

const tigeryardOptional = {
  needs: 'context', reply_to: 'parent', thread: 'thread-1', status: 'open',
  review_by: 'core', default_if_unanswered: 'hold', answered_at: iso(start),
}

test('optional Tigeryard header fields and a missing ref are accepted rather than unknown_field', () => {
  const accepted = parseHeader(raw('optional', tigeryardOptional), options)
  assert.ok(accepted.ok, 'optional fields must not be unknown_field')
  assert.deepEqual(Object.keys(accepted.message).sort(), ['at', 'class', 'from', 'id', 'ref', 'summary', 'urgency'])
  const { ref: _ref, ...noRef } = raw('isolated')
  const isolated = parseHeader(noRef, options)
  assert.ok(isolated.ok, 'a missing ref must be accepted')
  assert.ok(isolated.ok && !('ref' in isolated.message))
  for (const field of Object.keys(tigeryardOptional)) {
    assert.deepEqual(parseHeader(raw('bad', { [field]: '' }), options), { ok: false, reason: `bad_${field}` }, field)
    assert.deepEqual(parseHeader(raw('bad', { [field]: '🐝'.repeat(201) }), options), { ok: false, reason: `bad_${field}` }, field)
    assert.ok(parseHeader(raw('ok', { [field]: '🐝'.repeat(200) }), options).ok, field)
  }
  assert.deepEqual(parseHeader(raw('bad', { ref: [] }), options), { ok: false, reason: 'bad_ref' })
  assert.deepEqual(parseHeader(raw('bad', { ref: '' }), options), { ok: false, reason: 'bad_ref' })
  assert.deepEqual(parseHeader(raw('bad', { extra: 'nope' }), options), { ok: false, reason: 'unknown_field:extra' })
  for (const field of ['id', 'class', 'urgency', 'from', 'summary', 'at'] as const) {
    const { [field]: _omitted, ...missing } = raw('missing')
    assert.deepEqual(parseHeader(missing, options), { ok: false, reason: `missing_field:${field}` }, field)
  }

  const item = (id: string, header: Record<string, unknown>, receivedAt = start): FileMailItem =>
    ({ file: `/mail/abc/inbox/${id}.md`, receivedAt, result: parseHeader(header, options) })
  const { ref: _peerRef, ...peer } = raw('peer')
  const router = createRouter(options)
  const decisions = router.ingest([
    item('isolated', noRef),
    item('peer', peer),
    item('isolated-again', noRef, start + 1),
    item('collision', { ...noRef, summary: 'changed' }, start + 2),
  ], start + 2)
  assert.deepEqual(decisions.map(({ kind, reason, header }) => [kind, reason, header && 'ref' in header]), [
    ['accept', undefined, false], ['accept', undefined, false],
    ['duplicate', undefined, false], ['reject', 'id_collision', false],
  ])
  const { digests } = router.due(start + 30 * min)
  const packet = compilePacket({ tag: 'abc', lane: 'p1_batch', now: start,
    items: decisions.flatMap((decision) => decision.header ?? []) })
  const blob = JSON.stringify({ decisions, digests, packet })
  for (const field of Object.keys(tigeryardOptional)) assert.doesNotMatch(blob, new RegExp(`"${field}"`))
  assert.ok(digests[0]?.items.every((entry) => !('ref' in entry)))
})

test('same-at escalation forwards once on warm and fresh routers in either filename order', async (t) => {
  const shared = { from: 'sprite', ref: 'task=1', class: 'policy', at: iso(start) }
  const routine = fenced(raw('routine-p2', { ...shared, urgency: 'p2', summary: 'routine' }))
  const escalate = fenced(raw('escalate-p1', { ...shared, urgency: 'p1', summary: 'escalate' }))
  const now = start + 10 * min
  for (const label of ['warm', 'fresh routine first', 'fresh escalation first']) {
    const { root, put } = await inbox(t)
    const router = createRouter(options)
    const routineFirst = label === 'fresh routine first'
    await put(routineFirst ? 'a.md' : 'z.md', routine, start)
    if (label === 'warm') {
      assert.equal(router.ingest(await readFileMail(root, 'abc'), start)[0]?.kind, 'accept')
      assert.deepEqual(router.due(start).p1, [])
    }
    await put(routineFirst ? 'z.md' : 'a.md', escalate, start)
    const decisions = router.ingest(await readFileMail(root, 'abc'), now)
    assert.equal(decisions.find((row) => row.id === 'escalate-p1')?.kind,
      label === 'fresh escalation first' ? 'accept' : 'revision', label)
    const { p0, p1 } = router.due(now)
    assert.deepEqual(p1.map(({ items }) => items.map(({ id }) => id)), [['escalate-p1']], label)
    assert.deepEqual(p0, [], label)
    const followUp = router.due(start + 30 * min)
    assert.deepEqual(followUp.p1, [], label)
    assert.deepEqual(followUp.digests.map(({ items }) => items.map((item) => 'id' in item ? [item.id, item.forwarded] : item)), [
      [['escalate-p1', true]],
    ], label)
    if (label === 'fresh escalation first') {
      const rejected = decisions.find((row) => row.id === 'routine-p2')
      assert.deepEqual([rejected?.kind, rejected?.reason], ['reject', 'less_urgent_same_at'])
    }
    assert.equal(router.ingest([
      mail('stale', { ...shared, at: iso(start - min) }, now + 1),
      mail('escalate-p1', { ...shared, urgency: 'p1', summary: 'escalate' }, now + 2),
      mail('escalate-p1', { ...shared, urgency: 'p1', summary: 'other' }, now + 3),
    ], now + 3).map(({ kind, reason }) => [kind, reason]).join(),
    [['reject', 'older_at'], ['duplicate', undefined], ['reject', 'id_collision']].join(), label)
  }
})

test('equal-urgency same-at revisions keep the later receipt across ticks', () => {
  const shared = { ref: 'task', urgency: 'p1' }
  const earlier = mail('a', shared)
  const later = mail('z', shared)
  for (const [first, second] of [[earlier, later], [later, earlier]] as const) {
    const router = createRouter(options)
    assert.equal(router.ingest([first], start)[0]?.kind, 'accept')
    const [next] = router.ingest([second], start + 1)
    assert.deepEqual([next?.kind, next?.reason], second === later
      ? ['revision', undefined] : ['reject', 'older_receipt_same_at'])
    assert.deepEqual(router.due(start + 10 * min).p1.map(({ items }) => items.map(({ id }) => id)), [['z']])
  }
})
