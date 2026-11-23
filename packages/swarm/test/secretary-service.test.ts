import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  compilePacket, createShadow, handlePush, handleRetire, prepareMail, readFileMail, runShadow, scorecard, unknownLedger,
  type CasePacket, type DecisionRecord, type RetireFacts, type SwarmMessage,
} from '../src/secretary/index.ts'

const start = Date.parse('2026-11-20T21:00:00Z')
const minute = 60_000
const tag = 'test-repo'
const body = 'private body pointer fixture'
const header = (id: string, patch: Partial<SwarmMessage> = {}): SwarmMessage => ({
  id, class: 'spawner.decide', urgency: 'p2', from: 'sprite', ref: id, summary: id,
  at: new Date(start - minute).toISOString(), body, ...patch,
})

async function mailbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'secretary-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const opts = { mailDir: join(root, 'mail'), tag, outDir: join(root, 'out') }
  const inbox = join(opts.mailDir, tag, 'inbox')
  await mkdir(inbox, { recursive: true })
  const out = join(opts.outDir, tag)
  const text = () => readFile(join(out, 'decisions.jsonl'), 'utf8')
  return {
    root, inbox, out, opts, text,
    async put(id: string, patch: Partial<SwarmMessage> = {}, receivedAt = start) {
      const path = join(inbox, `${id}.md`)
      await writeFile(path, `Summary\n\n\`\`\`yaml\n${JSON.stringify(header(id, patch))}\n\`\`\`\n`)
      await utimes(path, new Date(receivedAt), new Date(receivedAt))
    },
    async records(): Promise<DecisionRecord[]> { return (await text()).trim().split('\n').map((line) => JSON.parse(line)) },
    async heartbeat() { return JSON.parse(await readFile(join(out, 'heartbeat.json'), 'utf8')) },
  }
}

async function treeHash(dir: string) {
  const hash = createHash('sha256')
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const path = join(dir, name)
    const info = await stat(path)
    hash.update(JSON.stringify([name, info.mode, info.mtimeMs]))
    if (info.isFile()) hash.update(await readFile(path))
  }
  return hash.digest('hex')
}

test('refuses overlapping output roots even through a symlink', async (t) => {
  const { root, opts } = await mailbox(t)
  const link = join(root, 'mail-alias')
  await symlink(opts.mailDir, link)
  const before = await treeHash(opts.mailDir)
  for (const outDir of [link, join(link, 'new-output')]) {
    await assert.rejects(createShadow({ ...opts, outDir }), { message: 'out_dir_inside_mail' })
  }
  await assert.rejects(createShadow({ ...opts, outDir: root }), { message: 'mail_dir_inside_out' })
  await mkdir(opts.outDir)
  await symlink(join(opts.mailDir, tag), join(opts.outDir, tag))
  await assert.rejects(createShadow(opts), { message: 'unsafe_output_path' })
  assert.equal(await treeHash(opts.mailDir), before, 'refusal must not create output paths inside mail')
})

test('a full tick leaves mail unchanged and writes valid heartbeat JSON outside mail', async (t) => {
  const { opts, put, heartbeat } = await mailbox(t)
  await put('a', { urgency: 'p0' })
  const before = await treeHash(opts.mailDir)
  const now = start + 30 * minute
  await runShadow(opts, now)
  assert.equal(await treeHash(opts.mailDir), before, 'no file in mail was written or created')
  assert.equal((await heartbeat()).at, now)
})

test('invalid and unparseable files are logged with reasons, never forwarded', async (t) => {
  const { opts, inbox, put, records } = await mailbox(t)
  await writeFile(join(inbox, 'no-header.md'), 'No fenced header')
  await put('missing-from', { from: undefined, urgency: 'p0' })
  await runShadow(opts, start + 30 * minute)
  const log = (await records()).filter((r) => r.kind !== 'ingest')
  assert.deepEqual(log.filter((r) => r.kind !== 'notice').map((r) => [r.kind,
    'file' in r && basename(r.file), 'reason' in r && r.reason]).sort(), [
    ['reject', 'missing-from.md', 'missing_field:from'], ['reject', 'no-header.md', 'no_header'],
  ])
  assert.deepEqual(log.flatMap((r) => r.kind === 'notice' ? [[basename(r.file), r.to, r.reason]] : []).sort(), [
    ['missing-from.md', null, 'missing_field:from'], ['no-header.md', null, 'no_header'],
  ])
})

test('a rejected header yields one unsent notice with a redacted sender and reason but no body', async (t) => {
  const { opts, inbox, records, text } = await mailbox(t)
  const file = join(inbox, 'bad.md')
  const secret = 'ghp_fake_reject_fixture'
  await writeFile(file, `Summary\n\`\`\`yaml\n${JSON.stringify({
    ...header('bad', { from: `sprite ${secret}` }), [secret]: 'unexpected',
  })}\n\`\`\`\n${body}`)
  const before = await treeHash(opts.mailDir)
  await runShadow(opts, start)
  const log = await records()
  assert.deepEqual(log.filter((r) => r.kind !== 'ingest').map((r) => r.kind), ['reject', 'notice'])
  const notices = log.filter((r) => r.kind === 'notice')
  for (const { key, ...notice } of notices) {
    assert.ok(key && key !== log.find((r) => r.kind === 'reject')?.key)
    assert.deepEqual(notice, { v: 1, kind: 'notice', at: start, cycle: 1, file, to: 'sprite [redacted]',
      class: 'spawner.decide', urgency: 'p2', reason: 'unknown_field:[redacted]', sent: false, detail: 'shadow: not sent' })
  }
  assert.doesNotMatch(await text(), /ghp_fake_reject_fixture|private body pointer fixture|"body"/)
  assert.equal(await treeHash(opts.mailDir), before, 'recording the notice must not touch the mailbox')
})

test('a quoted sender credential crossing the cap is masked in ingest and notice', async (t) => {
  const { opts, put, records } = await mailbox(t)
  const prefix = 's'.repeat(160)
  await put('bad', { class: 'disabled', from: `${prefix} password="first synthetic-canary ${'x'.repeat(80)}"` })
  await runShadow(opts, start)
  const log = await records()
  const ingest = log.find((r) => r.kind === 'ingest')
  assert.ok(ingest && !ingest.result.ok)
  const notice = log.find((r) => r.kind === 'notice')
  assert.deepEqual([ingest.result.from, notice?.to], Array(2).fill(`${prefix} password=[redacted]`))
})

test('reject notices bound recipient, reason, file and ID after redaction', async (t) => {
  const { opts, inbox, put, records } = await mailbox(t)
  const id = '🦋'.repeat(200)
  const credential = 'password="synthetic multiword fixture"'
  await put('original', { id })
  await put('collision', { id, from: `${credential} ${'🦋'.repeat(300)}` }, start + 1)
  await writeFile(join(inbox, `${'x'.repeat(205)}.md`), `Summary\n\`\`\`yaml\n${JSON.stringify({
    ...header('bad'), [`${credential} ${'🦋'.repeat(300)}`]: 'unexpected',
  })}\n\`\`\`\n`)
  await runShadow(opts, start + 1)
  const notices = (await records()).filter((r) => r.kind === 'notice')
  assert.equal(notices.length, 2)
  const collision = notices.find((r) => r.reason === 'id_collision')
  const invalid = notices.find((r) => r.reason.startsWith('unknown_field:'))
  assert.ok(collision && invalid)
  const toPrefix = 'password=[redacted] '
  const reasonPrefix = `unknown_field:${toPrefix}`
  assert.deepEqual({ to: collision.to, id: collision.id, reason: invalid.reason, fileLength: [...invalid.file].length }, {
    to: toPrefix + '🦋'.repeat(200 - toPrefix.length), id,
    reason: reasonPrefix + '🦋'.repeat(200 - reasonPrefix.length), fileLength: 200,
  })
})

test('repeated ticks and restart append no second reject notice and recover a missing one', async (t) => {
  const { opts, out, put, text, records } = await mailbox(t)
  await put('bad', { class: 'disabled' })
  const service = await createShadow(opts)
  let original: string
  try {
    await service.tick(start)
    original = await text()
    assert.equal((await records()).filter((r) => r.kind === 'notice').length, 1)
    await service.tick(start + 1)
    assert.equal(await text(), original, 'repeated tick')
  } finally { await service.close() }
  await runShadow(opts, start + 2)
  assert.equal(await text(), original, 'restart')

  // Simulate an interrupted append ending just after the reject decision.
  await writeFile(join(out, 'decisions.jsonl'), original.split('\n').filter((line) =>
    !line || JSON.parse(line).kind !== 'notice').join('\n'))
  await rm(join(opts.mailDir, tag), { recursive: true })
  await runShadow(opts, start + 3)
  assert.equal(await text(), original, 'recover the notice from the journal without the original mail')
})

test('each shadow forward has one undelivered receipt and digests do not wake', async (t) => {
  const { opts, put, records } = await mailbox(t)
  await put('urgent-log', { class: 'sec.log', urgency: 'p0' })
  await put('first', { urgency: 'p1' })
  await put('second', { urgency: 'p1' }, start + minute)
  const now = start + 30 * minute
  await runShadow(opts, now)
  const log = await records()
  const lanes = log.filter((r) => r.kind === 'lane')
  assert.deepEqual(lanes.map((r) => [r.lane, r.items.map((item) => item.id)]), [
    ['p0_now', ['urgent-log']], ['p1_batch', ['first', 'second']],
  ])
  assert.equal(log.filter((r) => r.kind === 'digest').length, 1)
  assert.deepEqual(log.filter((r) => r.kind === 'wake').map((r) =>
    [r.wakeId, r.at, r.lane, r.ids, r.delivered, r.detail]), lanes.map((r) =>
    [r.wakeId, now, r.lane, r.items.map(({ id }) => id), false, 'shadow: not sent']))
})

test('p0 forwards alone at receipt despite a failed handler, a throwing waker and pending p1', async (t) => {
  const { opts, put, records } = await mailbox(t)
  const now = start + minute
  await put('pending', { urgency: 'p1' })
  await put('first-p0', { class: 'sec.push', urgency: 'p0' }, now)
  await put('next-p0', { urgency: 'p0' }, now)
  const packets: CasePacket[] = []
  const service = await createShadow({ ...opts, jobs: {
    job() { throw new Error('evidence unavailable') }, base: () => 'unknown',
  }, waker: { async wake(packet) {
    packets.push(packet)
    if (packet.items.some(({ id }) => id === 'first-p0')) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      throw new Error('wake failed: ghp_fake_wake_fixture')
    }
    return { delivered: true, detail: 'sent' }
  } } })
  t.after(() => service.close())
  await service.tick(now)
  assert.deepEqual(packets.map((p) => [p.lane, p.items.map(({ id }) => id)]), [
    ['p0_now', ['first-p0']], ['p0_now', ['next-p0']],
  ])
  const log = await records()
  assert.deepEqual(log.filter((r) => r.kind === 'lane').map((r) => r.at), [now, now])
  assert.deepEqual(log.filter((r) => r.kind === 'wake').map((r) => [r.ids, r.delivered, r.detail]), [
    [['first-p0'], false, 'error:Error'], [['next-p0'], true, 'sent'],
  ])
  const sla = await scorecard({ records: log, ledger: unknownLedger, tag, sinceMs: start, untilMs: now + 2 * minute })
  assert.equal(sla.late_p0, 0)
  assert.equal(sla.missed_p0, 1, 'an on-time decision with only a failed real wake is missed')
  await service.tick(start + 10 * minute)
  assert.deepEqual(packets.filter((p) => p.lane === 'p1_batch').map((p) => p.items.map(({ id }) => id)), [['pending']])
})

test('wake must be idempotent by wakeId: restart retries with the same ID after archival', async (t) => {
  const { opts, root, inbox, out, put, records, text } = await mailbox(t)
  await put('first', { urgency: 'p0' })
  await put('second', { urgency: 'p0' })
  const saved = join(root, 'interrupted-output')
  const calls: string[] = []
  const deliveries: string[] = []
  const options = { ...opts, waker: { async wake(packet: CasePacket) {
    calls.push(packet.packetId)
    if (!deliveries.includes(packet.packetId)) deliveries.push(packet.packetId)
    if (calls.length === 1) await rename(out, saved)
    return { delivered: true, detail: 'sent' }
  } } }
  const interrupted = await createShadow(options)
  const now = start + 30 * minute
  try { await assert.rejects(interrupted.tick(now), { code: 'ENOENT' }) }
  finally { await rename(saved, out) }
  const before = await text()
  const partial = await records()
  assert.deepEqual(partial.flatMap((r) => r.kind === 'accept' ? [r.id] : []), ['first', 'second'])
  assert.deepEqual(partial.filter((r) => r.kind === 'lane').flatMap((r) => r.items.map(({ id }) => id)), ['first'])
  assert.equal(partial.filter((r) => r.kind === 'wake').length, 0)

  await rm(join(inbox, 'second.md'))
  await interrupted.close()
  await runShadow(options, now + 1)
  const log = await records()
  const lanes = log.filter((r) => r.kind === 'lane')
  assert.deepEqual(lanes.map((r) => r.items.map(({ id }) => id)), [['first'], ['second']])
  assert.deepEqual(log.filter((r) => r.kind === 'wake').map((r) => [r.wakeId, r.ids, r.delivered]),
    lanes.map((r) => [r.wakeId, r.items.map(({ id }) => id), true]))
  assert.deepEqual(calls, [lanes[0]?.wakeId, lanes[0]?.wakeId, lanes[1]?.wakeId])
  assert.deepEqual(deliveries, lanes.map(({ wakeId }) => wakeId))
  const after = await text()
  assert.ok(after.startsWith(before), 'restart preserves the original decisions')
  assert.equal(log.filter((r) => r.kind === 'accept').length, 2)
  assert.equal(new Set(log.map((r) => r.key)).size, log.length, 'no duplicate decisions')
  assert.deepEqual(log.filter((r) => r.kind === 'digest').map((r) => r.counts.p0), [2])
  await runShadow(options, now + 2)
  assert.equal(await text(), after)
})

test('repeated ticks and restart do not append or rebatch already forwarded mail', async (t) => {
  const { opts, inbox, put, text } = await mailbox(t)
  const wakes: CasePacket[] = []
  const options = { ...opts, waker: { async wake(packet: CasePacket) {
    wakes.push(packet)
    return { delivered: false, detail: 'test' }
  } } }
  const service = await createShadow(options)
  await put('first', { urgency: 'p1' })
  await put('urgent', { urgency: 'p0' })
  await service.tick(start + 10 * minute)
  await put('second', { urgency: 'p1' }, start + 12 * minute)
  await service.tick(start + 30 * minute)
  const before = await text()
  const calls = wakes.map((p) => p.packetId)
  assert.equal(calls.length, 3)
  await service.tick(start + 31 * minute)
  await service.close()
  await runShadow(options, start + 32 * minute)
  // The reader may no longer see all the mail that went into a completed digest.
  await rm(join(inbox, 'first.md'))
  await runShadow(options, start + 33 * minute)
  assert.equal(await text(), before)
  assert.deepEqual(wakes.map((p) => p.packetId), calls)
})

test('restart ignores header key order when fingerprinting unchanged mail', async (t) => {
  const { root, opts, out, put, text, records } = await mailbox(t)
  await put('ordered', { body: undefined })
  const [raw] = await readFileMail(opts.mailDir, tag)
  assert.ok(raw?.result.ok)
  const message = raw.result.message
  // Simulate a producer that inserts the same parsed header fields in a different order.
  const reordered = Object.fromEntries(Object.entries(message).reverse()) as SwarmMessage
  const prepared = prepareMail({ ...raw, result: { ok: true, message: reordered } })
  assert.ok(prepared.result.ok)
  assert.notDeepEqual(Object.keys(prepared.result.message), Object.keys(message))
  await mkdir(out, { recursive: true })
  const ingest = { ...prepared, key: 'fixture-ingest', kind: 'ingest', v: 1, at: start, cycle: 1, tick: start, batchSize: 1 }
  await writeFile(join(out, 'decisions.jsonl'), JSON.stringify(ingest) + '\n')
  const archived = join(root, 'ordered.md')
  await rename(raw.file, archived)
  await runShadow(opts, start) // Complete the fixture's ingest without rescanning the archived file.
  await rename(archived, raw.file)
  const before = await text()

  const restarted = await createShadow(opts)
  try {
    const tick = await restarted.tick(start + 1)
    const added = (await records()).slice(2)
    assert.deepEqual(added.map((r) => 'reason' in r ? [r.kind, r.reason] : [r.kind]), [])
    assert.equal(tick.appended, 0)
    assert.equal(await text(), before)

    // A second delivery under another filename bypasses the file key and checks the payload fingerprint.
    await put('copied', { ...message, body: undefined }, start + 2)
    await restarted.tick(start + 2)
    assert.deepEqual((await records()).slice(2).map((r) => 'reason' in r ? [r.kind, r.reason] : [r.kind]),
      [['ingest'], ['duplicate']])
  } finally { await restarted.close() }
})

test('unknown retire, push and policy evidence never passes and is surfaced in the wake packet', async (t) => {
  const { opts, put, records } = await mailbox(t)
  const clean: RetireFacts = { headOnOrigin: true, cleanWorktree: true, noRunningSprite: true,
    noLiveClaim: true, approvedCompletion: true }
  const baseJob = { repo: tag, ref: 'moved', expectedBase: 'old', artifactDigest: 'digest', check: 'test' }
  const jobs = { job: (_tag: string, ref: string) => ref === 'moved' ? baseJob : undefined, base: () => 'new' }
  for (const [id, mailClass] of [['retire', 'sec.retire'], ['push', 'sec.push'], ['moved', 'sec.push'], ['policy', 'policy']] as const) {
    await put(id, { class: mailClass, urgency: 'p1' })
  }
  const packets: CasePacket[] = []
  await runShadow({ ...opts, jobs, evidence: { retire: { inspect: () => ({ mob: clean,
    sprites: [{ ...clean, noLiveClaim: 'unknown' }] }) } }, waker: { async wake(packet) {
    packets.push(packet)
    return { delivered: false, detail: 'test' }
  } } }, start + 10 * minute)
  assert.deepEqual((await records()).filter((r) => r.kind === 'verdict').map((r) => [r.id, r.action, r.reason, r.missing]), [
    ['moved', 'needs_spawner', 'base_moved', []], ['policy', 'hold', 'unknown', ['rollout_validation']],
    ['push', 'hold', 'hold_missing_job', ['job']], ['retire', 'hold', 'unknown', ['sprites.0.noLiveClaim']],
  ])
  assert.deepEqual(packets[0]?.act_on, ['moved', 'policy', 'push', 'retire'])
  assert.deepEqual(packets[0]?.missing, ['rollout_validation', 'job', 'sprites.0.noLiveClaim'])
})

test('retry is allowed once and only for a listed transient code', () => {
  const item = header('retry', { class: 'sec.retry' })
  const job = (repo: string, ref: string) => ({ repo, ref, expectedBase: 'base', artifactDigest: 'digest', check: 'test' })
  for (const [code, retries, action] of [
    ['ETIMEDOUT', 0, 'retry'], ['ETIMEDOUT', 1, 'needs_spawner'], ['EINVAL', 0, 'needs_spawner'],
  ] as const) assert.equal(handlePush(item, tag, { job, base: () => 'base', failure: () => ({ code, retries }) }).action,
    action, `${code}, retries: ${retries}`)
})

test('packet cap drops the lowest urgency and newest first', () => {
  const escaped = '\0'.repeat(200)
  const large = { ref: escaped, from: escaped, summary: escaped }
  const packet = compilePacket({ tag, lane: 'p1_batch', now: start, missing: ['job'], items: [
    header('quiet', { ...large, urgency: 'p3' }), header('old', large), header('middle', large),
    header('later', large), header('newest', large), header('urgent', { urgency: 'p0' }),
  ] })
  const serialized = JSON.stringify(packet)
  assert.ok(serialized.length <= 12_800)
  assert.deepEqual(packet.items.map(({ id }) => id), ['urgent', 'old', 'middle', 'later'])
  assert.equal(packet.omitted, 2)
  assert.deepEqual(packet.missing, ['job'])
})

test('scorecard does not report unknown ledger data or zero divisors as zero', async () => {
  const input = { tag, records: [], sinceMs: start, untilMs: start + minute }
  const unavailable = await scorecard({ ...input, ledger: unknownLedger })
  assert.deepEqual(unavailable, { tokens_per_merged_pr: 'unknown', wakes_per_day: 'unknown',
    tokens_per_wake: 'unknown', late_p0: 'unknown', late_p1: 'unknown', missed_p0: 'unknown', missed_p1: 'unknown' })
  const available = await scorecard({ ...input, ledger: { async tokens() { return 12 }, async mergedPrs() { return 0 } } })
  assert.equal(available.tokens_per_merged_pr, 'unknown')
  assert.equal(available.tokens_per_wake, 'unknown')
})

test('scorecard finds a late p1 and a missed p0 using receipt deadlines, not sender time', async (t) => {
  const { opts, put, records } = await mailbox(t)
  await put('late', { urgency: 'p1' })
  await put('timely', { urgency: 'p1' }, start + 2 * minute)
  const service = await createShadow(opts)
  t.after(() => service.close())
  await service.tick(start + 11 * minute)
  await put('missed', { urgency: 'p0' }, start + 12 * minute)
  await put('on-time', { urgency: 'p0' }, start + 14 * minute)
  await service.tick(start + 14 * minute)
  // Score an interrupted run with an accept but no forward for 'missed'.
  const log = (await records()).filter((r) => r.kind !== 'lane' || !r.items.some(({ id }) => id === 'missed'))
    .filter((r) => r.kind !== 'wake' || !r.ids.includes('missed'))
  const result = await scorecard({ records: log, ledger: unknownLedger, tag,
    sinceMs: start, untilMs: start + 16 * minute })
  assert.deepEqual([result.late_p0, result.late_p1, result.missed_p0, result.missed_p1], [0, 1, 1, 1])
})

test('mail content and evidence errors cannot leak credentials or bodies into any shadow record', async (t) => {
  const { opts, inbox, put, text, records, heartbeat } = await mailbox(t)
  const secret = 'ghp_fake_header_fixture'
  const evidenceSecret = 'ghp_fake_evidence_fixture'
  await put('alert', { class: 'sec.push', urgency: 'p0', from: `sprite ${secret}`,
    ref: `task ${secret}`, summary: `review ${secret}` })
  await writeFile(join(inbox, `${secret}.md`), body)
  const packets: CasePacket[] = []
  await runShadow({ ...opts, jobs: {
    job() { throw new Error(`${evidenceSecret}: ${body}`) }, base: () => 'unknown',
  }, waker: { async wake(packet) {
    packets.push(packet)
    return { delivered: false, detail: `token=${evidenceSecret}` }
  } } }, start + 30 * minute)
  const log = await records()
  for (const [label, serialized] of [
    ['journal', await text()], ['wake packet', JSON.stringify(packets)], ['heartbeat', JSON.stringify(await heartbeat())],
  ] as const) {
    assert.doesNotMatch(serialized, /ghp_fake_(?:header|evidence)_fixture|private body pointer fixture|"body"/, label)
  }
  assert.deepEqual(log.map((r) => r.kind).sort(), ['accept', 'digest', 'ingest', 'ingest', 'lane', 'notice', 'reject', 'verdict', 'wake'])
  assert.deepEqual(log.filter((r) => r.kind === 'verdict').map((r) => [r.id, r.action, r.reason, r.missing]),
    [['alert', 'hold', 'unknown', ['evidence']]])
  assert.equal(packets.length, 1)
  assert.equal(packets[0]?.items[0]?.summary, 'review [redacted]')
})

test('compilePacket strips raw bodies and redacts free text even before shadow sanitization', () => {
  const item = header('sk-fake-id-fixture', { urgency: 'p0', summary: 'review ghp_fake_summary_fixture',
    from: 'Bearer fake-from-fixture', ref: 'password=fake-ref-fixture' })
  const packet = compilePacket({ tag, lane: 'p0_now', now: start, items: [item], missing: ['token=fake-gap-fixture'] })
  assert.deepEqual(packet.items, [{ id: '[redacted]', class: item.class, urgency: item.urgency,
    from: 'Bearer [redacted]', ref: 'password=[redacted]', summary: 'review [redacted]', at: item.at }])
  assert.deepEqual(packet.act_on, ['[redacted]'])
  assert.deepEqual(packet.missing, ['token=[redacted]'])
})

test('restart forwards archived pending mail and rejects reuse of its ID', async (t) => {
  const { opts, inbox, put, records } = await mailbox(t)
  await put('pending', { urgency: 'p1', id: 'ghp_fake_archived' })
  await runShadow(opts, start)
  await rm(join(inbox, 'pending.md'))
  await put('collision', { id: 'ghp_fake_archived', ref: 'other', urgency: 'p0' }, start + minute)
  await runShadow(opts, start + 10 * minute)
  const log = await records()
  const rejects = log.flatMap((r) => r.kind === 'reject' ? [{ id: r.id, reason: r.reason }] : [])
  assert.deepEqual(rejects.map((r) => r.reason), ['id_collision'])
  assert.ok(rejects[0]?.id)
  assert.deepEqual(log.flatMap((r) => r.kind === 'notice' ? [[r.id, r.to, r.reason]] : []),
    [[rejects[0].id, 'sprite', 'id_collision']])
  assert.deepEqual(log.flatMap((r) => r.kind === 'wake' ? [r.lane] : []), ['p1_batch'])
})

test('restart rolls late mail into the next open digest window', async (t) => {
  const { opts, inbox, put, records } = await mailbox(t)
  await put('first')
  await runShadow(opts, start)
  await runShadow(opts, start + 30 * minute)
  await rm(join(inbox, 'first.md'))
  await put('late')
  await runShadow(opts, start + 31 * minute)
  await runShadow(opts, start + 60 * minute)
  assert.deepEqual((await records()).flatMap((r) => r.kind === 'digest' ? [r.act_on] : []), [['first'], ['late']])
})

test('recovery from only the ingest batch preserves the entire due tick', async (t) => {
  const { opts, inbox, out, put, text } = await mailbox(t)
  await put('a', { urgency: 'p1' })
  await put('b', { urgency: 'p1' })
  const now = start + 30 * minute
  await runShadow(opts, now)
  const uninterrupted = await text()
  const log = join(out, 'decisions.jsonl')
  await writeFile(log, uninterrupted.split('\n').filter((line) => line && JSON.parse(line).kind === 'ingest')
    .map((line) => line + '\n').join(''))
  await rm(inbox, { recursive: true })
  await runShadow(opts, now + minute)
  assert.equal(await text(), uninterrupted)
})

test('startup truncates a torn tail but refuses a corrupt complete line', async (t) => {
  const { opts, out, put, text } = await mailbox(t)
  await put('a')
  await runShadow(opts, start)
  const before = await text()
  const log = join(out, 'decisions.jsonl')
  await appendFile(log, '{"torn":"é')
  await runShadow(opts, start)
  assert.equal(await text(), before)
  await appendFile(log, '{broken}\n')
  await assert.rejects(createShadow(opts), SyntaxError)
  await writeFile(log, before)
  await runShadow(opts, start)
})

test('retry on the same instance rebuilds and records the failed tick wake', async (t) => {
  const { opts, root, out, inbox, put, records } = await mailbox(t)
  await put('alert', { urgency: 'p0' })
  const saved = join(root, 'saved')
  let first = true
  const service = await createShadow({ ...opts, waker: { async wake() {
    if (first) { first = false; await rename(out, saved) }
    return { delivered: true, detail: 'sent' }
  } } })
  try { await assert.rejects(service.tick(start), { code: 'ENOENT' }) }
  finally { await rename(saved, out) }
  await rm(join(inbox, 'alert.md'))
  await service.tick(start + 1)
  assert.deepEqual((await records()).flatMap((r) => r.kind === 'wake' ? [r.ids] : []), [['alert']])
  await service.close()
})

test('one journal writer excludes a live peer, releases on close and replaces a dead PID', async (t) => {
  const { opts, out } = await mailbox(t)
  const service = await createShadow(opts)
  await assert.rejects(createShadow(opts), { message: 'journal_locked' })
  await service.close()
  await (await createShadow(opts)).close()
  await writeFile(join(out, 'journal.lock'), '2147483647\n')
  const contenders = await Promise.allSettled([createShadow(opts), createShadow(opts)])
  const live = contenders.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  const refused = contenders.flatMap((result) => result.status === 'rejected' ? [result.reason.message] : [])
  assert.equal(live.length, 1)
  assert.deepEqual(refused, ['journal_locked'])
  assert.equal(Number(await readFile(join(out, 'journal.lock'), 'utf8')), process.pid)
  await live[0]!.close()
})

test('p0 waker sees the alert before job lookup and the verdict follows the receipt', async (t) => {
  const { opts, put, records } = await mailbox(t)
  await put('alert', { urgency: 'p0', class: 'sec.push' })
  let consulted = false
  const consultedAtWake: boolean[] = []
  await runShadow({ ...opts, jobs: { job() { consulted = true; return undefined }, base: () => 'unknown' },
    waker: { async wake() { consultedAtWake.push(consulted); return { delivered: true, detail: 'sent' } } } }, start)
  assert.deepEqual(consultedAtWake, [false])
  assert.deepEqual((await records()).flatMap((r) => r.kind === 'wake' || r.kind === 'verdict' ? [r.kind] : []), ['wake', 'verdict'])
})

test('oversized p0 fields are marked as truncated instead of dropping the alert', () => {
  const large = 'x'.repeat(13_000)
  const items = [header(large, { urgency: 'p0', from: large, ref: large, summary: large })]
  const packet = compilePacket({ tag, lane: 'p0_now', now: start, items })
  assert.equal(packet.items.length, 1)
  assert.equal(packet.omitted, 0)
  assert.ok(JSON.stringify(packet).length <= 12_800)
  for (const field of ['id', 'from', 'ref', 'summary'] as const) assert.match(packet.items[0]![field]!, /^x{199}…$/)
  const mixed = compilePacket({ tag, lane: 'p1_batch', now: start, missing: ['x'.repeat(12_000)], items: [
    ...items, header('also urgent', { urgency: 'p0', ref: large }),
  ] })
  assert.equal(mixed.items.length, 2)
  assert.ok(JSON.stringify(mixed).length <= 12_800)
})

test('rejects parent segments in either path before creating output', async (t) => {
  const { opts, root } = await mailbox(t)
  const inner = join(opts.mailDir, 'inner')
  const jump = join(root, 'jump')
  await mkdir(inner)
  await symlink(inner, jump)
  await assert.rejects(createShadow({ ...opts, outDir: `${jump}/../out` }), { message: 'parent_path_segment' })
  await assert.rejects(createShadow({ ...opts, mailDir: `${jump}/..` }), { message: 'parent_path_segment' })
  await assert.rejects(stat(opts.outDir), { code: 'ENOENT' })
})

test('handler looks up the original canonical ref, not its redacted alias', async (t) => {
  const { opts, inbox, put, records, text } = await mailbox(t)
  const ref = 'token=FAKE_ONLY'
  await put('push', { class: 'sec.push', urgency: 'p1', ref })
  const lookups: string[] = []
  const jobs = { job(_tag: string, lookup: string) {
    lookups.push(lookup)
    return lookup === ref ? undefined : { repo: tag, ref: lookup, expectedBase: 'base', artifactDigest: 'd', check: 'test' }
  }, base: () => 'base' }
  const service = await createShadow({ ...opts, jobs })
  await service.tick(start)
  await service.tick(start + 10 * minute)
  assert.deepEqual(lookups, [ref])
  assert.deepEqual((await records()).flatMap((r) => r.kind === 'verdict' ? [r.reason] : []), ['hold_missing_job'])
  const later = start + 20 * minute
  await put('archived', { class: 'sec.push', urgency: 'p1', ref: 'token=ARCHIVED_ONLY' }, later)
  await service.tick(later)
  await service.close()
  await rm(join(inbox, 'archived.md'))
  await runShadow({ ...opts, jobs }, later + 10 * minute)
  assert.deepEqual(lookups, [ref], 'replay cannot look up a redacted alias when the original is gone')
  assert.deepEqual((await records()).flatMap((r) => r.kind === 'verdict' ? [r.action] : []), ['hold', 'hold'])
  assert.doesNotMatch(await text(), /FAKE_ONLY|ARCHIVED_ONLY/)
})

test('retire holds on both a sprite hole and an explicit undefined observation', () => {
  const clean: RetireFacts = { headOnOrigin: true, cleanWorktree: true, noRunningSprite: true,
    noLiveClaim: true, approvedCompletion: true }
  const sprites = new Array<RetireFacts | undefined>(2)
  sprites[1] = undefined
  for (const observations of [sprites.slice(0, 1), sprites]) {
    const result = handleRetire(header('retire'), tag, { inspect: () => ({ mob: clean, sprites: observations }) })
    assert.equal(result.action, 'hold')
    assert.deepEqual(result.missing, Array.from(observations, (_, i) => `sprites.${i}`))
  }
})

test('wake receipts allowlist adapter text and log error names without messages', async (t) => {
  const { opts, put, records, text } = await mailbox(t)
  for (const id of ['allowed', 'diagnostic', 'throw']) await put(id, { urgency: 'p0' })
  await runShadow({ ...opts, waker: { async wake(packet) {
    const id = packet.items[0]?.id
    if (id === 'throw') throw Object.assign(new Error(body), { name: 'AdapterFailure' })
    return { delivered: false, detail: id === 'allowed' ? 'not delivered' : `${body} 123` }
  } } }, start)
  const details = (await records()).flatMap((r) => r.kind === 'wake' ? [r.detail] : [])
  assert.equal(details[0], 'not delivered')
  assert.match(details[1]!, /^[a-z_ ]{1,40}$/)
  assert.equal(details[2], 'error:AdapterFailure')
  assert.ok(!(await text()).includes(body))
})

test('scorecard reports unknown SLA for the unobserved urgency only', async (t) => {
  const { opts, put, records } = await mailbox(t)
  await put('alert', { urgency: 'p0' })
  await runShadow(opts, start)
  const result = await scorecard({ tag, records: await records(), ledger: unknownLedger, sinceMs: start, untilMs: start + minute })
  assert.deepEqual([result.late_p0, result.missed_p0, result.late_p1, result.missed_p1], [0, 0, 'unknown', 'unknown'])
})