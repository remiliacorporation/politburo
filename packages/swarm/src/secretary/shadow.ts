import { randomUUID } from 'node:crypto'
import { constants as fs } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { defaultConfig } from '../config/load.ts'
import { compareReceipt, readFileMail } from './filemail.ts'
import { handlePush, handleRetire, handleRolloutAck, type JobSource, type RetireEvidence, type RolloutLedger, type Verdict } from './handlers.ts'
import { hashKey as hash } from './hash.ts'
import { compilePacket } from './packet.ts'
import { redact } from './redact.ts'
import { createRouter, prepareMail, type Decision, type Digest, type Forward, type MailHeader, type PreparedMail, type RouterOptions } from './route.ts'
import { shadowWaker, wakeId, type Waker } from './wake.ts'

export type ShadowOptions = {
  mailDir: string; tag: string; outDir: string
  config?: Partial<RouterOptions> & { digest_minutes?: number }
  waker?: Waker; jobs?: JobSource
  evidence?: { retire?: RetireEvidence; rollout?: RolloutLedger }
}
export type TickSummary = { at: number; ingested: number; appended: number }
export type WakeReceipt = { wakeId: string; at: number; lane: Forward['lane']; ids: string[]; delivered: boolean; detail: string }
type Ingest = PreparedMail & { key: string; kind: 'ingest'; tick: number; batchSize: number }
type Notice = { key: string; kind: 'notice'; file: string; id?: string; to: string | null; reason: string;
  class: 'spawner.decide'; urgency: 'p2'; sent: false; detail: 'shadow: not sent' }
type Event = Ingest | Decision | Notice | (Forward & { kind: 'lane'; wakeId: string })
  | (Digest & { kind: 'digest' }) | (WakeReceipt & { key: string; kind: 'wake'; shadow: boolean })
  | (Verdict & { key: string; kind: 'verdict'; id: string; lane: Forward['lane'] })
export type DecisionRecord = Event & { v: 1; at: number; cycle: number }
type Tick = { at: number; cycle: number }

const noticeLimit = 200
const boundNoticeText = (text: string) => [...text].slice(0, noticeLimit).join('')
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code
function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

// Resolve existing ancestors before mkdir as well, so a refused new path leaves no directory in mail.
async function prospectivePath(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) {
    const parent = dirname(path)
    if (code(error) !== 'ENOENT' || parent === path) throw error
    return join(await prospectivePath(parent), basename(path))
  }
}

async function lockJournal(path: string) {
  for (;;) {
    const file = await open(path, 'wx', 0o600).catch((error: unknown) => {
      if (code(error) !== 'EEXIST') throw error
    })
    if (file) {
      try { await file.writeFile(`${process.pid}\n`) }
      catch (error) { await rm(path, { force: true }); throw error }
      finally { await file.close() }
      return () => rm(path, { force: true })
    }
    const holder = await open(path, fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK).catch((error: unknown) => {
      if (code(error) !== 'ENOENT') throw error
    })
    if (!holder) continue
    try {
      const info = await holder.stat()
      if (!info.isFile() || info.nlink !== 1) throw new Error('journal_locked')
      const pid = Number(await holder.readFile('utf8'))
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) throw new Error('journal_locked')
      try { process.kill(pid, 0) } catch (error) {
        if (code(error) === 'ESRCH') {
          // Serialize stale removal so two reclaimers cannot unlink a fresh writer's lock.
          const release = await lockJournal(`${path}.reclaim`)
          try {
            const current = await lstat(path).catch((error: unknown) => {
              if (code(error) !== 'ENOENT') throw error
            })
            if (current?.ino === info.ino && current.dev === info.dev) await rm(path, { force: true })
          } finally { await release() }
          continue
        }
      }
      throw new Error('journal_locked')
    } finally { await holder.close() }
  }
}

function wakeError(error: unknown) {
  const name = code(error) ?? (error instanceof Error ? error.name : undefined)
  const safe = typeof name === 'string' ? redact(name).slice(0, 40) : ''
  return `error:${/^[a-z0-9_[\]-]+$/i.test(safe) ? safe : 'Error'}`
}

export async function createShadow({ mailDir, tag, outDir, config, waker = shadowWaker, jobs, evidence }: ShadowOptions) {
  if (!tag || tag !== basename(tag) || tag === '.' || tag === '..') throw new Error('bad_tag')
  if ([mailDir, outDir].some((path) => (sep === '\\' ? path.split(/[\\/]/) : path.split(sep)).includes('..'))) {
    throw new Error('parent_path_segment')
  }
  const mail = await realpath(mailDir)
  function check(out: string) {
    if (contains(mail, out)) throw new Error('out_dir_inside_mail')
    if (contains(out, mail)) throw new Error('mail_dir_inside_out')
  }
  const target = await prospectivePath(outDir)
  check(target)
  await mkdir(target, { recursive: true })
  const out = await realpath(target)
  check(out)
  const dir = join(out, tag)
  await mkdir(dir, { recursive: true })
  if (await realpath(dir) !== dir) throw new Error('unsafe_output_path')
  const log = join(dir, 'decisions.jsonl')
  async function withLog<T>(flags: number, use: (file: Awaited<ReturnType<typeof open>>) => Promise<T>) {
    const file = await open(log, flags | fs.O_NOFOLLOW | fs.O_NONBLOCK, 0o600)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1) throw new Error('unsafe_output_log')
      return await use(file)
    } finally { await file.close() }
  }
  async function readJournal() {
    return withLog(fs.O_RDWR, async (file) => {
      const bytes = await file.readFile()
      let end = bytes.lastIndexOf(10) + 1
      const lines = bytes.subarray(0, end).toString('utf8').split('\n')
      lines.pop()
      const records = lines.map((line) => JSON.parse(line) as DecisionRecord)
      // A short write can leave complete ingest lines at the tail, but not a whole batch.
      const last = records.at(-1)
      if (last?.kind === 'ingest') {
        let count = 0
        for (let i = records.length - 1; i >= 0 && records[i]?.cycle === last.cycle && records[i]?.kind === 'ingest'; i--) count++
        if (count < last.batchSize) {
          records.splice(-count)
          for (const line of lines.splice(-count)) end -= Buffer.byteLength(line) + 1
        }
      }
      if (end !== bytes.length) await file.truncate(end)
      return records
    }).catch((error: unknown) => {
      if (code(error) === 'ENOENT') return []
      throw error
    })
  }
  const defaults = defaultConfig().mail
  const classes = [...(config?.classes ?? defaults.classes)]
  const routerOptions = { classes, digestMinutes: config?.digestMinutes ?? config?.digest_minutes ?? defaults.digest_minutes,
    p1Minutes: config?.p1Minutes ?? 10, p0Seconds: config?.p0Seconds ?? 60 }
  const originals = new Map<string, MailHeader>()

  function advance(state: { router: ReturnType<typeof createRouter>; redactedEvidence: Map<string, string> },
    items: PreparedMail[], tick: Tick) {
    items.sort(compareReceipt)
    const decisions = state.router.ingest(items, tick.at)
    const notices: Notice[] = []
    const offset = decisions.length - items.length
    for (const [i, item] of items.entries()) {
      const decision = decisions[offset + i]!
      if (decision.kind === 'reject') {
        const { key, file, id, reason, header } = decision
        const to = item.result.ok ? header?.from : item.result.from
        // Prepared mail and decisions already redact these fields. Keep the filename end for diff.
        notices.push({ key: hash('notice', key), kind: 'notice', file: [...file].slice(-noticeLimit).join(''),
          ...(id !== undefined && { id: boundNoticeText(id) }), to: to === undefined ? null : boundNoticeText(to),
          class: 'spawner.decide', urgency: 'p2', reason: boundNoticeText(reason!), sent: false, detail: 'shadow: not sent' })
      }
      if ((decision.kind === 'accept' || decision.kind === 'revision') && item.identity?.redactedEvidence) {
        state.redactedEvidence.set(decision.id!, item.fileKey)
      }
    }
    const due = state.router.due(tick.at)
    decisions.push(...state.router.ingest([], tick.at))
    return { ...tick, ...due, decisions, notices }
  }

  async function rebuild() {
    const history = await readJournal()
    const router = createRouter(routerOptions, tag)
    const redactedEvidence = new Map<string, string>()
    const seen = new Set<string>()
    const keys = new Set(history.map(({ key }) => key))
    const ticks = new Map<number, Tick & { items: Ingest[] }>()
    for (const record of history) {
      const tick = ticks.get(record.cycle) ?? { at: record.at, cycle: record.cycle, items: [] }
      ticks.set(record.cycle, tick)
      if (record.kind === 'ingest') {
        tick.at = record.tick
        tick.items.push(record)
        seen.add(record.fileKey)
      }
    }
    const replay = [...ticks.values()].sort((a, b) => a.cycle - b.cycle)
    const recovered = replay.map(({ items, ...tick }) => {
      const result = advance({ router, redactedEvidence }, items, tick)
      // Replay always advances state; keep only work still missing from the journal.
      return { ...result, decisions: result.decisions.filter(({ key }) => !keys.has(key)),
        notices: result.notices.filter(({ key }) => !keys.has(key)),
        p0: result.p0.filter(laneNeedsWork), p1: result.p1.filter(laneNeedsWork),
        digests: result.digests.filter(({ key }) => !keys.has(key)) }
    }).filter((r) => r.decisions.length || r.notices.length || r.p0.length || r.p1.length || r.digests.length)
    function laneNeedsWork(lane: Forward) {
      const id = wakeId(tag, lane.lane, lane.items.map(({ id }) => id), lane.key)
      return !keys.has(hash('wake', id)) || lane.items.some((item) =>
        hasHandler(item) && !keys.has(hash('verdict', lane.key, item.id)))
    }
    return { router, redactedEvidence, seen, keys, recovered, cycle: replay.at(-1)?.cycle ?? 0 }
  }

  function hasHandler(item: MailHeader) {
    return ['sec.push', 'sec.retry', 'sec.retire', 'policy'].includes(item.class)
  }

  function verdict(item: MailHeader): Verdict | undefined {
    if (!hasHandler(item)) return
    const originalKey = state.redactedEvidence.get(item.id)
    if (originalKey) {
      const original = originals.get(originalKey)
      // A cold restart cannot recover a redacted credential from archived mail. Never query its alias.
      if (!original) return { action: 'hold', reason: 'unknown', missing: ['evidence'] }
      item = original
    }
    try {
      switch (item.class) {
        case 'sec.push': case 'sec.retry': return handlePush(item, tag, jobs)
        case 'sec.retire': return handleRetire(item, tag, evidence?.retire)
        case 'policy': return handleRolloutAck(item, tag, evidence?.rollout)
      }
    } catch {
      return { action: 'hold', reason: 'unknown', missing: ['evidence'] }
    }
  }

  const unlock = await lockJournal(join(dir, 'journal.lock'))
  let state: Awaited<ReturnType<typeof rebuild>>
  try { state = await rebuild() }
  catch (error) { await unlock(); throw error }

  async function tick(now: number): Promise<TickSummary> {
    if (!Number.isFinite(now)) throw new Error('bad_tick_time')
    const current = { at: now, cycle: ++state.cycle }
    let appended = 0
    async function append(events: Event[], { at, cycle }: Tick) {
      const fresh = events.filter(({ key }) => !state.keys.has(key))
      if (!fresh.length) return
      const bytes = Buffer.from(fresh.map((event) => JSON.stringify({ ...event, v: 1, at, cycle }) + '\n').join(''))
      await withLog(fs.O_WRONLY | fs.O_APPEND | fs.O_CREAT, async (file) => {
        const { bytesWritten } = await file.write(bytes)
        if (bytesWritten !== bytes.length) throw new Error('short_journal_write')
        await file.sync()
      })
      for (const event of fresh) state.keys.add(event.key)
      appended += fresh.length
    }
    const fresh: PreparedMail[] = []
    for (const raw of await readFileMail(mail, tag, { classes })) {
      const item = prepareMail(raw)
      if (item.identity?.redactedEvidence && raw.result.ok) {
        const { id, class: mailClass, urgency, from, ref, summary, at } = raw.result.message
        originals.set(item.fileKey, { id, class: mailClass, urgency, from, ref, summary, at })
      }
      if (!state.seen.has(item.fileKey)) fresh.push(item)
    }
    await append(fresh.map((item) => ({ ...item, kind: 'ingest', key: hash('ingest', item.fileKey),
      tick: now, batchSize: fresh.length })), current)
    for (const { fileKey } of fresh) state.seen.add(fileKey)
    const ticks = [...state.recovered, advance(state, fresh, current)]
    for (const frame of ticks) await append([...frame.decisions, ...frame.notices], frame)

    async function forward(lane: Forward, frame: Tick) {
      const ids = lane.items.map(({ id }) => id)
      const id = wakeId(tag, lane.lane, ids, lane.key)
      const key = hash('wake', id)
      await append([{ ...lane, kind: 'lane', wakeId: id }], frame)
      const missing: string[] = []
      const act_on: string[] = lane.items.filter((item) =>
        item.class.startsWith('spawner.') || item.class === 'core.escalate').map(({ id }) => id)
      async function evaluate() {
        for (const item of lane.items) {
          const key = hash('verdict', lane.key, item.id)
          if (lane.lane === 'p0_now' && state.keys.has(key)) continue
          const result = verdict(item)
          if (!result) continue
          await append([{ ...result, key, kind: 'verdict', id: item.id, lane: lane.lane }], frame)
          missing.push(...result.missing)
          if (result.action === 'hold' || result.action === 'needs_spawner') act_on.push(item.id)
        }
      }
      if (lane.lane !== 'p0_now') await evaluate()
      if (!state.keys.has(key)) {
        let receipt: Awaited<ReturnType<Waker['wake']>>
        try {
          receipt = await waker.wake(compilePacket({ ...lane, tag, now: frame.at, missing, act_on, generation: lane.key }))
          const { delivered, detail } = receipt
          receipt = { delivered, detail: detail === 'shadow: not sent' || (typeof detail === 'string'
            && /^[a-z_ ]{1,40}$/.test(detail)) ? detail : 'detail_omitted' }
        } catch (error) { receipt = { delivered: false, detail: wakeError(error) } }
        await append([{ kind: 'wake', key, wakeId: id, lane: lane.lane, ids, at: frame.at,
          delivered: receipt.delivered === true, detail: receipt.detail, shadow: waker === shadowWaker }], frame)
      }
      if (lane.lane === 'p0_now') await evaluate()
    }
    for (const priority of ['p0', 'p1'] as const) {
      for (const frame of ticks) for (const lane of frame[priority]) await forward(lane, frame)
    }
    for (const frame of ticks) await append(frame.digests.map((digest) => ({ ...digest, kind: 'digest' })), frame)
    state.recovered = []
    const summary = { at: now, ingested: fresh.length, appended }
    const temp = join(dir, `.heartbeat-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(summary) + '\n', { flag: 'wx', mode: 0o600 })
    try { await rename(temp, join(dir, 'heartbeat.json')) } finally { await rm(temp, { force: true }) }
    return summary
  }

  // Both ticks and release wait for the preceding tick to settle.
  let tail: Promise<unknown> = Promise.resolve()
  let failed = false
  let closing: Promise<void> | undefined
  return {
    tick(now: number) {
      if (closing) return Promise.reject(new Error('journal_closed'))
      const next = tail.then(async () => {
        if (failed) state = await rebuild()
        return tick(now)
      })
      tail = next.then(() => { failed = false }, () => { failed = true })
      return next
    },
    close() { return closing ??= tail.then(unlock) },
  }
}

export async function runShadow(opts: ShadowOptions, now: number): Promise<TickSummary> {
  const service = await createShadow(opts)
  try { return await service.tick(now) } finally { await service.close() }
}
