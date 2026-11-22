import { createHash, randomUUID } from 'node:crypto'
import { constants as fs } from 'node:fs'
import { mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { defaultConfig } from '../config/load.ts'
import { readFileMail, type FileMailItem } from './filemail.ts'
import { handlePush, handleRetire, handleRolloutAck, type JobSource, type RetireEvidence, type RolloutLedger, type Verdict } from './handlers.ts'
import { compilePacket } from './packet.ts'
import { redact } from './redact.ts'
import { createRouter, type Decision, type Digest, type Forward, type MailHeader, type RouterOptions } from './route.ts'
import { shadowWaker, wakeId, type Waker } from './wake.ts'

export type ShadowOptions = {
  mailDir: string; tag: string; outDir: string
  config?: Partial<RouterOptions> & { digest_minutes?: number }
  waker?: Waker; jobs?: JobSource
  evidence?: { retire?: RetireEvidence; rollout?: RolloutLedger }
}
export type TickSummary = { at: number; ingested: number; appended: number }
export type WakeReceipt = { wakeId: string; at: number; lane: Forward['lane']; ids: string[]; delivered: boolean; detail: string }
type Event = (Decision & { snapshot?: string }) | (Forward & { kind: 'lane'; wakeId: string })
  | (Digest & { kind: 'digest' }) | (WakeReceipt & { key: string; kind: 'wake'; shadow: boolean })
  | (Verdict & { key: string; kind: 'verdict'; id: string; lane: Forward['lane'] })
export type DecisionRecord = Event & { v: 1; at: number; cycle: number }

const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

// Resolve existing ancestors before mkdir as well, so a refused new path leaves no directory in mail.
async function prospectivePath(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) {
    if (!absent(error) || dirname(path) === path) throw error
    return join(await prospectivePath(dirname(path)), basename(path))
  }
}

export async function createShadow({ mailDir, tag, outDir, config, waker = shadowWaker, jobs, evidence }: ShadowOptions) {
  if (!tag || tag !== basename(tag) || tag === '.' || tag === '..') throw new Error('bad_tag')
  const mail = await realpath(mailDir)
  function check(out: string) {
    if (contains(mail, out)) throw new Error('out_dir_inside_mail')
    if (contains(out, mail)) throw new Error('mail_dir_inside_out')
  }
  const target = await prospectivePath(resolve(outDir))
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
  const old = await withLog(fs.O_RDONLY, (file) => file.readFile('utf8')).catch((error: unknown) => {
    if (absent(error)) return ''
    throw error
  })
  const history = old.split('\n').filter(Boolean).map((line) => JSON.parse(line) as DecisionRecord)
  const keys = new Set(history.map(({ key }) => key))
  const digested = new Set(history.flatMap((r) => r.kind === 'digest' ? [r.batch] : []))
  const forwarded = new Set(history.flatMap((r) => r.kind === 'lane' ? r.items.map(({ id }) => id) : []))
  const defaults = defaultConfig().mail
  const classes = [...(config?.classes ?? defaults.classes)]
  const router = createRouter({ classes, digestMinutes: config?.digestMinutes ?? config?.digest_minutes ?? defaults.digest_minutes,
    p1Minutes: config?.p1Minutes ?? 10, p0Seconds: config?.p0Seconds ?? 60 })
  const seen = new Set<string>()
  let cycle = history.at(-1)?.cycle ?? 0

  function verdict(item: MailHeader): Verdict | undefined {
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

  async function tick(now: number): Promise<TickSummary> {
    if (!Number.isFinite(now)) throw new Error('bad_tick_time')
    // Slice A exposes the parsed result rather than stat size. Fingerprint the observed version.
    const files = new Map((await readFileMail(mail, tag, { classes })).map((item) =>
      [hash(item.file, item.receivedAt, item.result), item]))
    const recovered: ReturnType<typeof router.due> = { p0: [], p1: [], digests: [] }
    if (history.length) {
      // Rebuild state at original tick boundaries, rather than rebatching old mail at restart time.
      const ticks = new Map<number, { at: number; items: FileMailItem[] }>()
      for (const record of history) {
        const tick = ticks.get(record.cycle) ?? { at: record.at, items: [] }
        ticks.set(record.cycle, tick)
        if ('snapshot' in record && record.snapshot && files.has(record.snapshot)) {
          tick.items.push(files.get(record.snapshot)!)
          seen.add(record.snapshot)
        }
      }
      for (const { at, items } of ticks.values()) {
        router.ingest(items, at)
        // Replaying due() advances the router even if a crash prevented the append.
        const due = router.due(at)
        recovered.p0.push(...due.p0.filter(({ key }) => !keys.has(key)))
        recovered.p1.push(...due.p1.filter(({ key }) => !keys.has(key)))
        recovered.digests.push(...due.digests.filter(({ key }) => !keys.has(key)))
      }
    }
    cycle++
    let appended = 0
    async function append(event: Event) {
      if (keys.has(event.key)) return
      await withLog(fs.O_WRONLY | fs.O_APPEND | fs.O_CREAT, (file) =>
        file.appendFile(JSON.stringify({ ...event, v: 1, at: now, cycle }) + '\n'))
      keys.add(event.key)
      appended++
    }
    const fresh = [...files].filter(([key]) => !seen.has(key))
    const decisions = router.ingest(fresh.map(([, item]) => item), now)
    // The router emits pending expirations first, followed by one decision per input in receipt order.
    const offset = decisions.length - fresh.length
    for (const [i, decision] of decisions.entries()) await append({ ...decision, snapshot: fresh[i - offset]?.[0] })
    for (const [key] of fresh) seen.add(key)
    const due = router.due(now)
    for (const decision of router.ingest([], now)) await append(decision)

    async function forward(lane: Forward) {
      const ids = lane.items.map(({ id }) => id)
      const id = wakeId(tag, lane.lane, ids, lane.key)
      const key = hash('wake', id)
      if (keys.has(key)) return
      await append({ ...lane, kind: 'lane', wakeId: id })
      const missing: string[] = []
      const act_on: string[] = []
      for (const item of lane.items) {
        const result = verdict(item)
        if (result) {
          await append({ ...result, key: hash('verdict', lane.key, item.id), kind: 'verdict', id: item.id, lane: lane.lane })
          missing.push(...result.missing)
        }
        if (result?.action === 'hold' || result?.action === 'needs_spawner'
          || item.class.startsWith('spawner.') || item.class === 'core.escalate') act_on.push(item.id)
      }
      let receipt: Awaited<ReturnType<Waker['wake']>>
      try { receipt = await waker.wake(compilePacket({ ...lane, tag, now, missing, act_on, generation: lane.key })) }
      catch (error) {
        const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : 'wake failed'
        receipt = { delivered: false, detail }
      }
      await append({ kind: 'wake', key, wakeId: id, lane: lane.lane, ids, at: now,
        delivered: receipt.delivered === true, detail: redact(receipt.detail), shadow: waker === shadowWaker })
    }
    // Finish an interrupted lane using the same wake ID before handling new lanes of that priority.
    for (const [priority, laneKey] of [['p0_now', 'p0'], ['p1_batch', 'p1']] as const) {
      for (const record of history) if (record.kind === 'lane' && record.lane === priority) await forward(record)
      for (const lane of [...recovered[laneKey], ...due[laneKey]]) {
        const items = lane.items.filter(({ id }) => !forwarded.has(id))
        if (items.length) await forward(items.length === lane.items.length ? lane
          : { ...lane, items, key: hash(lane.key, items.map(({ id }) => id)) })
      }
    }
    history.length = 0
    for (const digest of [...recovered.digests, ...due.digests]) {
      // A replay with fewer surviving input files can produce a different key for the same batch.
      if (digested.has(digest.batch)) continue
      await append({ ...digest, kind: 'digest' })
      digested.add(digest.batch)
    }
    const summary = { at: now, ingested: fresh.length, appended }
    const temp = join(dir, `.heartbeat-${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(summary) + '\n', { flag: 'wx', mode: 0o600 })
    try { await rename(temp, join(dir, 'heartbeat.json')) } finally { await rm(temp, { force: true }) }
    return summary
  }

  // Ticks on one instance share router state and run in call order.
  let tail: Promise<unknown> = Promise.resolve()
  return { tick(now: number) {
    const next = tail.then(() => tick(now))
    tail = next.catch(() => {})
    return next
  } }
}

export async function runShadow(opts: ShadowOptions, now: number): Promise<TickSummary> {
  return (await createShadow(opts)).tick(now)
}
