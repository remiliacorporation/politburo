import { randomUUID } from 'node:crypto'
import type { RequestFact } from './facts.ts'
import type { Resolved } from './reconcile.ts'

export type Envelope = {
  party: string
  repo: string | null
  work_id: string | null
  attempt: string | null
  tier: 'core' | 'spawner' | 'secretary' | 'mob' | 'sprite' | 'jockey'
  parent: string | null
  session: string
  trace: { id: string; execution_id: string }
}

// Thin local stand-in; the WP-103 ledger owns the canonical type.
export type SpendRecord = {
  record_id: string
  dedupe_key: string
  envelope: Envelope | null
  source: string
  source_version: string
  source_event_key: string
  evidence_ref: string
  provider: string | null
  requested_route: string | null
  actual_model: string | null
  auth_class: string | null
  tokens: RequestFact['tokens']
  amount: { value: string; unit: string } | null
  basis: 'priced_estimate' | 'settled_charge' | 'measured_resource' | 'unknown' | 'not_applicable'
  occurred: string | null
  received: string
  started: string | null
  ended: string | null
  status: string
  exit_reason?: string
  coverage: {
    state: 'live' | 'pending' | 'partial' | 'unattributed' | 'conflict' | 'closed_reconciled'
    field_quality: Record<string, string>
  }
} & ({ revises: null } | { revises: string; actor: string; reason: string })

export function buildRecord({ fact, state, quality }: Resolved, envelope: Envelope | null, now: Date): SpendRecord {
  const id = fact.requestId ?? fact.responseId
  const eventKey = `${fact.nativeSession}:${id}`
  const conflictKey = state === 'mismatch' ? `claude:${eventKey}:conflict:${fact.source}` : null
  const field_quality: Record<string, string> = { amount: 'unknown' }
  for (const [key, value] of Object.entries(fact.tokens)) {
    field_quality[`tokens.${key}`] = value === null ? 'unknown' : quality
  }
  return {
    record_id: randomUUID(), dedupe_key: conflictKey ?? `claude:${eventKey}`, revises: null,
    envelope,
    source: fact.source === 'otlp' ? 'claude_local_request' : 'claude_local_transcript',
    source_version: 'capture-claude@1', source_event_key: conflictKey ?? eventKey,
    evidence_ref: `claude/${fact.nativeSession}/${id}`,
    provider: 'anthropic', requested_route: 'claude-local', actual_model: fact.model, auth_class: null,
    tokens: { ...fact.tokens }, amount: null, basis: 'unknown',
    occurred: fact.occurred, received: now.toISOString(), started: null, ended: null,
    status: 'completed',
    coverage: {
      state: state === 'mismatch' ? 'conflict' : envelope === null ? 'unattributed'
        : state === 'matched' ? 'closed_reconciled' : 'partial',
      field_quality,
    },
  }
}
