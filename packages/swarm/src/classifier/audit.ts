import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Usage } from './adviser.ts'
import type { Answer, TerraCase } from './packet.ts'

export type Decision =
  | { outcome: 'answered'; reason: null; answer: Answer }
  | { outcome: 'refused' | 'unavailable' | 'invalid'; reason: string }

export type AuditRecord = Decision & {
  at: string
  case_id: string
  revision: TerraCase['revision']
  kind: string
  packet_sha256: string
  packet_tokens_est: number
  packet: string
  model: string
  usage?: Usage
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function readLog(dir: string): string {
  try {
    return readFileSync(join(dir, 'terra.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export function readAudit(dir: string): AuditRecord[] {
  const records: AuditRecord[] = []
  for (const line of readLog(dir).split('\n')) {
    if (!line) continue
    try {
      const record = JSON.parse(line)
      if (record && typeof record.case_id === 'string') records.push(record)
    } catch {
      // An interrupted append can leave an incomplete line.
    }
  }
  return records
}

export function appendAudit(dir: string, record: AuditRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = readLog(dir)
  // Keep the next record separate from any torn tail without rewriting the log.
  const separator = log && !log.endsWith('\n') ? '\n' : ''
  appendFileSync(join(dir, 'terra.jsonl'), `${separator}${JSON.stringify(record)}\n`, { mode: 0o600 })
}
