// stand-in until WP-103's ledger API lands; the sink is the only seam
import { appendFileSync, closeSync, fstatSync, fsyncSync, openSync, readFileSync, readlinkSync } from 'node:fs'
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

function syncOpenedParent(fd: number, path: string) {
  let dir = dirname(path)
  try { dir = dirname(readlinkSync(`/proc/self/fd/${fd}`)) } catch { /* fall back to the supplied path */ }
  const dirfd = openSync(dir, 'r')
  try { fsyncSync(dirfd) } finally { closeSync(dirfd) }
}

function privateLedger(fd: number) {
  const stat = fstatSync(fd, { bigint: true })
  if (!stat.isFile()) return
  if (stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n)) {
    throw new Error('unsafe ledger file')
  }
}

// STUB: single writer. A supplied append-mode descriptor stays owned by the caller.
export function jsonlLedger(path: string, openFd?: number): LedgerSink {
  const keys = new Set<string>(), written = new Set<string>()
  let text: string | undefined, syncDir = false
  try {
    const fd = openFd ?? openSync(path, 'r')
    try {
      privateLedger(fd)
      try { fsyncSync(fd) }
      catch (error) { throw new Error(`failed to sync existing ledger ${path}`, { cause: error }) }
      text = readFileSync(fd, 'utf8')
      try { syncOpenedParent(fd, path) }
      catch (error) { throw new Error(`failed to sync existing ledger ${path}`, { cause: error }) }
    } finally { if (openFd === undefined) closeSync(fd) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    syncDir = true
  }
  for (const line of (text ?? '').split('\n')) if (line.trim()) keys.add(JSON.parse(line).dedupe_key)
  return { async append(record) {
    const key = record.dedupe_key
    if (keys.has(key)) return 'duplicate'
    const fd = openFd ?? openSync(path, 'a', 0o600)
    try {
      privateLedger(fd)
      if (!written.has(key)) {
        appendFileSync(fd, `${JSON.stringify(record)}\n`)
        written.add(key)
      }
      fsyncSync(fd)
      if (fstatSync(fd).nlink === 0) throw new Error(`ledger file was unlinked ${path}`)
      if (syncDir) {
        syncOpenedParent(fd, path)
        syncDir = false
      }
    } finally { if (openFd === undefined) closeSync(fd) }
    written.delete(key)
    keys.add(key)
    return 'appended'
  } }
}

export function readIfPresent(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}