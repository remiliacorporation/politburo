import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Local stub for the ledger envelope: persist its opaque ref, not the envelope.
export type Binding = Readonly<{
  kind: 'implement' | 'review'; envelopeRef: string; repo: string; account: string
  briefRef: string; briefDigest: string; generation: number; epoch: number
  requestDigest: string; createdAt: number
}>

type Identity = { repo: string; account: string; workId: string; round: number; attemptId: string }
export function launchKey({ repo, account, workId, round, attemptId }: Identity): string {
  return JSON.stringify([repo, account, workId, round, attemptId])
}

const transitions = {
  intended: ['sent', 'confirmed', 'uncertain', 'abandoned'],
  sent: ['confirmed', 'uncertain', 'abandoned'],
  uncertain: ['uncertain', 'confirmed', 'abandoned'],
  confirmed: [], abandoned: [],
} as const
const reasons = ['board_paused', 'binding_mismatch', 'send_ambiguous', 'probe_absent', 'probe_unknown',
  'missing_session', 'stray_session', 'attention_reserved'] as const
export type JournalRecord = {
  key: string; state: keyof typeof transitions; binding: Binding; seq: number; at: number
  session?: string; reason?: typeof reasons[number]
}
export type JournalFailure = { ok: false; reason: 'torn_tail' | 'corrupt' | 'missing' }
type Replay = { ok: true; latest: Map<string, JournalRecord>; attention: Set<string>; seq: number }

const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0
const uint = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const digest = (x: unknown) => text(x) && /^(?:sha256:)?[a-f0-9]{64}$/i.test(x)
const object = (x: unknown): x is Record<string, unknown> => !!x && Object.getPrototypeOf(x) === Object.prototype
const fields = (x: object, allowed: string) => Object.keys(x).every((key) => allowed.split(' ').includes(key))

function scoped(key: string, binding: Binding) {
  try {
    const parts: unknown = JSON.parse(key)
    return Array.isArray(parts) && parts.length === 5 && parts[0] === binding.repo && parts[1] === binding.account
      && text(parts[2]) && uint(parts[3]) && parts[3] > 0 && text(parts[4]) && JSON.stringify(parts) === key
  } catch { return false }
}

function valid(x: unknown): x is JournalRecord {
  if (!object(x) || !fields(x, 'key state binding seq at session reason')) return false
  const b = x.binding
  if (!object(b) || !fields(b, 'kind envelopeRef repo account briefRef briefDigest generation epoch requestDigest createdAt')
      || (b.kind !== 'implement' && b.kind !== 'review') || !text(b.envelopeRef) || !text(b.repo) || !text(b.account)
      || !text(b.briefRef) || !digest(b.briefDigest) || !digest(b.requestDigest)
      || !uint(b.generation) || !uint(b.epoch) || !uint(b.createdAt)) return false
  return text(x.key) && scoped(x.key, b as Binding) && text(x.state) && Object.hasOwn(transitions, x.state)
    && uint(x.seq) && uint(x.at) && (x.state === 'confirmed' ? text(x.session) : x.session === undefined)
    && (x.reason === undefined || reasons.some((reason) => reason === x.reason))
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k as keyof Binding] === v)
}

function fold(replay: Replay, row: JournalRecord) {
  const prev = replay.latest.get(row.key)
  if (row.seq !== replay.seq + 1 || (prev && !sameBinding(prev.binding, row.binding))) return false
  if (row.reason === 'attention_reserved') {
    if (!prev || prev.state !== row.state || prev.session !== row.session || replay.attention.has(row.key)) return false
    replay.attention.add(row.key)
  } else if (prev ? !(transitions[prev.state] as readonly string[]).includes(row.state) : row.state !== 'intended') {
    return false
  }
  replay.latest.set(row.key, row)
  replay.seq = row.seq
  return true
}

const busy = new Map<string, Promise<unknown>>()

/** The directory already exists. Use one dispatcher process per journal. */
export function openJournal(dir: string, { known = false } = {}) {
  const path = resolve(dir, 'launch.jsonl')

  async function load(): Promise<Replay | JournalFailure> {
    const replay: Replay = { ok: true, latest: new Map(), attention: new Set(), seq: 0 }
    let bytes: Buffer
    try { bytes = await readFile(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return known ? { ok: false, reason: 'missing' } : replay
    }
    if (!bytes.length && known) return { ok: false, reason: 'corrupt' }
    known ||= bytes.length > 0
    const end = bytes.lastIndexOf(10) + 1
    try {
      const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)).split('\n')
      lines.pop()
      for (const line of lines) {
        const row: unknown = JSON.parse(line)
        if (!valid(row) || !fold(replay, row)) return { ok: false, reason: 'corrupt' }
      }
    } catch { return { ok: false, reason: 'corrupt' } }
    if (end !== bytes.length) return { ok: false, reason: 'torn_tail' }
    return replay
  }

  async function append(input: JournalRecord) {
    const record = structuredClone(input)
    if (!valid(record)) throw new Error('invalid journal record')
    const line = Buffer.from(`${JSON.stringify(record)}\n`)
    const replay = await load()
    if (!replay.ok) throw new Error(replay.reason)
    if (!fold(replay, record)) throw new Error('invalid journal transition')
    const flags = constants.O_WRONLY | constants.O_APPEND | (record.seq === 1 ? constants.O_CREAT : 0)
    const file = await open(path, flags, 0o600)
    try {
      if ((await file.write(line)).bytesWritten !== line.length) throw new Error('torn_tail')
      await file.sync()
      if (record.seq === 1) {
        const parent = await open(resolve(path, '..'), 'r')
        try { await parent.sync() } finally { await parent.close() }
      }
      known = true
    } finally { await file.close() }
  }

  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = (busy.get(path) ?? Promise.resolve()).then(run, run)
    busy.set(path, next)
    try { return await next } finally { if (busy.get(path) === next) busy.delete(path) }
  }

  return { load, append, exclusive }
}

export type Journal = ReturnType<typeof openJournal>
