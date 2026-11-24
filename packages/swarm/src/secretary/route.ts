import { createHash } from 'node:crypto'
import { compareReceipt, fileMailTag, type FileMailItem } from './filemail.ts'
import { hashKey as key } from './hash.ts'
import { parseHeader, type SwarmMessage, type Urgency } from './message.ts'
import { redact } from './redact.ts'

export type Lane = 'p0_now' | 'p1_batch' | 'digest'
export type MailHeader = Pick<SwarmMessage, 'id' | 'class' | 'urgency' | 'from' | 'ref' | 'summary' | 'at'>

export type Decision = {
  key: string
  kind: 'accept' | 'reject' | 'duplicate' | 'revision' | 'expire'
  file: string
  receivedAt: number
  reason?: string
  id?: string
  header?: MailHeader
  lane?: Lane
}

export type Forward = {
  key: string
  lane: Exclude<Lane, 'digest'>
  dueAt: number
  deadline: number
  items: MailHeader[]
}

export type Digest = {
  key: string
  batch: string
  repo: string
  window: { from: string; to: string }
  counts: Record<Urgency, number>
  act_on: string[]
  items: ((MailHeader & { forwarded?: true }) | { summary: string })[]
}

export type RouterOptions = { classes: string[]; digestMinutes: number; p1Minutes: number; p0Seconds: number }

type Entry = {
  file: string
  receivedAt: number
  header: MailHeader
  decision: Decision
  expires: number
  digestStart: number
  digestPending: boolean
  forwardPending: boolean
  forwarded: boolean
  logOnly: boolean
  needsAction: boolean
}

export function route<T extends Pick<SwarmMessage, 'urgency'>>(header: T): Lane {
  if (header.urgency === 'p0') return 'p0_now'
  if (header.urgency === 'p1') return 'p1_batch'
  return 'digest'
}

function safeHeader({ id, class: mailClass, urgency, from, ref, summary, at }: SwarmMessage): MailHeader {
  const safeId = redact(id) === id ? id : `[redacted:${createHash('sha256').update(id).digest('hex').slice(0, 8)}]`
  return { id: safeId, class: redact(mailClass), urgency, from: redact(from),
    ...(ref !== undefined && { ref: redact(ref) }), summary: redact(summary), at }
}

// Dedupe uses the original canonical header, even when its persisted display fields collide.
export type PreparedMail = FileMailItem & {
  fileKey: string
  identity?: { id: string; tuple?: string; payload: string; redactedEvidence: boolean }
}

export function prepareMail({ file, receivedAt, result }: FileMailItem): PreparedMail {
  // The sender claim is for the notice, not part of the existing rejection identity.
  const fingerprint = result.ok ? result : { ok: false, reason: result.reason }
  const item = { file: redact(file), receivedAt, fileKey: key(file, receivedAt, fingerprint) }
  if (!result.ok) return { ...item, result: { ok: false, reason: redact(result.reason),
    ...(result.from !== undefined && { from: redact(result.from) }) } }
  const message = result.message
  const header = safeHeader(message)
  return { ...item, result: { ok: true, message: { ...header, ...(message.expires && { expires: message.expires }) } },
    identity: { id: key(message.id), payload: key(message),
      redactedEvidence: header.id !== message.id || header.ref !== message.ref,
      ...(message.ref !== undefined && { tuple: key(message.from, message.ref, message.class) }) } }
}

function digest(batchKey: string, repo: string, start: number, end: number, entries: Entry[]): Digest {
  entries.sort((a, b) => a.header.urgency.localeCompare(b.header.urgency) || compareReceipt(a, b))
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 }
  const act_on: string[] = []
  const items: Digest['items'] = []
  for (const entry of entries) {
    const { header, forwarded } = entry
    counts[header.urgency]++
    if (entry.logOnly) continue
    if (entry.needsAction) act_on.push(header.id)
    items.push(header.urgency === 'p3' ? { summary: header.summary }
      : forwarded ? { ...header, forwarded: true } : { ...header })
  }
  const from = new Date(start).toISOString()
  const to = new Date(end).toISOString()
  const digestKey = key(batchKey, entries.map(({ header }) => header.id).sort())
  return { key: digestKey, batch: `${repo}-${to}`, repo, window: { from, to }, counts, act_on, items }
}

export function createRouter(opts: RouterOptions, repo?: string) {
  const classes = [...opts.classes]
  const digestMs = opts.digestMinutes * 60_000
  const p1Ms = opts.p1Minutes * 60_000
  const p0Ms = opts.p0Seconds * 1_000
  if (!Number.isFinite(digestMs) || digestMs <= 0) throw new Error('bad_digest_minutes')

  const ids = new Map<string, string>()
  const latest = new Map<string, Entry>()
  const pending = new Set<Entry>()
  const emitted = new Set<string>()
  let expirations: Decision[] = []

  function prune(entry: Entry) {
    if (!entry.digestPending && !entry.forwardPending) pending.delete(entry)
  }

  function expire(entry: Entry): Decision {
    entry.digestPending = false
    prune(entry)
    return { ...entry.decision, key: key('expire', entry.decision.key), kind: 'expire', reason: 'expired', header: { ...entry.header } }
  }

  function expirePending(now: number) {
    for (const entry of pending) {
      if (entry.digestPending && entry.expires <= now) expirations.push(expire(entry))
    }
  }

  function ingestOne(item: FileMailItem | PreparedMail, now: number): Decision {
    const { file, receivedAt, result } = item
    const prepared = 'fileKey' in item ? item : undefined
    const parsed = !prepared && result.ok ? parseHeader(result.message, { classes }) : result
    const fingerprint = prepared?.identity?.payload ?? (parsed.ok ? key(parsed.message) : undefined)
    const header = parsed.ok ? safeHeader(parsed.message) : undefined
    const record = (kind: Decision['kind'], reason?: string): Decision => ({
      key: key(kind, prepared?.fileKey ?? file, receivedAt, fingerprint, reason),
      kind, file: redact(file), receivedAt,
      ...(header && { id: header.id, header: { ...header }, lane: route(header) }),
      ...(reason !== undefined && { reason: redact(reason) }),
    })
    if (!parsed.ok) return record('reject', parsed.reason)
    const { message } = parsed

    const id = prepared?.identity?.id ?? key(message.id)
    const seen = ids.get(id)
    if (seen !== undefined) return seen === fingerprint! ? record('duplicate') : record('reject', 'id_collision')
    ids.set(id, fingerprint!)
    const tuple = prepared?.identity ? prepared.identity.tuple
      : message.ref !== undefined ? key(message.from, message.ref, message.class) : undefined
    const previous = tuple !== undefined ? latest.get(tuple) : undefined
    const order = previous ? Date.parse(message.at) - Date.parse(previous.header.at) : 1
    const newer = order > 0 || (order === 0 && message.urgency !== 'p0')
    if (message.urgency !== 'p0') {
      if (order < 0) return record('reject', 'older_at')
      if (previous && order === 0) {
        const urgency = message.urgency.localeCompare(previous.header.urgency)
        if (urgency > 0) return record('reject', 'less_urgent_same_at')
        if (urgency === 0 && compareReceipt(item, previous) < 0) return record('reject', 'older_receipt_same_at')
      }
    }
    const decision = record(previous ? 'revision' : 'accept')
    const receiptStart = Math.floor(receivedAt / digestMs) * digestMs
    const receiptWindow = key('digest', repo ?? fileMailTag(file), receiptStart, receiptStart + digestMs)
    // Once emitted, a receipt window stays closed. Pin late mail to the window open at ingest.
    const digestStart = emitted.has(receiptWindow) ? Math.floor(now / digestMs) * digestMs : receiptStart
    const entry: Entry = {
      file, receivedAt, header: header!, decision: { ...decision },
      expires: message.expires ? Date.parse(message.expires) : Infinity,
      digestStart, digestPending: true, forwardPending: message.urgency === 'p0' || message.urgency === 'p1',
      forwarded: false, logOnly: message.class === 'sec.log',
      needsAction: message.class.startsWith('spawner.') || message.class === 'core.escalate',
    }
    if (entry.expires <= now) return expire(entry)
    if (newer) {
      // A valid p0 is never held back, even by a revision before the next tick.
      if (previous && previous.header.urgency !== 'p0' && !previous.forwarded) {
        previous.forwardPending = false
        previous.digestPending = false
        prune(previous)
      }
      if (tuple !== undefined) latest.set(tuple, entry)
    }
    pending.add(entry)
    return decision
  }

  function ingest(items: readonly (FileMailItem | PreparedMail)[], now: number): Decision[] {
    // Expirations discovered by due() are returned here, including on an empty ingest.
    expirePending(now)
    const decisions = expirations
    expirations = []
    for (const item of [...items].sort(compareReceipt)) decisions.push(ingestOne(item, now))
    return decisions
  }

  function forward(lane: Forward['lane'], entries: Entry[]): Forward {
    const first = entries[0]!
    const dueAt = first.receivedAt + (lane === 'p1_batch' ? p1Ms : 0)
    for (const entry of entries) {
      entry.forwardPending = false
      entry.forwarded = true
      prune(entry)
    }
    return {
      key: key(lane, entries.map((entry) => entry.decision.key)), lane, dueAt,
      deadline: dueAt + (lane === 'p0_now' ? p0Ms : 0), items: entries.map(({ header }) => ({ ...header })),
    }
  }

  function due(now: number): { p0: Forward[]; p1: Forward[]; digests: Digest[] } {
    expirePending(now)
    const p0: Forward[] = []
    const batch: Entry[] = []
    const entries = [...pending].sort(compareReceipt)
    for (const entry of entries) {
      if (!entry.forwardPending || entry.receivedAt > now) continue
      if (route(entry.header) === 'p0_now') p0.push(forward('p0_now', [entry]))
      else batch.push(entry)
    }
    const oldest = batch[0]
    const p1 = oldest && oldest.receivedAt + p1Ms <= now ? [forward('p1_batch', batch)] : []

    const windows = new Map<string, { repo: string; start: number; end: number; entries: Entry[] }>()
    for (const entry of entries) {
      if (!entry.digestPending) continue
      const start = entry.digestStart
      const end = start + digestMs
      if (end > now) continue
      entry.digestPending = false
      prune(entry)
      const tag = repo ?? fileMailTag(entry.file)
      const batchKey = key('digest', tag, start, end)
      const window = windows.get(batchKey) ?? { repo: redact(tag), start, end, entries: [] }
      window.entries.push(entry)
      windows.set(batchKey, window)
    }
    const digests = Array.from(windows, ([batchKey, window]) => {
      emitted.add(batchKey)
      return digest(batchKey, window.repo, window.start, window.end, window.entries)
    })
    return { p0, p1, digests }
  }

  return { ingest, due, route }
}