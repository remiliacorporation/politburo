import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  compilePacket, createShadow, handlePush, runShadow, scorecard, unknownLedger,
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
  await put('missing-ref', { ref: undefined, urgency: 'p0' })
  await runShadow(opts, start + 30 * minute)
  assert.deepEqual((await records()).map((r) => [r.kind,
    'file' in r && basename(r.file), 'reason' in r && r.reason]).sort(), [
    ['reject', 'missing-ref.md', 'missing_field:ref'], ['reject', 'no-header.md', 'no_header'],
  ])
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
  await service.tick(now)
  assert.deepEqual(packets.map((p) => [p.lane, p.items.map(({ id }) => id)]), [
    ['p0_now', ['first-p0']], ['p0_now', ['next-p0']],
  ])
  const log = await records()
  assert.deepEqual(log.filter((r) => r.kind === 'lane').map((r) => r.at), [now, now])
  assert.deepEqual(log.filter((r) => r.kind === 'wake').map((r) => [r.ids, r.delivered, r.detail]), [
    [['first-p0'], false, 'wake failed: [redacted]'], [['next-p0'], true, 'sent'],
  ])
  const sla = await scorecard({ records: log, ledger: unknownLedger, tag, sinceMs: start, untilMs: now + 2 * minute })
  assert.equal(sla.late_p0, 0)
  assert.equal(sla.missed_p0, 1, 'an on-time decision with only a failed real wake is missed')
  await service.tick(start + 10 * minute)
  assert.deepEqual(packets.filter((p) => p.lane === 'p1_batch').map((p) => p.items.map(({ id }) => id)), [['pending']])
})

test('restart after a thrown wake before receipt append finishes every forward exactly once', async (t) => {
  const { opts, root, out, put, records, text } = await mailbox(t)
  await put('first', { urgency: 'p0' })
  await put('second', { urgency: 'p0' })
  const saved = join(root, 'interrupted-output')
  const packets: CasePacket[] = []
  const interrupted = await createShadow({ ...opts, waker: { async wake(packet) {
    packets.push(packet)
    // A thrown waker alone is recoverable and normally logs a failure receipt.
    // Move the journal out of reach to also simulate process loss before that write.
    await rename(out, saved)
    throw new Error('interrupted wake')
  } } })
  const now = start + 30 * minute
  try { await assert.rejects(interrupted.tick(now), { code: 'ENOENT' }) }
  finally { await rename(saved, out) }
  const before = await text()
  const partial = await records()
  assert.deepEqual(partial.flatMap((r) => r.kind === 'accept' ? [r.id] : []), ['first', 'second'])
  assert.deepEqual(partial.filter((r) => r.kind === 'lane').flatMap((r) => r.items.map(({ id }) => id)), ['first'])
  assert.equal(partial.filter((r) => r.kind === 'wake').length, 0)

  const options = { ...opts, waker: { async wake(packet: CasePacket) {
    packets.push(packet)
    return { delivered: true, detail: 'sent' }
  } } }
  await (await createShadow(options)).tick(now + 1)
  const log = await records()
  const lanes = log.filter((r) => r.kind === 'lane')
  assert.deepEqual(lanes.map((r) => r.items.map(({ id }) => id)), [['first'], ['second']])
  assert.deepEqual(log.filter((r) => r.kind === 'wake').map((r) => [r.wakeId, r.ids, r.delivered]),
    lanes.map((r) => [r.wakeId, r.items.map(({ id }) => id), true]))
  assert.deepEqual(packets.map((p) => p.packetId), [lanes[0]?.wakeId, lanes[0]?.wakeId, lanes[1]?.wakeId])
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
  await runShadow(options, start + 32 * minute)
  // The reader may no longer see all the mail that went into a completed digest.
  await rm(join(inbox, 'first.md'))
  await runShadow(options, start + 33 * minute)
  assert.equal(await text(), before)
  assert.deepEqual(wakes.map((p) => p.packetId), calls)
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
  const job = () => ({ repo: tag, ref: item.ref, expectedBase: 'base', artifactDigest: 'digest', check: 'test' })
  for (const [code, retries, action] of [
    ['ETIMEDOUT', 0, 'retry'], ['ETIMEDOUT', 1, 'needs_spawner'], ['EINVAL', 0, 'needs_spawner'],
  ] as const) assert.equal(handlePush(item, tag, { job, base: () => 'base', failure: () => ({ code, retries }) }).action,
    action, `${code}, retries: ${retries}`)
})

test('packet cap drops the lowest urgency and newest first', () => {
  const large = { ref: 'x'.repeat(5_000) }
  const packet = compilePacket({ tag, lane: 'p1_batch', now: start, missing: ['job'], items: [
    header('quiet', { ...large, urgency: 'p3' }), header('old', large),
    header('new', large), header('urgent', { ...large, urgency: 'p0' }),
  ] })
  const serialized = JSON.stringify(packet)
  assert.ok(serialized.length <= 12_800)
  assert.deepEqual(packet.items.map(({ id }) => id), ['urgent', 'old'])
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
  assert.deepEqual(log.map((r) => r.kind).sort(), ['accept', 'digest', 'lane', 'reject', 'verdict', 'wake'])
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
