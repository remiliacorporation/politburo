import { mkdir, readFile, rename, rmdir, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import defaults from '../config/defaults.json' with { type: 'json' }
import { compareJournal, liveFormat, parseLive, readJournal, type LiveDigest, type LiveForward, type LiveLine, type Outcome } from './diff.ts'
import type { SwarmMessage, Urgency } from './message.ts'
import { createShadow } from './shadow.ts'
import { shadowWaker } from './wake.ts'

const minute = 60_000, start = Date.UTC(2026, 0, 1), day = 1440, windowMinutes = 30
const iso = (time: number) => new Date(time).toISOString()
const lane = { p0: 'p0_now', p1: 'p1_batch', p2: 'digest', p3: 'digest' } as const
const priorities = ['p0', 'p1', 'p2', 'p3'] as const
const bodyCanary = 'thread replay-private-body-canary'
const credentialCanary = 'ghp_SYNTHETIC_REPLAY_CANARY_NOT_A_SECRET'
export type RecordedFile = { name: string; content: string; mtimeMs: number }

function mulberry32(seed: number) {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// The fixture declares the outcome of each delivery. Only the actual side uses shadow/router code.
function recordedDay(seed: number) {
  const random = mulberry32(seed)
  const mail: { file: RecordedFile; decision: LiveLine; member?: SwarmMessage }[] = []
  const timestamp = (offset: number) => iso(start + offset * minute)
  const header = (offset: number, urgency: Urgency, mailClass: string, id = `m${mail.length}`): SwarmMessage =>
    ({ id, urgency, class: mailClass, from: 'synthetic', ref: id, summary: `fixture ${id}`, at: timestamp(offset) })
  const encode = (fields: Partial<SwarmMessage>) => `fixture\n\`\`\`yaml\n${JSON.stringify(fields)}\n\`\`\`\n`
  function inject(offset: number, content: string, outcome: Outcome, id?: string, member?: SwarmMessage) {
    const name = `${String(mail.length).padStart(4, '0')}.md`
    mail.push({ file: { name, content, mtimeMs: start + offset * minute },
      decision: { type: 'message', id: id ?? name, outcome }, member })
  }
  function accept(offset: number, message: SwarmMessage, listed = true) {
    inject(offset, encode(message), lane[message.urgency], message.id, listed ? message : undefined)
  }

  const original = header(1, 'p2', 'spawner.decide')
  accept(1, original, false) // The pending original is superseded before the digest closes.
  inject(2, encode(original), 'duplicate', original.id)
  accept(3, { ...original, id: 'newer', at: timestamp(3) })
  inject(4, encode({ ...original, id: 'older' }), 'reject:older_at', 'older')
  inject(4, encode({ ...original, ref: 'other' }), 'reject:id_collision', original.id)
  for (const [urgency, expires] of [['p3', 5], ['p2', 6]] as const) {
    const message = { ...header(0, urgency, 'policy'), expires: timestamp(expires) }
    inject(5, encode(message), 'expire', message.id) // Expired on ingest, then expired while pending.
  }
  const candidate = header(6, 'p0', 'sec.log')
  inject(6, encode({ ...candidate, class: 'not-a-class' }), 'reject:bad_class')
  inject(6, encode({ ...candidate, ref: undefined }), 'reject:missing_field:ref')
  inject(6, encode({ ...candidate, expires: timestamp(7) }), 'reject:expires_on_p0p1')
  inject(6, 'x'.repeat(65_537), 'reject:oversize')
  inject(6, 'garbage', 'reject:no_header')
  accept(7, header(7, 'p1', 'sec.log'))
  accept(7, { ...header(7, 'p0', 'sec.log'), body: bodyCanary, summary: `fixture ${credentialCanary}` })
  accept(7, header(7, 'p0', 'sec.log'))
  accept(8, header(8, 'p1', 'spawner.decide'))
  accept(29, header(29, 'p2', 'policy'))
  accept(30, header(30, 'p2', 'policy'))
  for (let slot = 0; slot < 285; slot++) {
    const offset = slot * 5 + Math.floor(random() * 5)
    const urgency = priorities[Math.floor(random() * priorities.length)]!
    const mailClass = defaults.mail.classes[Math.floor(random() * defaults.mail.classes.length)]!
    accept(offset, header(offset, urgency, mailClass))
  }

  mail.sort((a, b) => a.file.mtimeMs - b.file.mtimeMs) // Stable: ties are already in filename order.
  const expected = mail.map(({ decision }) => decision)
  const forwards: LiveForward[] = []
  let p1: LiveForward | undefined
  for (const { file, member } of mail) {
    if (member?.urgency === 'p0') {
      forwards.push({ type: 'forward', at: iso(file.mtimeMs), lane: 'p0_now', ids: [member.id] })
    } else if (member?.urgency === 'p1') {
      const received = iso(file.mtimeMs)
      if (!p1 || received > p1.at) {
        p1 = { type: 'forward', at: iso(file.mtimeMs + 10 * minute), lane: 'p1_batch', ids: [] }
        forwards.push(p1)
      }
      p1.ids.push(member.id)
    }
  }
  forwards.sort((a, b) => a.at.localeCompare(b.at) || a.lane.localeCompare(b.lane))
  const members = mail.filter(({ member }) => member).sort((a, b) => a.member!.urgency.localeCompare(b.member!.urgency))
  const windows = new Map<number, LiveDigest>()
  for (const { file, member } of members) {
    const { id, urgency, class: mailClass } = member!
    const width = windowMinutes * minute, from = Math.floor(file.mtimeMs / width) * width
    const digest = windows.get(from) ?? { type: 'digest', from: iso(from), to: iso(from + width), at: iso(from + width),
      ids: [], counts: { p0: 0, p1: 0, p2: 0, p3: 0 }, act_on: [] }
    digest.counts[urgency]++
    if (mailClass !== 'sec.log') {
      if (urgency !== 'p3') digest.ids.push(id)
      if (mailClass.startsWith('spawner.') || mailClass === 'core.escalate') digest.act_on.push(id)
    }
    windows.set(from, digest)
  }
  return { files: mail.map(({ file }) => file), expected: [...expected, ...forwards, ...windows.values()] }
}

export function validSegment(name: string) {
  return !!name && basename(name) === name && name !== '.' && name !== '..' && !name.includes('\0')
}

export async function materialize(inbox: string, { name, content, mtimeMs }: RecordedFile) {
  if (typeof name !== 'string' || !validSegment(name) || typeof content !== 'string'
    || !Number.isFinite(mtimeMs)) throw new Error('invalid recorded file')
  const path = join(inbox, name)
  await writeFile(path, content, { flag: 'wx', mode: 0o600 })
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000)
}

export async function replay(seed: number, dir: string, tag: string) {
  if (!validSegment(tag)) throw new Error('bad_tag')
  const { files, expected } = recordedDay(seed)
  const mailDir = join(dir, 'mail'), outDir = join(dir, 'shadow'), live = join(dir, 'live.jsonl')
  const inbox = join(mailDir, tag, 'inbox')
  await mkdir(dir, { recursive: true })
  await mkdir(mailDir) // Never reuse or overwrite an existing mailbox or shadow run.
  await mkdir(outDir)
  await mkdir(inbox, { recursive: true })
  await writeFile(live, [liveFormat, ...expected].map((line) => JSON.stringify(line)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  const archive = join(mailDir, tag, 'recorded')
  await mkdir(archive)
  const shadow = await createShadow({ mailDir, tag, outDir, waker: shadowWaker })
  const move = (file: RecordedFile, from: string, to: string) => rename(join(from, file.name), join(to, file.name))
  let next = 0, archived = 0
  try {
    for (let now = start; now <= start + (day + 1) * minute; now += minute) {
      while (files[next] && files[next]!.mtimeMs <= now) await materialize(inbox, files[next++]!)
      await shadow.tick(now)
      // These synthetic files are already journaled. Park them so the reader doesn't
      // reparse all earlier fixtures on every minute, then restore the inbox intact.
      for (; archived < next; archived++) await move(files[archived]!, inbox, archive)
    }
  } finally {
    try { await shadow.close() } finally {
      for (const file of files.slice(0, archived)) await move(file, archive, inbox)
      await rmdir(archive)
    }
  }
  const records = await readJournal(join(outDir, tag, 'decisions.jsonl'))
  // Inspect the entire journal, including records that diff deliberately projects away.
  const journal = JSON.stringify(records)
  if (journal.includes(bodyCanary) || /"body":/.test(journal)) throw new Error('body in shadow journal')
  if (journal.includes(credentialCanary)) throw new Error('credential canary in shadow journal')
  return compareJournal(records, parseLive(await readFile(live, 'utf8')))
}
