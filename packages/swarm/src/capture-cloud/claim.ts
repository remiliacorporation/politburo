import { createHash } from 'node:crypto'
import Ajv from 'ajv'
import { tokenCap } from './limits.ts'
import { tokenFields, type Envelope, type SpendRecord, type Tokens } from './record.ts'

export interface Claim {
  source_event_key: string
  model: string
  tokens: Tokens
  started: string | null
  ended: string | null
  occurred: string | null
  status: 'completed' | 'error'
}

const ajv = new Ajv.default({ ownProperties: true, allErrors: true })
const object = (properties: Record<string, object>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const text = { type: 'string' }
const nullableText = { type: 'string', nullable: true }
export const validateEnvelope = ajv.compile<Envelope>(object({
  party: text, repo: nullableText, work_id: nullableText, attempt: nullableText,
  tier: { enum: ['core', 'spawner', 'secretary', 'mob', 'sprite', 'jockey'] },
  parent: nullableText, session: text, trace: object({ id: text, execution_id: text }),
}))

ajv.addFormat('utc', (value: string) => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
})
const time = { type: 'string', nullable: true, maxLength: 40, format: 'utc' }
const count = { type: 'integer', nullable: true, minimum: 0, maximum: tokenCap }
export const validateClaim = ajv.compile<Claim>(object({
  source_event_key: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
  model: { type: 'string', pattern: '^claude-[A-Za-z0-9.-]{1,56}$' },
  tokens: object(Object.fromEntries(tokenFields.map(key => [key, count]))),
  started: time, ended: time, occurred: time, status: { enum: ['completed', 'error'] },
}))

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
export function contentHash(claim: Claim): string {
  return sha256(JSON.stringify([
    claim.source_event_key, claim.model, tokenFields.map(key => claim.tokens[key]),
    claim.started, claim.ended, claim.occurred, claim.status,
  ]))
}

export function toRecord(claim: Claim, entry: { envelope: Envelope }, receivedAt: string): SpendRecord {
  const { envelope } = entry
  const { source_event_key, model, tokens, occurred, started, ended, status } = claim
  const dedupe_key = `claude_cloud:${sha256(JSON.stringify([envelope.trace.execution_id, source_event_key])).slice(0, 40)}`
  const record_id = `cc-${sha256(dedupe_key).slice(0, 24)}`
  const field_quality = Object.fromEntries(tokenFields.map(key => [
    `tokens.${key}`, tokens[key] === null ? 'unknown' : 'claimed_unauthenticated',
  ]))
  return {
    record_id, dedupe_key, revises: null, envelope,
    source: 'claude_cloud_claim', source_version: 1, source_event_key: `sha256:${sha256(source_event_key).slice(0, 32)}`,
    evidence_ref: `capture-cloud/${record_id}`, provider: 'anthropic', requested_route: null,
    actual_model: model, auth_class: null, tokens, amount: null, basis: 'unknown',
    occurred, started, ended, received: receivedAt, status,
    coverage: { state: 'pending', field_quality: { ...field_quality, amount: 'unknown' } },
  }
}
