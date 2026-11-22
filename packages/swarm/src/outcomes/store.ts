import { block, type Board, type MessageView } from '@vercel/board'
import type { EvidenceValidation } from './evidence.ts'
import { OUTCOME_KINDS, type OutcomeKind } from './kinds.ts'
import type { ReviewRecord } from './review.ts'

export type OutcomeRecord = {
  work_id: string; party: string; attempt: string; contract_revision: number
  outcome: { kind: OutcomeKind; index: number } | null
  result: EvidenceValidation['result']; evidence: Pick<EvidenceValidation, 'path' | 'sha256'>
  checked_at: string; verifier_version: string; override: null
}

type StoredReview = ReviewRecord & { record: string }

const record = 'outcome-record', review = 'outcome-review'
const text = { type: 'string' }, nil = { type: 'null' }, count = { type: 'integer', minimum: 0 }
const nullable = (schema: object) => ({ anyOf: [schema, nil] })
const object = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})

/** Run once with a handle that can manage schemas. */
export async function registerOutcomeSchemas(board: Pick<Board, 'createSchema'>): Promise<void> {
  await board.createSchema({ name: record, version: 1, schema: object({
    work_id: text, party: text, attempt: text, contract_revision: count,
    outcome: nullable(object({ kind: { enum: Object.keys(OUTCOME_KINDS) }, index: count })),
    result: { enum: ['valid', 'invalid', 'unverifiable'] },
    evidence: object({ path: nullable(text), sha256: nullable(text) }),
    checked_at: nil, verifier_version: text, override: nil,
  }) })
  await board.createSchema({ name: review, version: 1, schema: object({
    work_id: text, record: text, evidence_sha256: text, reviewer: nil, decision: { enum: ['accept', 'reject'] }, reason: text, at: nil,
  }) })
}

// The board cannot interpolate provenance into blocks. Null fields are resolved from the envelope.
export async function writeRecord(board: Board, id: string, data: Omit<OutcomeRecord, 'checked_at'>) {
  const message = await board.reply(id, { text: block(`${record}@1`, { ...data, checked_at: null }), noSync: true })
  return { ...data, checked_at: message.createdAt }
}

export function readRecords(replies: MessageView[]) {
  return replies.flatMap((message, offset) => verified(message) ?
    dataIn<OutcomeRecord>(message, record).map((data) => ({
      record: { ...data, checked_at: message.createdAt }, author: message.by.actor, id: message.id, offset,
    })) : [])
}

function dataIn<T>(message: MessageView, schema: string): T[] {
  return message.deleted || message.editedAt || message.origin || message.from ? [] :
    message.blocks.filter((entry) => entry.schema === schema && entry.version === 1).map((entry) => entry.data as T)
}

const verified = (message: MessageView) => message.author?.verified === true && message.author.kind !== 'external'

export function readReviews(replies: MessageView[]): StoredReview[] {
  return replies.flatMap((message) => verified(message) ?
    dataIn<StoredReview>(message, review).map((data) => ({ ...data, at: message.createdAt, reviewer: message.by.actor })) : [])
}

export async function writeReview(board: Board, id: string, data: Omit<StoredReview, 'at' | 'reviewer'>) {
  const message = await board.reply(id, { text: block(`${review}@1`, { ...data, reviewer: null, at: null }), noSync: true })
  const saved = readReviews([message])[0]
  if (!saved) throw new Error('review requires a verified board author')
  return saved
}
