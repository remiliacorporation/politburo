import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
    const { type, at, subject, version, audience, summary, writeId } = record
    const entry = { type, at, subject, version, audience, ...(summary === undefined ? {} : { summary }) }
    history.set(version, { entry, writeId, notices: new Map(), acks: new Map() })
  } else {
    const { notices, acks } = deliveryTarget(subjects, record)
    const times = record.type === 'notice' ? notices : acks
    if (!times.has(record.recipient)) times.set(record.recipient, record.at)
  }
}

function resolveDirectory(dir: string, create: boolean) {
  const directory = statSync(dir, { throwIfNoEntry: false })
  if (directory && !directory.isDirectory()) throw new Error(`not a rollout directory: ${dir}`)
  if (!directory) {
    if (!create) throw new Error(`missing rollout directory ${dir}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // Unlike lexical normalization, native realpath follows a symlink before `..`.
  return realpathSync.native(dir)
}

function read(dir: string, file: string, create = false) {
  const ledger = lstatSync(file, { throwIfNoEntry: false })
  if (ledger?.isSymbolicLink()) throw new Error(`symlinked rollout ledger: ${file}`)
  if (ledger && !ledger.isFile()) throw new Error(`not a rollout ledger file: ${file}`)

  if (!ledger && !create) throw new Error(`no rollout ledger in ${dir}`)

  // Split on newline bytes before decoding, so invalid UTF-8 cannot become valid JSON.
  const text = ledger ? readFileSync(file, { encoding: 'latin1', flag: constants.O_RDONLY | noFollow }) : ''
  const subjects: Subjects = new Map()
  const lines = text.split('\n')
  const corrupt = (line: number) => new Error(`corrupt rollout ledger at line ${line}`)
  for (const [i, line] of lines.entries()) {
    if (!line) continue
    try {
      const bytes = Buffer.from(line, 'latin1')
      let decoded: string
      let incompleteUtf8 = false
      try {
        decoded = utf8.decode(bytes)
      } catch {
        // A cut can split the final code point, but invalid bytes are still corruption.
        decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: true })
        incompleteUtf8 = true
      }
      let record: RolloutRecord
      try {
        record = JSON.parse(decoded)
      } catch {
        // Skip torn records, even if a subsequent writer only left a separator.
        continue
      }
      if (incompleteUtf8) throw new Error('incomplete UTF-8 after complete JSON')
      if (bytes.length + 1 >= limit) throw new Error('oversize record')
      validate(record)
      if (typeof record.at !== 'string' || new Date(record.at).toISOString() !== record.at) {
        throw new Error('invalid timestamp')
      }
      // A complete record whose writer died before reporting is still committed,
      // even without a trailing newline.
      fold(subjects, record)
    } catch {
      throw corrupt(i + 1)
    }
  }
  return subjects
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
  function location(create = false) {
    const directory = resolveDirectory(dir, create)
    return [directory, join(directory, 'rollout.jsonl')] as const
  }

  function append(file: string, record: RolloutRecord) {
    record.at = now().toISOString()
    const bytes = Buffer.from(`\n${JSON.stringify(record)}`)
    if (bytes.length >= limit) throw new Error('rollout record must be under 4000 bytes')
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600)
    try {
      let { size } = fstatSync(fd)
      if (size === 0) {
        // Only empty files need coordination: two unprefixed first writes could fuse.
        // flock stays on the inherited descriptor until we close it, even if we die.
        const lock = spawnSync('perl', ['-MFcntl=:flock', '-e',
          'open(my $f, ">&=3") or die $!; flock($f, LOCK_EX) or die $!;'],
        { stdio: ['ignore', 'ignore', 'ignore', fd] })
        if (lock.error || lock.status !== 0) throw new Error('could not lock empty rollout ledger (requires Perl flock)')
        size = fstatSync(fd).size
      }
      // Do not inspect the tail: another writer may leave a fragment before us.
      appendFileSync(fd, size > 0 ? bytes : bytes.subarray(1))
    } finally { closeSync(fd) }
  }

  function addEntryWithOutcome({ subject, version, audience, summary }: Announcement) {
    // Identical writers can have the same timestamp; only the first reports added.
    const entry = { type: 'entry' as const, at: '', subject, version, audience, summary, writeId: randomUUID() }
    validate(entry)
    entry.audience = [...audience]
    const path = location(true)
    const existing = read(...path, true).get(subject)?.get(version)
    if (!existing) append(path[1], entry)
    const effective = existing ?? read(...path).get(subject)?.get(version)
    if (!effective || effective.entry.summary !== summary ||
      JSON.stringify(effective.entry.audience) !== JSON.stringify(entry.audience)) {
      throw new Error(`conflicting entry ${subject} ${version}`)
    }
    return { entry: effective.entry, added: effective.writeId === entry.writeId }
  }

  function receipt<T extends 'notice' | 'ack'>(type: T, { subject, version, recipient }: Delivery) {
    const record = { type, at: '', subject, version, recipient }
    validate(record)
    const path = location()
    const subjects = read(...path)
    // An ack is the recipient's own statement, not proof of notice. A recipient
    // who learned of the version elsewhere can be acked with null notifiedAt.
    const timestamp = (state: Subjects) => {
      const { notices, acks } = deliveryTarget(state, record)
      return (type === 'notice' ? notices : acks).get(recipient)
    }
    const at = timestamp(subjects)
    if (at !== undefined) return { ...record, at }
    append(path[1], record)
    const effective = timestamp(read(...path))
    if (effective === undefined) throw new Error(`missing ${type} after append: ${subject} ${version} ${recipient}`)
    return { ...record, at: effective }
  }

  return {
    addEntry: (entry: Announcement) => addEntryWithOutcome(entry).entry,
    addEntryWithOutcome,
    notify: (delivery: Delivery) => receipt('notice', delivery),
    ack: (delivery: Delivery) => receipt('ack', delivery),
    show: (filter: Filter = {}) => view(read(...location()), filter),
    stale: (filter: Filter = {}) => view(read(...location()), filter).flatMap(({ subject, version, recipients }) =>
      recipients.filter(({ state }) => state !== 'acked').map((recipient) => ({ subject, version, ...recipient }))),
  }
}
