import { appendFileSync, readFileSync } from 'node:fs'
import { object } from './facts.ts'
import type { SpendRecord } from './record.ts'

export interface SpendWriter {
  append(record: SpendRecord): void
}

// Thin stand-in for the WP-103 ledger writer. Use one writer per file at a time.
export function jsonlWriter(path: string): SpendWriter {
  const keys = new Set<string>()
  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch (error) {
    if (object(error)?.code !== 'ENOENT') throw error
  }
  for (const line of existing.split('\n')) {
    if (!line.trim()) continue
    const key: unknown = object(JSON.parse(line))?.dedupe_key
    if (typeof key === 'string') keys.add(key)
  }
  let prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  return {
    append(record) {
      if (keys.has(record.dedupe_key)) return
      appendFileSync(path, `${prefix}${JSON.stringify(record)}\n`, { flush: true })
      prefix = ''
      keys.add(record.dedupe_key)
    },
  }
}
