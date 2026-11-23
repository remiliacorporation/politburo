// stand-in until WP-103's ledger API lands; the sink is the only seam
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Envelope {
  party: string
  repo: string | null
  work_id: string | null
  attempt: string | null
  tier: 'core' | 'spawner' | 'secretary' | 'mob' | 'sprite' | 'jockey'
  parent: string | null
  session: string
  trace: { id: string; execution_id: string }
}

export const tokenFields = ['input_uncached', 'input_total', 'output', 'cache_read', 'cache_write', 'reasoning'] as const
export type Tokens = Record<typeof tokenFields[number], number | null>

export type SpendRecord = (
  { revises: null } | { revises: string; actor: string; reason: string }
) & {
  record_id: string
  dedupe_key: string
  envelope: Envelope | null
  source: string
  source_version: string | number
  source_event_key: string
  evidence_ref: string
  provider: string | null
  requested_route: string | null
  actual_model: string | null
  auth_class: string | null
  tokens: Tokens
  amount: { value: string; unit: string } | null
  basis: 'priced_estimate' | 'settled_charge' | 'measured_resource' | 'unknown' | 'not_applicable'
  occurred: string | null
  received: string
  started: string | null
  ended: string | null
  status: string
  exit_reason?: string
  coverage: {
    state: 'live' | 'pending' | 'partial' | 'unattributed' | 'conflict' | 'closed_reconciled'
    field_quality: Record<string, string>
  }
}

export interface LedgerSink { append(record: SpendRecord): Promise<'appended' | 'duplicate'> }

// STUB: single writer.
export function jsonlLedger(path: string): LedgerSink {
  const keys = new Set<string>()
  const text = readIfPresent(path)
  let syncDir = text === undefined
  for (const line of (text ?? '').split('\n')) if (line.trim()) keys.add(JSON.parse(line).dedupe_key)
  return { async append(record) {
    if (keys.has(record.dedupe_key)) return 'duplicate'
    const fd = openSync(path, 'a', 0o600)
    try {
      appendFileSync(fd, `${JSON.stringify(record)}\n`)
      // Register before fsync so a failed fsync cannot be retried as a second row.
      keys.add(record.dedupe_key)
      fsyncSync(fd)
      if (syncDir) {
        const dirfd = openSync(dirname(path), 'r')
        try { fsyncSync(dirfd) } finally { closeSync(dirfd) }
        syncDir = false
      }
    } finally { closeSync(fd) }
    return 'appended'
  } }
}

export function readIfPresent(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
