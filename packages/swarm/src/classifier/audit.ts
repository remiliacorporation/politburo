import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import type { Usage } from './adviser.ts'
import type { Answer, TerraCase } from './packet.ts'

export type Decision =
  | { outcome: 'answered'; reason: null; answer: Answer }
  | { outcome: 'refused' | 'unavailable' | 'invalid'; reason: string }

export type AuditDecision = Decision | { outcome: 'pending'; reason: null }

export type AuditRecord = AuditDecision & {
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

function readLog(file: string): Buffer {
  try {
    return readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }
}

function parseLog(log: Buffer): { records: AuditRecord[]; tornAt?: number } {
  const records: AuditRecord[] = []
  const lines = log.toString('utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // Only an unterminated last line can be an interrupted append.
      if (index === lines.length - 1) return { records, tornAt: log.lastIndexOf(10) + 1 }
      throw new Error('corrupt audit')
    }
    if (!record || typeof record.case_id !== 'string' ||
      !(typeof record.revision === 'string' || Number.isFinite(record.revision)) ||
      !(record.outcome === 'answered' || record.outcome === 'pending' ||
        (['refused', 'unavailable', 'invalid'].includes(record.outcome) && typeof record.reason === 'string'))) {
      throw new Error('corrupt audit')
    }
    records.push(record)
  }
  return { records }
}

export function readAudit(dir: string): AuditRecord[] {
  return parseLog(readLog(join(dir, 'terra.jsonl'))).records
}

export function appendAudit(dir: string, record: AuditRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'terra.jsonl')
  const log = readLog(file)
  let separator = ''
  if (log.length && log.at(-1) !== 10) {
    const { tornAt } = parseLog(log)
    // Discard the incomplete bytes so they do not become a corrupt middle line.
    if (tornAt !== undefined) truncateSync(file, tornAt)
    else separator = '\n'
  }
  appendFileSync(file, `${separator}${JSON.stringify(record)}\n`, { mode: 0o600, flush: true })
}
