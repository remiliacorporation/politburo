import { appendFileSync, closeSync, openSync, readSync, statSync, truncateSync } from 'node:fs'
import { tokenFingerprint, type SpendRecord } from './record.ts'

export interface SpendWriter {
  append(record: SpendRecord): 'written' | 'duplicate' | 'differs'
  existing(key: string): { record_id: string } | null
}

type Entry = { record_id: string; fingerprint: string }

// Thin stand-in for WP-103. Refresh sees completed appends; it does not lock concurrent writes.
export function jsonlWriter(path: string): SpendWriter {
  const keys = new Map<string, Entry>()
  const rootOf = new Map<string, string>()
  const headOf = new Map<string, string>()
  const entry = (record: SpendRecord): Entry => ({ record_id: record.record_id, fingerprint: tokenFingerprint(record.tokens) })
  const remember = (record: SpendRecord | null) => {
    if (record && !keys.has(record.dedupe_key)) keys.set(record.dedupe_key, entry(record))
  }
  // One linear pass over records already read, including a last record that
  // parses without a trailing newline. A successor extends the head only when
  // it revises that head, so a fork does not replace it. An invalid torn tail
  // does not parse and is still truncated on the next append.
  const indexChain = (record: SpendRecord) => {
    if (rootOf.has(record.record_id)) return
    const revises = record.revises ?? null
    if (!revises) {
      rootOf.set(record.record_id, record.record_id)
      if (!headOf.has(record.record_id)) headOf.set(record.record_id, record.record_id)
      return
    }
    const root = rootOf.get(revises) ?? revises
    rootOf.set(revises, root)
    rootOf.set(record.record_id, root)
    if ((headOf.get(root) ?? root) === revises) headOf.set(root, record.record_id)
  }
  const headFor = (anchor: string) => {
    const root = rootOf.get(anchor) ?? anchor
    return headOf.get(root) ?? root
  }
  let offset = 0, tail = Buffer.alloc(0), tailRecord: SpendRecord | null = null
  let failed = false

  function refresh() {
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    if (size <= offset) return
    const bytes = Buffer.alloc(size - offset)
    const fd = openSync(path, 'r')
    try {
      for (let read = 0; read < bytes.length;) {
        const n = readSync(fd, bytes, read, bytes.length - read, offset + read)
        if (n === 0) throw new Error('Spend file shrank while reading')
        read += n
      }
    } finally {
      closeSync(fd)
    }
    const data = Buffer.concat([tail, bytes])
    const end = data.lastIndexOf(10) + 1
    const lines = data.subarray(0, end).toString().split('\n').slice(0, -1)
    const remainder = data.subarray(end)
    const parse = (line: string, final: boolean): SpendRecord | null => {
      if (!line.trim()) return null
      let record: SpendRecord | null
      try { record = JSON.parse(line) } catch (error) {
        if (!final) throw error
        return null
      }
      return typeof record?.dedupe_key === 'string' && record.tokens ? record : null
    }
    lines.forEach((line, i) => {
      // Another writer may have separated a previously observed torn tail.
      if (i === 0 && tail.length && !tailRecord && bytes[0] === 10) return
      const record = parse(line, !remainder.length && i === lines.length - 1)
      remember(record)
      if (record) indexChain(record)
    })
    tailRecord = parse(remainder.toString(), true)
    if (tailRecord) indexChain(tailRecord)
    tail = Buffer.from(remainder)
    offset = size
  }

  function lookup(key: string): Entry | undefined {
    return keys.get(key) ?? (tailRecord?.dedupe_key === key ? entry(tailRecord) : undefined)
  }

  refresh()
  return {
    existing(key) {
      refresh()
      const prior = lookup(key)
      return prior ? { record_id: prior.record_id } : null
    },
    append(record) {
      try {
        refresh()
        // A torn fragment is not a line. Cut it off before this append, or the next
        // open reads it as a malformed line between the records.
        if (tail.length && !tailRecord) {
          const keep = offset - tail.length
          truncateSync(path, keep)
          offset = keep
          tail = Buffer.alloc(0)
        }
        const prior = lookup(record.dedupe_key)
        if (prior) return prior.fingerprint === tokenFingerprint(record.tokens) ? 'duplicate' : 'differs'
        if (record.revises) record.revises = headFor(record.revises)
        const line = `${tail.length || failed ? '\n' : ''}${JSON.stringify(record)}\n`
        appendFileSync(path, line, { flush: true })
        failed = false
        remember(record)
        indexChain(record)
        return 'written'
      } catch (error) {
        failed = true
        throw error
      }
    },
  }
}
