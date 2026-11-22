import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { object } from './facts.ts'
import { sessionFromEvidenceRef, type SpendRecord } from './record.ts'
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
  registry: Pick<SessionRegistry, 'lookup'>
  ledger: SpendWriter
  actor: string
  reason: string
  now?: Date | (() => Date)
}

export function releaseQuarantine({ records, registry, ledger, actor, reason, now = () => new Date() }: ReleaseOptions) {
  let released = 0
  let stillUnbound = 0
  for (const record of records) {
    if (record.envelope !== null || record.coverage.state !== 'unattributed') continue
    const session = sessionFromEvidenceRef(record.evidence_ref)
    const envelope = session === null ? null : registry.lookup(session)
    if (envelope === null) {
      stillUnbound++
      continue
    }
    ledger.append({
      ...record, record_id: randomUUID(), revises: record.record_id, envelope, actor, reason,
      received: (typeof now === 'function' ? now() : now).toISOString(),
      coverage: { ...record.coverage, state: 'partial' },
    })
    // Count release submissions, including deduped replays.
    released++
  }
  return { released, stillUnbound }
}
