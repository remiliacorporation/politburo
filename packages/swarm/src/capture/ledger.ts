// Stub until WP-103's ledger store lands; same interface.
import { lstatSync, unlinkSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { copyEnvelope } from './types.ts'
import type { Envelope, SpendRecord } from './types.ts'

export interface CaptureLedger {
  registerEnvelope(e: Envelope): Promise<void>
  append(r: SpendRecord): Promise<{ written: boolean }>
}

// Queue handles in this process before competing for the on-disk lock.
const pending = new Map<string, Promise<unknown>>()
const qualities = new Set([
  'unknown', 'provider_reported', 'provider_reported_partial',
  'priced_estimate', 'settled_charge', 'measured_resource', 'not_applicable',
])

function spendLine(r: SpendRecord): string {
  const {
    record_id, dedupe_key, revises, actor, reason, envelope, source, source_version,
    source_event_key, evidence_ref, provider, requested_route, actual_model, auth_class,
    amount, basis, occurred, received, started, ended, status, exit_reason,
    tokens: { input_uncached, input_total, output, cache_read, cache_write, reasoning },
    coverage: { state, field_quality },
  } = r
  const tokens = { input_uncached, input_total, output, cache_read, cache_write, reasoning }
  const quality = Object.fromEntries(['amount', ...Object.keys(tokens).map(k => `tokens.${k}`)].map(key => {
    const value = field_quality[key]
    return [key, value !== undefined && qualities.has(value) ? value : 'unknown']
  }))
  for (const [bucket, value] of Object.entries(tokens)) {
    const key = `tokens.${bucket}`
    if (value === null ? field_quality[key] !== 'unknown' : quality[key] === 'unknown') {
      throw new Error(`inconsistent field_quality for ${key}`)
    }
  }
  return JSON.stringify({
    record_id, dedupe_key, revises, actor, reason, envelope: envelope && copyEnvelope(envelope),
    source, source_version, source_event_key, evidence_ref, provider, requested_route,
    actual_model, auth_class, amount: amount && { value: amount.value, unit: amount.unit },
    basis, occurred, received, started, ended, status, exit_reason,
    tokens,
    coverage: { state, field_quality: quality },
  }) + '\n'
}

async function readRows<T>(path: string): Promise<{ rows: T[]; truncateAt?: number }> {
  let data: Buffer
  try {
    data = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { rows: [] }
  }
  const end = data.lastIndexOf(0x0a) + 1
  let truncateAt = end < data.length ? end : undefined
  const lines = data.subarray(0, end).toString('utf8').split('\n')
  lines.pop() // The empty segment after the last newline (or an empty file).
  const rows: T[] = []
  for (const [index, line] of lines.entries()) {
    if (!line) continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch (error) {
      // Only a final line can be torn; don't hide corruption earlier in the file.
      if (index !== lines.length - 1 || truncateAt !== undefined) throw error
      truncateAt = end <= 1 ? 0 : data.lastIndexOf(0x0a, end - 2) + 1
    }
  }
  return { rows, truncateAt }
}

async function appendLine(path: string, line: string, truncateAt?: number): Promise<void> {
  const file = await open(path, 'a')
  try {
    // Remove the torn tail so an unterminated but valid JSON row cannot become committed.
    if (truncateAt !== undefined) await file.truncate(truncateAt)
    await file.writeFile(line)
    await file.datasync()
  } finally {
    await file.close()
  }
}

async function serialized<T>(path: string, action: () => Promise<T>): Promise<T> {
  const write = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(action)
  pending.set(path, write)
  try {
    return await write
  } finally {
    if (pending.get(path) === write) pending.delete(path)
  }
}

function unlinkLock(path: string, owner: Stats): void {
  // A waiter may have already replaced the stale lock, or our own lease may have expired.
  // Keep the identity check and unlink in the same turn.
  try {
    const current = lstatSync(path, { throwIfNoEntry: false })
    if (current?.dev === owner.dev && current.ino === owner.ino) unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function pidIsDead(raw: string): boolean {
  const pid = Number(raw)
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

async function reapStaleLock(path: string): Promise<void> {
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (!file) return
  try {
    const owner = await file.stat()
    if (Date.now() - owner.mtimeMs > 60_000 || pidIsDead(await file.readFile('utf8'))) unlinkLock(path, owner)
  } finally {
    await file.close()
  }
}

async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const path = join(root, '.lock')
  return serialized(path, async () => {
    await mkdir(root, { recursive: true })
    const deadline = performance.now() + 5000
    while (true) {
      const file = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      if (file) {
        try {
          const owner = await file.stat()
          try {
            await file.writeFile(`${process.pid}\n`)
            return await action()
          } finally {
            unlinkLock(path, owner)
          }
        } finally {
          await file.close()
        }
      }
      await reapStaleLock(path)
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error('capture ledger lock timed out')
      await sleep(Math.min(25, remaining))
    }
  })
}

export function jsonlLedger(dir: string): CaptureLedger {
  const root = resolve(dir)
  const spend = join(root, 'spend.jsonl')
  const envelopes = join(root, 'envelopes.jsonl')
  return {
    async registerEnvelope(e) {
      const envelope = copyEnvelope(e)
      await withLock(root, async () => {
        const { rows, truncateAt } = await readRows<Envelope>(envelopes)
        const registered = rows.filter(row => row.trace.execution_id === envelope.trace.execution_id)
        if (registered.some(row => !isDeepStrictEqual(row, envelope))) throw new Error('execution_id conflict')
        if (registered.length > 0) return
        await appendLine(envelopes, JSON.stringify(envelope) + '\n', truncateAt)
      })
    },
    async append(r) {
      const line = spendLine(r)
      const record = JSON.parse(line) as SpendRecord
      return withLock(root, async () => {
        const { rows, truncateAt } = await readRows<SpendRecord>(spend)
        if (rows.some(row => row.record_id === record.record_id && row.dedupe_key !== record.dedupe_key)) {
          throw new Error('record_id conflict')
        }
        const duplicates = rows.filter(row => row.dedupe_key === record.dedupe_key)
        // A pi log can be collected again later; keep its first receipt timestamp.
        if (duplicates.some(row => !isDeepStrictEqual(
          row, record.source === 'pi_json' ? { ...record, received: row.received } : record,
        ))) throw new Error('dedupe_key conflict')
        if (duplicates.length > 0) return { written: false }
        await appendLine(spend, line, truncateAt)
        return { written: true }
      })
    },
  }
}
