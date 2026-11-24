export interface Envelope {
  readonly party: string
  readonly repo: string | null
  readonly work_id: string | null
  readonly attempt: string | null
  readonly tier: 'core' | 'spawner' | 'secretary' | 'mob' | 'sprite' | 'jockey'
  readonly parent: string | null
  readonly session: string
  readonly trace: { readonly id: string; readonly execution_id: string }
}

export interface TokenBuckets {
  input_uncached: number | null
  input_total: number | null
  output: number | null
  cache_read: number | null
  cache_write: number | null
  reasoning: number | null
}

export interface SpendRecord {
  record_id: string
  dedupe_key: string
  revises: string | null
  actor?: string
  reason?: string
  readonly envelope: Envelope | null
  source: string
  source_version: string
  source_event_key: string
  evidence_ref: string
  provider: string | null
  requested_route: string | null
  actual_model: string | null
  auth_class: string | null
  tokens: TokenBuckets
  amount: { value: string; unit: string } | null
  basis: 'priced_estimate' | 'settled_charge' | 'measured_resource' | 'unknown' | 'not_applicable'
  occurred: string | null
  received: string
  started: string | null
  ended: string | null
  status: string
  exit_reason: string
  coverage: {
    state: 'live' | 'pending' | 'partial' | 'unattributed' | 'conflict' | 'closed_reconciled'
    field_quality: Record<string, string>
  }
}

export function copyEnvelope(e: Envelope): Envelope {
  const { party, repo, work_id, attempt, tier, parent, session, trace: { id, execution_id } } = e
  return { party, repo, work_id, attempt, tier, parent, session, trace: { id, execution_id } }
}
