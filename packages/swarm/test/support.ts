import type { TestContext } from 'node:test'
import { ingest, openLedger, type Dispatch, type Envelope, type Ledger, type SpendRecord } from '../src/ledger/index.ts'

export const time = '2026-01-01T00:00:00.000Z'

export function dispatch(execution_id = 'exec', fields: Partial<Envelope> = {}, sponsor: string | null = null): Dispatch {
  return {
    envelope: {
      party: 'party', repo: 'repo', work_id: 'work', attempt: 'attempt', tier: 'sprite',
      parent: null, session: `session:${execution_id}`, trace: { id: 'trace', execution_id }, ...fields,
    },
    sponsor, created: time,
  }
}

export function record(id: string, envelope: Envelope | null, output: number | null = 10): SpendRecord {
  return {
    record_id: id, dedupe_key: `sample:${id}`, revises: null, envelope,
    source: 'sample', source_version: '1', source_event_key: id, evidence_ref: `usage/${id}`,
    provider: null, requested_route: null, actual_model: null, auth_class: null,
    tokens: { input_uncached: null, input_total: null, output, cache_read: null, cache_write: null, reasoning: null },
    amount: null, basis: 'unknown', occurred: null, received: time, started: null, ended: null, status: 'completed',
    coverage: {
      state: envelope === null ? 'unattributed' : 'partial',
      field_quality: {
        'tokens.input_uncached': 'unknown', 'tokens.input_total': 'unknown',
        'tokens.output': output === null ? 'unknown' : 'provider_reported',
        'tokens.cache_read': 'unknown', 'tokens.cache_write': 'unknown', 'tokens.reasoning': 'unknown', amount: 'unknown',
      },
    },
  }
}

export function memory(t: TestContext): Ledger {
  const ledger = openLedger(':memory:')
  t.after(() => ledger.close())
  return ledger
}

export function seedHierarchy(ledger: Ledger) {
  const facts = [
    [dispatch('old-spawner', { tier: 'spawner', repo: null, work_id: null, attempt: null }), 2],
    [dispatch('new-spawner', { tier: 'spawner', work_id: null, attempt: null }), 3],
    [dispatch('direct', { tier: 'secretary' }, 'old-spawner'), 5],
    [dispatch('mob', { tier: 'mob', parent: 'old-spawner' }, 'old-spawner'), 7],
    [dispatch('submob', { tier: 'mob', parent: 'mob' }, 'old-spawner'), 11],
    [dispatch('sprite', { parent: 'submob' }, 'old-spawner'), 13],
    [dispatch('child-secretary', { tier: 'secretary', parent: 'mob' }, 'old-spawner'), 17],
  ] as const
  for (const [d, output] of facts) {
    ledger.createDispatch(d)
    ingest(ledger, record(d.envelope.trace.execution_id, d.envelope, output))
  }
}
