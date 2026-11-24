import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { redact } from './redact.ts'
import type { DecisionRecord } from './shadow.ts'

export const liveFormat = 'secretary-live@1'
export type Outcome = 'p0_now' | 'p1_batch' | 'digest' | 'expire' | 'duplicate'
export type Rejection = { outcome: 'reject'; reason: string }
type DigestItem = { id: string } | { summary: string }
export type LiveDigest = { type: 'digest'; from: string; to: string; items: DigestItem[];
  counts: Record<'p0' | 'p1' | 'p2' | 'p3', number>; act_on: string[]; at?: string }
type ForwardBatch = { at: string; lane: 'p0_now' | 'p1_batch'; ids: string[] }
export type LiveForward = { type: 'forward' } & ForwardBatch
type LiveMessage = { type: 'message'; id: string } & { outcome: Outcome }
export type LiveNotice = { type: 'notice'; file: string; to: string | null; reason: string }
export type LiveLine = LiveDigest | LiveForward | LiveNotice | LiveMessage | ({ type: 'message'; id: string } & Rejection)
type NoticeTarget = Pick<LiveNotice, 'to' | 'reason'>
type Value = (Outcome | Rejection)[] | ForwardBatch[] | NoticeTarget[] | Pick<LiveDigest, 'items' | 'counts' | 'act_on' | 'at'>
export type Difference = { id: string; expected: Value | null; got: Value | null }

export function jsonLines(text: string): unknown[] {
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line) } catch { throw new Error('invalid JSON line') }
  })
}

export function parseLive(text: string): LiveLine[] {
  const lines = jsonLines(text.replace(/^secretary-live@1\r?$/m, JSON.stringify(liveFormat)))
  if (lines[0] === liveFormat) lines.shift()
  return liveLines(lines)
}

export function liveLines(lines: unknown[]): LiveLine[] {
  return lines.map((line) => {
    const row = line as LiveLine
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string')
    if (row?.type === 'message' && typeof row.id === 'string' && row.id) {
      if (row.outcome === 'reject' && typeof row.reason === 'string') {
        return { type: 'message', id: row.id, outcome: 'reject', reason: row.reason }
      }
      if (row.outcome === 'p0_now' || row.outcome === 'p1_batch' || row.outcome === 'digest'
        || row.outcome === 'expire' || row.outcome === 'duplicate') {
        return { type: 'message', id: row.id, outcome: row.outcome }
      }
    }
    if (row?.type === 'notice' && typeof row.file === 'string' && row.file
      && (row.to === null || typeof row.to === 'string') && typeof row.reason === 'string') {
      return { type: 'notice', file: row.file, to: row.to, reason: row.reason }
    }
    if (row?.type === 'forward' && typeof row.at === 'string' && strings(row.ids) && row.ids.length > 0
      && (row.lane === 'p0_now' || row.lane === 'p1_batch')) {
      return { type: 'forward', at: row.at, lane: row.lane, ids: row.ids }
    }
    if (row?.type === 'digest' && typeof row.from === 'string' && typeof row.to === 'string'
      && Array.isArray(row.items) && strings(row.act_on) && row.counts && (row.at === undefined || typeof row.at === 'string')) {
      const { p0, p1, p2, p3 } = row.counts
      if ([p0, p1, p2, p3].every((n) => Number.isSafeInteger(n) && n >= 0)) {
        const items = row.items.map((item) => {
          if (item && typeof item === 'object') {
            if ('id' in item && typeof item.id === 'string') return { id: item.id }
            if ('summary' in item && typeof item.summary === 'string') return { summary: redact(item.summary) }
          }
          throw new Error('invalid secretary digest item')
        })
        return { type: 'digest', from: row.from, to: row.to, items, counts: { p0, p1, p2, p3 },
          act_on: row.act_on, ...(row.at !== undefined && { at: row.at }) }
      }
    }
    throw new Error('invalid secretary live record')
  })
}

export async function readJournal(path: string, optional = false): Promise<DecisionRecord[]> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT') return ''
    throw error
  })
  return jsonLines(text) as DecisionRecord[]
}

const windowId = ({ from, to }: Pick<LiveDigest, 'from' | 'to'>) => `${from}/${to}`

function shadowLines(records: DecisionRecord[], timedWindows: Set<string>): LiveLine[] {
  const lines: LiveLine[] = []
  const accepts = new Map<string, LiveMessage>()
  for (const r of records) {
    if (r?.kind === 'digest' && Array.isArray(r.items) && r.window) {
      lines.push({ type: 'digest', ...r.window, counts: r.counts, act_on: r.act_on,
        items: r.items,
        ...(timedWindows.has(windowId(r.window)) && { at: new Date(r.at).toISOString() }) })
    } else if (r?.kind === 'accept' || r?.kind === 'revision' || r?.kind === 'expire'
      || r?.kind === 'duplicate' || r?.kind === 'reject') {
      // Invalid files have no parsed id; fixtures identify them by their filename.
      const id = r.id ?? (r.kind === 'reject' && typeof r.file === 'string' ? basename(r.file) : '')
      const occurrence = JSON.stringify([id, r.file, r.receivedAt])
      const accepted = accepts.get(occurrence)
      if (r.kind === 'expire' && accepted) {
        accepted.outcome = 'expire'
        accepts.delete(occurrence)
        continue
      }
      if (r.kind === 'reject') {
        if (typeof r.reason !== 'string') throw new Error('invalid shadow decision')
        lines.push({ type: 'message', id, outcome: 'reject', reason: r.reason })
        continue
      }
      const outcome = r.kind === 'expire' || r.kind === 'duplicate' ? r.kind : r.lane
      if (!outcome) throw new Error('invalid shadow decision')
      const line = { type: 'message', id, outcome } as const
      lines.push(line)
      if (r.kind === 'accept' || r.kind === 'revision') accepts.set(occurrence, line)
    } else if (r?.kind === 'notice' && typeof r.file === 'string') {
      lines.push({ type: 'notice', file: basename(r.file), to: r.to, reason: r.reason })
    } else if (!r || !['ingest', 'lane', 'wake', 'verdict'].includes(r.kind)) {
      throw new Error('invalid shadow record')
    }
  }
  return liveLines(lines)
}

function indexForwards(forwards: ForwardBatch[]) {
  const byId = new Map<string, ForwardBatch[]>()
  for (const { lane, at, ids } of forwards) {
    const batch = { lane, at, ids: [...ids].sort() }
    // An empty journal batch is still an unexpected record, not an empty expectation.
    for (const id of new Set(ids.length ? ids : [''])) {
      const batches = byId.get(id) ?? []
      batches.push(batch)
      byId.set(id, batches)
    }
  }
  return byId
}

function indexNotices(lines: LiveLine[]) {
  const files = new Map<string, Map<string, NoticeTarget[]>>()
  for (const row of lines) {
    if (row.type !== 'notice') continue
    const { file, to, reason } = row
    const targets = files.get(file) ?? new Map<string, NoticeTarget[]>()
    const tuple = JSON.stringify([to, reason])
    const occurrences = targets.get(tuple) ?? []
    occurrences.push({ to, reason })
    targets.set(tuple, occurrences)
    files.set(file, targets)
  }
  return new Map([...files].map(([file, targets]) => [file, [...targets.keys()].sort().flatMap((key) => targets.get(key)!)]))
}

export function compareJournal(records: DecisionRecord[], expected: LiveLine[]): Difference[] {
  const digest = ({ items, counts, act_on, at }: LiveDigest) => ({ items, counts, act_on, at })
  function index(lines: LiveLine[]) {
    const messages = new Map<string, (Outcome | Rejection)[]>(), digests = new Map<string, ReturnType<typeof digest>>()
    for (const row of lines) {
      if (row.type === 'message') {
        const outcomes = messages.get(row.id) ?? []
        outcomes.push(row.outcome === 'reject' ? { outcome: row.outcome, reason: row.reason } : row.outcome)
        messages.set(row.id, outcomes)
      } else if (row.type === 'digest') {
        const window = windowId(row)
        if (digests.has(window)) throw new Error('duplicate digest window')
        digests.set(window, digest(row))
      }
    }
    return [messages, digests] as const
  }
  const live = liveLines(expected)
  const timedWindows = new Set(live.flatMap((row) => row.type === 'digest' && row.at !== undefined ? [windowId(row)] : []))
  const shadow = shadowLines(records, timedWindows)
  const want = index(live), got = index(shadow)
  const forwards = indexForwards(live.filter((row) => row.type === 'forward'))
  const lanes = indexForwards(records.flatMap((row) => row.kind === 'lane'
    ? [{ lane: row.lane, at: new Date(row.at).toISOString(), ids: row.items.map(({ id }) => id) }] : []))
  const wakes = indexForwards(records.flatMap((row) => row.kind === 'wake'
    ? [{ lane: row.lane, at: new Date(row.at).toISOString(), ids: row.ids }] : []))
  const compare = (want: ReadonlyMap<string, Value>, got: ReadonlyMap<string, Value>, prefix = '') =>
    [...new Set([...want.keys(), ...got.keys()])].sort().flatMap((id) => {
      const expected = want.get(id) ?? null, actual = got.get(id) ?? null
      return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [{ id: prefix + id, expected, got: actual }]
    })
  return [...want.flatMap((group, i) => compare(group, got[i]!)),
    ...compare(forwards, lanes, 'lane '), ...compare(forwards, wakes, 'forward '),
    ...compare(indexNotices(live), indexNotices(shadow), 'notice ')]
}
