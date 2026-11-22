import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { object } from './facts.ts'
import type { SpendRecord } from './record.ts'
import type { SessionRegistry } from './registry.ts'
import type { SpendWriter } from './writer.ts'

export function readJsonl(path: string): SpendRecord[] {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return []
    throw error
  }
  const records: SpendRecord[] = []
  const lines = contents.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as SpendRecord)
    } catch (error) {
      if (index !== lines.length - 1 || !(error instanceof SyntaxError)) throw error
    }
  }
  return records
}

interface ReleaseOptions {
  records: SpendRecord[]
  existing?: SpendRecord[]
  registry: Pick<SessionRegistry, 'lookup'>
  ledger: SpendWriter
  actor: string
  reason: string
  now?: Date | (() => Date)
}

export function releaseQuarantine({ records, existing = [], registry, ledger, actor, reason, now = () => new Date() }: ReleaseOptions) {
  const ledgerIds = new Map(existing.map((record) => [record.dedupe_key, record.record_id]))
  const attributed = new Map<string, string>()
  let released = 0
  let stillUnbound = 0
  for (const record of records) {
    if (record.envelope !== null) continue
    const existingId = ledgerIds.get(record.dedupe_key)
    if (existingId !== undefined) {
      attributed.set(record.record_id, existingId)
      continue
    }
    const session = /^claude\/([^/]+)\//.exec(record.evidence_ref)?.[1]
    const envelope = session === undefined ? null
      : registry.lookup(session.replace(/%2F|%25/g, (escape) => escape === '%2F' ? '/' : '%'))
    if (envelope === null) {
      stillUnbound++
      continue
    }
    const id = randomUUID()
    // A reconciled or disputed successor must also supersede the attributed original.
    const parent = record.revises === null ? undefined : attributed.get(record.revises)
    ledger.append({
      ...record, record_id: id, revises: parent ?? record.record_id, envelope, actor, reason,
      received: (typeof now === 'function' ? now() : now).toISOString(),
      coverage: record.coverage.state === 'unattributed' ? { ...record.coverage, state: 'partial' } : record.coverage,
    })
    attributed.set(record.record_id, id)
    // SpendWriter has no insertion result: count submissions, including deduped replays.
    released++
  }
  return { released, stillUnbound }
}
