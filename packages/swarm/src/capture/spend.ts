import type { BenchRecord } from './collect.ts'
import { copyEnvelope } from './types.ts'
import type { Envelope, SpendRecord, TokenBuckets } from './types.ts'

export interface SpendContext {
  envelope: Envelope | null
  executionIndex?: number
  requested_route?: string | null
  now(): Date | string
  source_version: string
}

export function spendRecords(benchRecords: readonly BenchRecord[], ctx: SpendContext): SpendRecord[] {
  if (ctx.envelope === null) throw new Error('spend capture requires a dispatch envelope')
  const envelope = copyEnvelope(ctx.envelope)
  const execution = envelope.trace.execution_id
  return benchRecords.map(row => {
    // A model can emit all-zero usage placeholders despite having answered.
    const zeroUsage = row.turns > 0 && [row.tokens.in, row.tokens.out, row.tokens.cached, row.tokens.reasoning]
      .every(value => value === 0 || value === null)
    const tokens: TokenBuckets = {
      input_uncached: zeroUsage ? null : row.tokens.in,
      input_total: null,
      output: zeroUsage ? null : row.tokens.out,
      cache_read: zeroUsage ? null : row.tokens.cached,
      cache_write: null,
      reasoning: zeroUsage ? null : row.tokens.reasoning,
    }
    const reportedQuality = row.coverage.tokens === 'partial' ? 'provider_reported_partial' : 'provider_reported'
    const field_quality: Record<string, string> = { amount: 'unknown' }
    for (const [bucket, value] of Object.entries(tokens)) {
      field_quality[`tokens.${bucket}`] = value === null ? 'unknown' : reportedQuality
    }
    const provider = row.model?.provider ?? null
    const actual_model = row.model?.name ?? null
    const modelKey = JSON.stringify([provider, actual_model])
    const dedupe_key = `pi:${execution}:${modelKey}`
    const received = ctx.now()
    return {
      record_id: `sp:${dedupe_key}`,
      dedupe_key,
      revises: null,
      envelope,
      source: 'pi_json',
      source_version: ctx.source_version,
      source_event_key: ctx.executionIndex === undefined
        ? `${execution}:${modelKey}` : `${execution}:${ctx.executionIndex}:${modelKey}`,
      // The collector adds ~N only for multi-model runs; sprite names cannot contain ~.
      evidence_ref: `sprite-log:${row.runId.split('~', 1)[0]}`,
      provider,
      requested_route: ctx.requested_route ?? null,
      actual_model,
      auth_class: null,
      tokens,
      amount: null,
      basis: 'unknown',
      occurred: row.endedAt,
      received: received instanceof Date ? received.toISOString() : received,
      started: row.startedAt,
      ended: row.endedAt,
      status: row.outcome.state === 'done' ? 'completed' : row.outcome.state,
      exit_reason: row.rc !== 0 ? `exit ${row.rc}` : row.outcome.reason ?? 'normal',
      coverage: {
        state: !zeroUsage && row.coverage.tokens === 'complete' ? 'closed_reconciled' : 'partial',
        field_quality,
      },
    }
  })
}
