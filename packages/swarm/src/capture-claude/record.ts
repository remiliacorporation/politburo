import { randomUUID } from 'node:crypto'
import { buckets, type RequestFact } from './facts.ts'
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

export function tokenFingerprint(tokens: SpendRecord['tokens']): string {
  return JSON.stringify(buckets.map((key) => tokens[key]))
}

function conflictDedupeKey(key: string, source: string, tokens: SpendRecord['tokens']): string {
  return `${key}:conflict:${source}:${tokenFingerprint(tokens)}`
}

const chainRoot = new Map<string, string>()
const chainHead = new Map<string, string>()
const chainKeys = new Map<string, Set<string>>()

export function conflictSuccessor(original: { record_id: string }, record: SpendRecord, actor: string): SpendRecord {
  const source = record.source === 'claude_local_request' ? 'otlp'
    : record.source === 'claude_local_transcript' ? 'transcript' : record.source
  const root = chainRoot.get(original.record_id) ?? original.record_id
  const head = chainHead.get(root) ?? root
  const dedupe_key = conflictDedupeKey(record.dedupe_key, source, record.tokens)
  const successor: SpendRecord = {
    ...record, dedupe_key, revises: head, actor, reason: 'conflicting report',
    coverage: { ...record.coverage, state: 'conflict' },
  }
  const seen = chainKeys.get(root) ?? new Set<string>()
  if (!seen.has(dedupe_key)) {
    seen.add(dedupe_key)
    chainKeys.set(root, seen)
    chainHead.set(root, successor.record_id)
    chainRoot.set(original.record_id, root)
    chainRoot.set(successor.record_id, root)
  }
  return successor
}

function evidencePrefix(nativeSession: string): string {
  return `claude/${nativeSession.replace(/%/g, '%25').replace(/\//g, '%2F')}/`
}

export function sessionFromEvidenceRef(ref: string): string | null {
  const session = /^claude\/([^/]+)\/[^/]+$/.exec(ref)?.[1]
  if (session === undefined || /%(?!25|2F)/.test(session)) return null
  return session.replace(/%25|%2F/g, (escape) => escape === '%25' ? '%' : '/')
}

export function buildRecord({ fact, state, quality }: Resolved, envelope: Envelope | null, now: Date): SpendRecord {
  const id = fact.gap !== undefined ? `gap:${fact.gap}`
    : [fact.requestId ?? '', fact.responseId ?? ''].map(encodeURIComponent).join(':')
  const eventKey = `${encodeURIComponent(fact.nativeSession)}:${id}`
  const dedupeKey = `claude:${eventKey}`
  const conflictKey = state === 'mismatch' ? conflictDedupeKey(dedupeKey, fact.source, fact.tokens) : null
  const field_quality: Record<string, string> = { amount: 'unknown' }
  for (const [key, value] of Object.entries(fact.tokens)) {
    field_quality[`tokens.${key}`] = value === null ? 'unknown' : quality
  }
  return {
    record_id: randomUUID(), dedupe_key: conflictKey ?? dedupeKey, revises: null,
    envelope,
    source: fact.source === 'otlp' ? 'claude_local_request' : 'claude_local_transcript',
    source_version: 'capture-claude@1', source_event_key: conflictKey ?? eventKey,
    evidence_ref: `${evidencePrefix(fact.nativeSession)}${id}`,
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
