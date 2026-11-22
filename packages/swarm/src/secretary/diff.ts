import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DecisionRecord } from './shadow.ts'

export const liveFormat = 'secretary-live@1'
export type Outcome = 'p0_now' | 'p1_batch' | 'digest' | 'expire' | 'duplicate' | `reject:${string}`
export type LiveDigest = { type: 'digest'; from: string; to: string; ids: string[];
  counts: Record<'p0' | 'p1' | 'p2' | 'p3', number>; act_on: string[]; at?: string }
type ForwardBatch = { lane: 'p0_now' | 'p1_batch'; ids: string[] }
export type LiveForward = { type: 'forward'; at: string } & ForwardBatch
export type LiveLine = LiveDigest | LiveForward | { type: 'message'; id: string; outcome: Outcome }
type Value = Outcome[] | ForwardBatch[] | Pick<LiveDigest, 'ids' | 'counts' | 'act_on' | 'at'>
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
    if (row?.type === 'message' && typeof row.id === 'string' && row.id && typeof row.outcome === 'string'
      && /^(p0_now|p1_batch|digest|expire|duplicate|reject:[^\s]+)$/.test(row.outcome)) {
      return { type: 'message', id: row.id, outcome: row.outcome }
    }
    if (row?.type === 'forward' && typeof row.at === 'string' && strings(row.ids)
      && (row.lane === 'p0_now' || row.lane === 'p1_batch')) {
      return { type: 'forward', at: row.at, lane: row.lane, ids: [...row.ids].sort() }
    }
    if (row?.type === 'digest' && typeof row.from === 'string' && typeof row.to === 'string'
      && strings(row.ids) && strings(row.act_on) && row.counts && (row.at === undefined || typeof row.at === 'string')) {
      const { p0, p1, p2, p3 } = row.counts
      if ([p0, p1, p2, p3].every((n) => Number.isSafeInteger(n) && n >= 0)) {
        return { type: 'digest', from: row.from, to: row.to, ids: [...row.ids].sort(), counts: { p0, p1, p2, p3 },
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

function shadowLines(records: DecisionRecord[], checkForwards: boolean, timedWindows: Set<string>): LiveLine[] {
  const lines: LiveLine[] = []
  const accepts = new Map<string, LiveLine & { type: 'message' }>()
  for (const r of records) {
    if (r?.kind === 'digest' && Array.isArray(r.items) && r.window) {
      lines.push({ type: 'digest', ...r.window, counts: r.counts, act_on: r.act_on,
        ids: r.items.flatMap((item) => 'id' in item ? [item.id] : []),
        ...(timedWindows.has(windowId(r.window)) && { at: new Date(r.at).toISOString() }) })
    } else if (r?.kind === 'wake' && checkForwards) {
      lines.push({ type: 'forward', at: new Date(r.at).toISOString(), lane: r.lane, ids: r.ids })
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
      const outcome = r.kind === 'reject' ? (r.reason ? `reject:${r.reason}` as const : undefined)
        : r.kind === 'expire' || r.kind === 'duplicate' ? r.kind : r.lane
      if (!outcome) throw new Error('invalid shadow decision')
      const line = { type: 'message', id, outcome } as const
      lines.push(line)
      if (r.kind === 'accept' || r.kind === 'revision') accepts.set(occurrence, line)
    } else if (!r || !['ingest', 'lane', 'wake', 'verdict'].includes(r.kind)) {
      throw new Error('invalid shadow record')
    }
  }
  return liveLines(lines)
}

export function compareJournal(records: DecisionRecord[], expected: LiveLine[]): Difference[] {
  const digest = ({ ids, counts, act_on, at }: LiveDigest) => ({ ids, counts, act_on, at })
  function index(lines: LiveLine[]) {
    const messages = new Map<string, Outcome[]>(), digests = new Map<string, ReturnType<typeof digest>>()
    const forwards = new Map<string, ForwardBatch[]>()
    for (const row of lines) {
      if (row.type === 'message') {
        const outcomes = messages.get(row.id) ?? []
        outcomes.push(row.outcome)
        messages.set(row.id, outcomes)
      } else if (row.type === 'forward') {
        const slot = `forward ${row.at}`
        const batches = forwards.get(slot) ?? []
        batches.push({ lane: row.lane, ids: row.ids })
        forwards.set(slot, batches)
      } else {
        const window = windowId(row)
        if (digests.has(window)) throw new Error('duplicate digest window')
        digests.set(window, digest(row))
      }
    }
    return [messages, digests, forwards] as const
  }
  const live = liveLines(expected)
  // Older recorded cases compare decisions and membership only.
  const timedWindows = new Set(live.flatMap((row) => row.type === 'digest' && row.at !== undefined ? [windowId(row)] : []))
  const want = index(live), got = index(shadowLines(records, want[2].size > 0, timedWindows))
  const compare = (want: ReadonlyMap<string, Value>, got: ReadonlyMap<string, Value>) =>
    [...new Set([...want.keys(), ...got.keys()])].sort().flatMap((id) => {
      const expected = want.get(id) ?? null, actual = got.get(id) ?? null
      return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [{ id, expected, got: actual }]
    })
  return want.flatMap((group, i) => compare(group, got[i]!))
}
