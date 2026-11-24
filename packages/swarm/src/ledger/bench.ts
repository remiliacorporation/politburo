import { isBenchRun } from '@remilia/politburo-runtime'
import { addDecimal } from './decimal.ts'
import { LedgerError } from './errors.ts'
import { BUCKETS, type Envelope, type SpendRecord, type Tokens } from './types.ts'
import { validateRecord } from './validate.ts'

export type BenchOptions = { envelope: Envelope | null; record_id?: string; received: string }

function microsToDecimal(micros: number): string {
  const digits = BigInt(micros).toString().padStart(7, '0')
  return addDecimal(`${digits.slice(0, -6)}.${digits.slice(-6)}`, '0')
}

export function fromBenchRun(run: unknown, o: BenchOptions): SpendRecord | { skipped: 'aggregate' | 'invalid' } {
  if (!isBenchRun(run)) return { skipped: 'invalid' }
  if (run.level !== 'sprite') return { skipped: 'aggregate' }
  const tokens: Tokens = {
    input_uncached: run.tokens.in, input_total: null, output: run.tokens.out,
    cache_read: run.tokens.cached, cache_write: null, reasoning: run.tokens.reasoning,
  }
  const amount = run.costMicros === null ? null : { value: microsToDecimal(run.costMicros), unit: 'USD' }
  const basis = amount === null ? 'unknown' : 'priced_estimate'
  try {
    return validateRecord({
      record_id: o.record_id ?? `bench:${run.runId}`,
      dedupe_key: `bench-run:${run.runId}`, revises: null, envelope: o.envelope,
      source: 'bench-run', source_version: '1', source_event_key: run.runId, evidence_ref: `bench-run:${run.runId}`,
      provider: run.model?.provider ?? null, actual_model: run.model?.name ?? null,
      requested_route: null, auth_class: null,
      tokens, amount, basis, started: run.startedAt, ended: run.endedAt, occurred: run.endedAt, received: o.received,
      status: run.outcome.state,
      // A bench reason may be `exit 124`; a ledger code has no space.
      ...(run.outcome.reason === null ? {} : { exit_reason: run.outcome.reason.replace(/^exit (\d+)$/, 'exit_$1') }),
      coverage: {
        state: o.envelope === null ? 'unattributed' : run.coverage.tokens === 'complete' ? 'closed_reconciled' : 'partial',
        field_quality: {
          ...Object.fromEntries(BUCKETS.map((bucket) => [`tokens.${bucket}`, tokens[bucket] === null ? 'unknown' : 'provider_reported'])),
          amount: basis,
        },
      },
    })
  } catch (error) {
    if (error instanceof LedgerError && error.code === 'invalid') return { skipped: 'invalid' }
    throw error
  }
}
