import { randomUUID } from 'node:crypto'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Version = { subject: string; version: string }
type Announcement = Version & { audience: readonly string[]; summary?: string }
type Delivery = Version & { recipient: string }
type Entry = Announcement & { type: 'entry'; at: string }
type RolloutRecord = Entry | (Delivery & { type: 'notice' | 'ack'; at: string })
type Rollout = { entry: Entry; notices: Map<string, string>; acks: Map<string, string> }
type History = Map<string, Rollout>
type Subjects = Map<string, History>
type Filter = { subject?: string; version?: string }
type RecipientState = 'not notified' | 'waiting' | 'acked' | 'behind'

const limit = 4000
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
// Reserved one-byte JSON value, not a record. Append it before the next record
// to mark a discarded tail without rewriting history. Only the invalid line
// immediately before the marker is excused; a torn write cannot split the marker.
const discardTail = '0'

function token(field: string, value: unknown): void {
  if (typeof value !== 'string' || !value.length || value.length > 64 || /[^A-Za-z0-9._-]/.test(value)) {
    throw new Error(`invalid ${field}: expected 1-64 characters from A-Z, a-z, 0-9, ._-`)
  }
}

function validate(record: RolloutRecord): void {
  token('subject', record.subject)
  token('version', record.version)
  if (record.type === 'entry') {
    const { audience, summary } = record
    if (!Array.isArray(audience) || !audience.length || audience.length > 64) {
      throw new Error('invalid audience: expected 1-64 recipients')
    }
    for (const recipient of audience) token('recipient', recipient)
    if (new Set(audience).size !== audience.length) throw new Error('duplicate audience recipient')
    if (summary !== undefined && (typeof summary !== 'string' || !/^[^\p{Cc}]{0,500}$/u.test(summary))) {
      throw new Error('invalid summary: expected up to 500 characters without control characters')
    }
  } else if (record.type === 'notice' || record.type === 'ack') {
    token('recipient', record.recipient)
  } else {
    throw new Error('invalid record type')
  }
}

function deliveryTarget(subjects: Subjects, { subject, version, recipient }: Delivery): Rollout {
  const rollout = subjects.get(subject)?.get(version)
  if (!rollout) throw new Error(`unknown entry ${subject} ${version}`)
  if (!rollout.entry.audience.includes(recipient)) throw new Error(`recipient ${recipient} is outside the audience`)
  return rollout
}

function fold(subjects: Subjects, record: RolloutRecord): void {
  if (record.type === 'entry') {
    let history = subjects.get(record.subject)
    if (history?.has(record.version)) throw new Error('duplicate entry')
    if (!history) subjects.set(record.subject, history = new Map())
    history.set(record.version, { entry: record, notices: new Map(), acks: new Map() })
  } else {
    const { notices, acks } = deliveryTarget(subjects, record)
    if (record.type === 'notice') notices.set(record.recipient, record.at)
    else if (!acks.has(record.recipient)) acks.set(record.recipient, record.at)
  }
}

function read(file: string) {
  let text = ''
  try {
    // Split on newline bytes before decoding, so invalid UTF-8 cannot become valid JSON.
    text = readFileSync(file, 'latin1')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const subjects: Subjects = new Map()
  const lines = text.split('\n')
  let prefix = text && !text.endsWith('\n') ? '\n' : ''
  if (lines.at(-1) === '') lines.pop()
  for (let i = 0; i < lines.length; i++) {
    try {
      const line = lines[i]!
      if (line.length + 1 >= limit) throw new Error('oversize record')
      const record: RolloutRecord = JSON.parse(utf8.decode(Buffer.from(line, 'latin1')))
      validate(record)
      if (typeof record.at !== 'string' || new Date(record.at).toISOString() !== record.at) {
        throw new Error('invalid timestamp')
      }
      fold(subjects, record)
    } catch {
      if (lines[i + 1] === discardTail) i++
      else if (i === lines.length - 1) prefix += `${discardTail}\n`
      else throw new Error(`corrupt rollout ledger at line ${i + 1}`)
    }
  }
  return { subjects, prefix }
}

const lockSleep = new Int32Array(new SharedArrayBuffer(4))

function staleLock(pidFile: string, age: number): boolean {
  if (age > 60_000) return true
  let pid = 0
  try { pid = Number(readFileSync(pidFile, 'utf8').trim()) } catch { /* pid not readable */ }
  // Give a writer time to publish its pid after creating the directory.
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return age > 5_000
  try { process.kill(pid, 0) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  return false
}

function locked<T>(dir: string, run: () => T): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, '.rollout.lock')
  const pidFile = join(lock, 'pid')
  const stat = () => lstatSync(lock, { bigint: true, throwIfNoEntry: false })
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    try {
      mkdirSync(lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const seen = stat()
      if (!seen) continue
      if (seen.isDirectory() && staleLock(pidFile, Date.now() - Number(seen.mtimeMs))) {
        const current = stat()
        if (current?.ino !== seen.ino || current.dev !== seen.dev || current.mtimeNs !== seen.mtimeNs) continue
        // Move the stale directory aside before deleting it so retries can acquire the lock.
        const stale = `${lock}.${randomUUID()}`
        try { renameSync(lock, stale) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        rmSync(stale, { recursive: true, force: true })
        continue
      }
      Atomics.wait(lockSleep, 0, 0, Math.max(0, Math.min(10, deadline - performance.now())))
      continue
    }
    const owner = stat()
    if (!owner?.isDirectory()) continue
    try {
      writeFileSync(pidFile, String(process.pid), { flag: 'wx' })
      return run()
    } finally {
      const current = stat()
      if (current?.ino === owner.ino && current.dev === owner.dev) rmSync(lock, { recursive: true, force: true })
    }
  }
  throw new Error('rollout ledger is locked')
}

function view(subjects: Subjects, { subject, version }: Filter) {
  if (subject !== undefined) token('subject', subject)
  if (version !== undefined) token('version', version)
  const entries = []
  for (const [name, history] of subjects) {
    if (subject !== undefined && name !== subject) continue
    const rollout = version === undefined ? [...history.values()].at(-1) : history.get(version)
    if (!rollout) continue
    const { entry, notices, acks } = rollout
    const olderAcks = new Set<string>()
    for (const earlier of history.values()) {
      if (earlier === rollout) break
      for (const recipient of earlier.acks.keys()) olderAcks.add(recipient)
    }
    const recipients = entry.audience.map((recipient) => {
      const notifiedAt = notices.get(recipient) ?? null
      const ackedAt = acks.get(recipient) ?? null
      const state: RecipientState = ackedAt ? 'acked' : olderAcks.has(recipient) ? 'behind' : notifiedAt ? 'waiting' : 'not notified'
      return { recipient, state, notifiedAt, ackedAt }
    })
    entries.push({ subject: name, version: entry.version, audience: entry.audience, recipients })
  }
  if (version !== undefined && !entries.length) throw new Error(`unknown version ${version}`)
  return entries
}

/** Open a live view of rollout.jsonl. Writers use a lock directory beside the ledger on a local filesystem. */
export function openLedger(dir: string, { now = () => new Date() }: { now?: () => Date } = {}) {
  const file = join(dir, 'rollout.jsonl')

  function append<T extends RolloutRecord>(prefix: string, record: T): T {
    record.at = now().toISOString()
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line) >= limit) throw new Error('rollout record must be under 4000 bytes')
    appendFileSync(file, prefix + line, { flag: 'a' })
    return record
  }

  // The CLI needs the outcome from inside the same lock, not a separate lookup.
  function addEntryWithOutcome({ subject, version, audience, summary }: Announcement) {
    const entry: Entry = { type: 'entry', at: '', subject, version, audience, ...(summary === undefined ? {} : { summary }) }
    validate(entry)
    entry.audience = [...audience]
    return locked(dir, () => {
      const { subjects, prefix } = read(file)
      const existing = subjects.get(subject)?.get(version)?.entry
      if (existing) {
        if (existing.summary !== summary || JSON.stringify(existing.audience) !== JSON.stringify(entry.audience)) {
          throw new Error(`conflicting entry ${subject} ${version}`)
        }
        return { entry: existing, added: false }
      }
      return { entry: append(prefix, entry), added: true }
    })
  }

  function receipt<T extends 'notice' | 'ack'>(type: T, { subject, version, recipient }: Delivery) {
    const record = { type, at: '', subject, version, recipient }
    validate(record)
    return locked(dir, () => {
      const { subjects, prefix } = read(file)
      const { acks } = deliveryTarget(subjects, record)
      const at = acks.get(recipient)
      if (type === 'ack' && at !== undefined) return { ...record, at }
      return append(prefix, record)
    })
  }

  return {
    addEntry: (entry: Announcement) => addEntryWithOutcome(entry).entry,
    addEntryWithOutcome,
    notify: (delivery: Delivery) => receipt('notice', delivery),
    ack: (delivery: Delivery) => receipt('ack', delivery),
    show: ({ subject }: Pick<Filter, 'subject'> = {}) => view(read(file).subjects, { subject }),
    stale: (filter: Filter = {}) => view(read(file).subjects, filter).flatMap(({ subject, version, recipients }) =>
      recipients.filter(({ state }) => state !== 'acked').map((recipient) => ({ subject, version, ...recipient }))),
  }
}
