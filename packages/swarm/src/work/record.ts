import { createHash } from 'node:crypto'
import { block, type Board } from '@vercel/board'
import { canonical } from '@vercel/board/schemas'
import Ajv from 'ajv'
import type { Link } from './links.ts'
import type { OutcomeCheck } from './validate.ts'

export type WorkKind = 'code' | 'research' | 'report' | 'ops'
export type WorkItemRecord = {
  work_id: string
  repo: string
  kind: WorkKind
  links: readonly Link[]
  contract_revision: string | null
}

export type OutcomeRecord = OutcomeCheck & {
  work_id: string
  party: string
  attempt: number
  contract_revision: string
  checked_at: string
  verifier_version: string
  override: { actor: string; reason: string } | null
}

const object = (properties: Record<string, object>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const text = { type: 'string', minLength: 1 }
const index = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const workSchema = object({
  work_id: text, repo: text, kind: { enum: ['code', 'research', 'report', 'ops'] },
  links: { type: 'array', items: object({
    kind: { enum: ['issue', 'branch', 'pull_request', 'evidence'] },
    source: text, scope: text, ref: text, basis: { enum: ['explicit', 'stable_ref'] },
  }) },
  contract_revision: nullable(text),
})
const outcomeSchema = object({
  work_id: text, party: text, attempt: index, contract_revision: text,
  outcome: nullable(object({ kind: text, index })),
  result: { enum: ['valid', 'invalid', 'unverifiable'] },
  evidence: nullable(object({ ref: text, revision: text })),
  checked_at: text, verifier_version: text,
  override: nullable(object({ actor: text, reason: text })),
})
const ajv = new Ajv.default({ ownProperties: true })
const validWorkItem = ajv.compile<WorkItemRecord>(workSchema)
const validOutcome = ajv.compile<OutcomeRecord>(outcomeSchema)

export async function registerWorkSchemas(board: Board) {
  await board.createSchema({ name: 'outcome-record', version: 1, schema: outcomeSchema })
  await board.createSchema({ name: 'work-item', version: 1, schema: workSchema })
}

export function workItemBlock(record: WorkItemRecord) {
  if (!validWorkItem(record)) throw new TypeError('Invalid work item metadata.')
  return block('work-item@1', record)
}

function isOutcomeRecord(data: unknown): data is OutcomeRecord {
  return validOutcome(data) && (data.override === null || !!data.override.reason.trim())
}

export async function recordOutcome(board: Board, taskId: string, record: OutcomeRecord) {
  if (!isOutcomeRecord(record)) throw new TypeError('Invalid outcome record; an override needs a non-empty reason.')
  let body = record
  if (record.override) {
    const { actor } = await board.me()
    if (record.override.actor !== actor) throw new TypeError('Override actor must match the board handle.')
    body = { ...record, override: { actor, reason: record.override.reason } }
  }
  const key = createHash('sha256').update(canonical([taskId, body])).digest('hex')
  await board.reply(taskId, { text: block('outcome-record@1', body), id: `outcome-record:${key}`, noSync: true })
}

/** Defaults to the handle's actor. A reader using another handle must supply the configured writer. */
export async function readOutcomes(board: Board, taskId: string, author?: string): Promise<OutcomeRecord[]> {
  const writer = author ?? (await board.me()).actor
  const records: OutcomeRecord[] = []
  let after = taskId
  for (;;) {
    const { replies } = await board.thread(taskId, { after, limit: 100 })
    for (const reply of replies) {
      if (reply.deleted || reply.by.actor !== writer) continue
      for (const entry of reply.blocks) {
        if (entry.schema !== 'outcome-record' || entry.version !== 1 || !isOutcomeRecord(entry.data)) continue
        if (entry.data.override && entry.data.override.actor !== reply.by.actor) continue
        records.push(entry.data)
      }
    }
    if (replies.length < 100) return records
    after = replies.at(-1)!.id
  }
}
