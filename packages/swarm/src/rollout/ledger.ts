import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Version = { subject: string; version: string }
type Announcement = Version & { audience: readonly string[]; summary?: string }
type Delivery = Version & { recipient: string }
type Entry = Announcement & { type: 'entry'; at: string }
type RolloutRecord = (Entry & { writeId?: string }) | (Delivery & { type: 'notice' | 'ack'; at: string })
type Rollout = { entry: Entry; writeId?: string; notices: Map<string, string>; acks: Map<string, string> }
type History = Map<string, Rollout>
type Subjects = Map<string, History>
type Filter = { subject?: string; version?: string }
type RecipientState = 'not notified' | 'waiting' | 'acked' | 'behind'

const limit = 4000
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const noFollow = constants.O_NOFOLLOW ?? 0
// Finish an observed torn line with a reserved suffix, then a newline. Its
// starting byte offset lets concurrent repairs recognize a redundant suffix
// on its own line, without excusing an unrelated malformed line or a blank line.
const repaired = /\t!rollout-torn:(\d+)$/

function token(field: string, value: unknown): void {
  if (typeof value !== 'string' || !value.length || value.length > 64 || /[^A-Za-z0-9._-]/.test(value)) {
    throw new Error(`invalid ${field}: expected 1-64 characters from A-Z, a-z, 0-9, ._-`)
  }
}

function validate(record: RolloutRecord): void {
  token('subject', record.subject)
  token('version', record.version)
  if (record.type === 'entry') {
    const { audience, summary, writeId } = record
    if (writeId !== undefined && (typeof writeId !== 'string' || !/^[0-9a-f-]{36}$/.test(writeId))) {
      throw new Error('invalid write id')
    }
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
    if (history?.has(record.version)) return
    if (!history) subjects.set(record.subject, history = new Map())
    const { writeId, ...entry } = record
    history.set(record.version, { entry, writeId, notices: new Map(), acks: new Map() })
  } else {
    const { notices, acks } = deliveryTarget(subjects, record)
    const times = record.type === 'notice' ? notices : acks
    if (!times.has(record.recipient)) times.set(record.recipient, record.at)
  }
}

function read(dir: string, file: string, create = false) {
  const directory = statSync(dir, { throwIfNoEntry: false })
  if (directory && !directory.isDirectory()) throw new Error(`not a rollout directory: ${dir}`)
  if (!directory) {
    if (!create) throw new Error(`missing rollout directory ${dir}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const ledger = lstatSync(file, { throwIfNoEntry: false })
  if (ledger?.isSymbolicLink()) throw new Error(`symlinked rollout ledger: ${file}`)
  if (ledger && !ledger.isFile()) throw new Error(`not a rollout ledger file: ${file}`)

  // Split on newline bytes before decoding, so invalid UTF-8 cannot become valid JSON.
  const text = ledger ? readFileSync(file, { encoding: 'latin1', flag: constants.O_RDONLY | noFollow }) : ''
  const subjects: Subjects = new Map()
  const lines = text.split('\n')
  const tail = lines.pop()!
  const repairs = new Set<number>()
  let offset = 0
  for (const [i, line] of lines.entries()) {
    const start = offset
    offset += line.length + 1
    const marker = repaired.exec(line)
    if (marker && Number(marker[1]) === start && marker.index > 0) {
      repairs.add(start)
      continue
    }
    if (marker?.index === 0 && repairs.has(Number(marker[1]))) continue
    try {
      if (line.length + 1 >= limit) throw new Error('oversize record')
      const record: RolloutRecord = JSON.parse(utf8.decode(Buffer.from(line, 'latin1')))
      validate(record)
      if (typeof record.at !== 'string' || new Date(record.at).toISOString() !== record.at) {
        throw new Error('invalid timestamp')
      }
      fold(subjects, record)
    } catch {
      throw new Error(`corrupt rollout ledger at line ${i + 1}`)
    }
  }
  return { subjects, prefix: tail ? `\t!rollout-torn:${offset}\n` : '' }
}

function view(subjects: Subjects, { subject, version }: Filter) {
  if (subject !== undefined) {
    token('subject', subject)
    if (!subjects.has(subject)) throw new Error(`unknown subject ${subject}`)
  }
  if (version !== undefined) token('version', version)
  const entries = []
  for (const [name, history] of subjects) {
    if (subject !== undefined && name !== subject) continue
    // Current means the latest added effective version, not the highest version.
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

/** Open a live, append-only view of rollout.jsonl on a local filesystem. */
export function openLedger(dir: string, { now = () => new Date() }: { now?: () => Date } = {}) {
  const file = join(dir, 'rollout.jsonl')

  function append(prefix: string, record: RolloutRecord) {
    record.at = now().toISOString()
    const bytes = Buffer.from(`${prefix}${JSON.stringify(record)}\n`)
    if (bytes.length >= limit) throw new Error('rollout record must be under 4000 bytes')
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600)
    try { appendFileSync(fd, bytes) } finally { closeSync(fd) }
  }

  function addEntryWithOutcome({ subject, version, audience, summary }: Announcement) {
    // Identical writers can have the same timestamp; only the first reports added.
    const entry = { type: 'entry' as const, at: '', subject, version, audience, summary, writeId: randomUUID() }
    validate(entry)
    entry.audience = [...audience]
    const { subjects, prefix } = read(dir, file, true)
    const existing = subjects.get(subject)?.get(version)
    if (!existing) append(prefix, entry)
    const effective = existing ?? read(dir, file).subjects.get(subject)?.get(version)
    if (!effective || effective.entry.summary !== summary ||
      JSON.stringify(effective.entry.audience) !== JSON.stringify(entry.audience)) {
      throw new Error(`conflicting entry ${subject} ${version}`)
    }
    return { entry: effective.entry, added: effective.writeId === entry.writeId }
  }

  function receipt<T extends 'notice' | 'ack'>(type: T, { subject, version, recipient }: Delivery) {
    const record = { type, at: '', subject, version, recipient }
    validate(record)
    const { subjects, prefix } = read(dir, file)
    // An ack is the recipient's own statement, not proof of notice. A recipient
    // who learned of the version elsewhere can be acked with null notifiedAt.
    const timestamp = (state: Subjects) => {
      const { notices, acks } = deliveryTarget(state, record)
      return (type === 'notice' ? notices : acks).get(recipient)
    }
    const at = timestamp(subjects)
    if (at !== undefined) return { ...record, at }
    append(prefix, record)
    const effective = timestamp(read(dir, file).subjects)
    if (effective === undefined) throw new Error(`missing ${type} after append: ${subject} ${version} ${recipient}`)
    return { ...record, at: effective }
  }

  return {
    addEntry: (entry: Announcement) => addEntryWithOutcome(entry).entry,
    addEntryWithOutcome,
    notify: (delivery: Delivery) => receipt('notice', delivery),
    ack: (delivery: Delivery) => receipt('ack', delivery),
    show: (filter: Filter = {}) => view(read(dir, file).subjects, filter),
    stale: (filter: Filter = {}) => view(read(dir, file).subjects, filter).flatMap(({ subject, version, recipients }) =>
      recipients.filter(({ state }) => state !== 'acked').map((recipient) => ({ subject, version, ...recipient }))),
  }
}
