import type { SQLInputValue } from 'node:sqlite'
import { LedgerError, type LedgerErrorCode } from './errors.ts'
import { schema, SCHEMA_VERSION } from './schema.ts'
import type {
  AppendOutcome, Dispatch, Envelope, Intent, IntentView, SpendRecord,
} from './types.ts'
import { validateCode, validateDispatch, validateId, validateIntent, validateRecord, validateTime } from './validate.ts'

export type Ledger = {
  createDispatch(d: Dispatch): { outcome: 'created' | 'existing' }
  dispatch(executionId: string): Dispatch | null
  dispatches(): readonly Dispatch[]
  beginIntent(i: Intent): IntentView
  intent(id: string): IntentView | null
  confirmReservation(id: string, fence: string, at: string): IntentView
  confirmClaim(id: string, fence: string, at: string): IntentView
  /** Persist before sending a launch request. Reconcile if the outcome is uncertain. */
  startLaunch(id: string, fence: string, at: string): IntentView
  markAmbiguous(id: string, at: string): IntentView
  reconcile(id: string, observed: 'launched' | 'not_launched', at: string): IntentView
  markLaunched(id: string, at: string): IntentView
  compensate(id: string, at: string, reason: string): IntentView
  append(r: SpendRecord): AppendOutcome
  record(id: string): SpendRecord | null
  chain(id: string): SpendRecord[]
  heads(): readonly SpendRecord[]
  close(): void
}

function fail(code: LedgerErrorCode, message: string): never {
  throw new LedgerError(code, message)
}

const choice = (values: readonly string[]) => (v: unknown, f: string): void => {
  if (typeof v !== 'string' || !values.includes(v)) fail('invalid', `${f} has an invalid value`)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  })
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b)

type DispatchRow = Omit<Envelope, 'trace'> & { execution_id: string; trace_id: string; sponsor: string | null; created: string }
function readDispatch(row: DispatchRow): Dispatch {
  const { execution_id, trace_id, sponsor, created, ...envelope } = row
  return { envelope: { ...envelope, trace: { id: trace_id, execution_id } }, sponsor, created }
}
type RecordRow = Omit<SpendRecord, 'envelope' | 'tokens' | 'amount' | 'coverage' | 'actor' | 'reason' | 'exit_reason'>
  & SpendRecord['tokens'] & {
    seq: number; execution_id: string | null; amount_value: string | null; amount_unit: string | null
    actor: string | null; reason: string | null; exit_reason: string | null
    coverage_state: SpendRecord['coverage']['state']; field_quality: string
  }
type IntentEvent = 'reservation_confirmed' | 'claim_confirmed' | 'launch_started' | 'ambiguous' | 'reconciled_launched'
  | 'reconciled_not_launched' | 'launched' | 'compensated'

function sqliteCode(error: unknown): number {
  return error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? error.errcode : 0
}
function sqlFailure(error: unknown): never {
  const primary = sqliteCode(error) & 0xff
  if (primary === 5 || primary === 6) fail('locked', 'the ledger file is locked')
  if (primary === 19) fail('invalid', 'a ledger constraint rejected the input')
  throw error
}

export function openLedger(path: string): Ledger {
  // Loading SQLite on first use keeps an import of this module quiet.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(path)
  const get = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined
  const all = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[]
  // SQL identifiers come only from the column lists and table names in this file.
  function insert(table: string, row: Record<string, SQLInputValue>) {
    const columns = Object.keys(row)
    db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...Object.values(row))
  }
  function write<T>(fn: () => T): T {
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        // Rollback can already have happened on a SQLite I/O failure.
        try { db.exec('ROLLBACK') } catch { /* preserve the original error */ }
        throw error
      }
    } catch (error) {
      return sqlFailure(error)
    }
  }
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE')
    if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=FULL')
    write(() => {}) // Take the writer lock now, and retain it until close.
    const version = get<{ user_version: number }>('PRAGMA user_version')?.user_version
    if (version === 0 && !get('SELECT 1 FROM sqlite_schema LIMIT 1')) {
      write(() => db.exec(`${schema}\nPRAGMA user_version=${SCHEMA_VERSION}`))
    } else if (version !== SCHEMA_VERSION) {
      fail('version', 'unsupported ledger schema version')
    }
  } catch (error) {
    db.close()
    return sqlFailure(error)
  }

  function dispatch(id: string): Dispatch | null {
    const row = get<DispatchRow>('SELECT * FROM dispatches WHERE execution_id=?', id)
    return row ? readDispatch(row) : null
  }
  function intent(id: string): IntentView | null {
    const row = get<Intent>('SELECT * FROM intents WHERE intent_id=?', id)
    if (!row) return null
    let reservation = false, claim = false
    let phase: 'launching' | 'ambiguous' | 'launched' | 'compensated' | null = null
    for (const { event } of all<{ event: IntentEvent }>('SELECT event FROM intent_events WHERE intent_id=? ORDER BY seq', id)) {
      switch (event) {
        case 'reservation_confirmed': reservation = true; break
        case 'claim_confirmed': claim = true; break
        case 'launch_started': phase = 'launching'; break
        case 'ambiguous': phase = 'ambiguous'; break
        // A definitive no-launch keeps both confirmations, so a ready intent can retry.
        case 'reconciled_not_launched': phase = null; break
        case 'launched': case 'reconciled_launched': phase = 'launched'; break
        case 'compensated': phase = 'compensated'; break
      }
    }
    return { intent: { ...row }, state: phase ?? (reservation && claim ? 'ready' : 'pending'),
      reservation_confirmed: reservation, claim_confirmed: claim }
  }
  function notClosed(view: IntentView): void {
    if (view.state === 'launched' || view.state === 'compensated') fail('intent_closed', 'the intent is closed')
  }
  function active(view: IntentView): void {
    notClosed(view)
    if (view.state === 'launching' || view.state === 'ambiguous') fail('intent_ambiguous', 'reconcile the intent first')
  }
  function launchResult(view: IntentView, event: 'launched' | 'ambiguous'): IntentEvent {
    notClosed(view)
    if (view.state !== 'launching') fail('not_ready', 'the intent has no launch in progress')
    return event
  }
  function change(id: string, at: string, next: (view: IntentView) => IntentEvent | null, reason?: string): IntentView {
    validateId(id, 'intent_id'); validateTime(at, 'at')
    return write(() => {
      const view = intent(id) ?? fail('unknown_intent', 'the intent does not exist')
      const event = next(view)
      if (event === null) return view
      insert('intent_events', { intent_id: id, event, at, detail: reason ?? null })
      return intent(id)!
    })
  }
  function confirm(id: string, fence: string, at: string, which: 'reservation_confirmed' | 'claim_confirmed') {
    validateId(fence, 'fence')
    return change(id, at, view => {
      // The intent is immutable, so a reservation can only be confirmed if one was bound at creation.
      if (which === 'reservation_confirmed' && view.intent.reservation_ref === null) {
        fail('not_ready', 'the intent has no reservation to confirm')
      }
      if (view.intent.fence !== fence) fail('stale_fence', 'the fence does not match the intent')
      active(view)
      return view[which] ? null : which
    })
  }

  function readRecord(row: RecordRow): SpendRecord {
    const { seq, execution_id, amount_value, amount_unit, coverage_state, field_quality, actor, reason, exit_reason,
      input_uncached, input_total, output, cache_read, cache_write, reasoning, ...fact } = row
    return {
      ...fact,
      envelope: execution_id === null ? null : dispatch(execution_id)!.envelope,
      tokens: { input_uncached, input_total, output, cache_read, cache_write, reasoning },
      amount: amount_value === null ? null : { value: amount_value, unit: amount_unit! },
      coverage: { state: coverage_state, field_quality: JSON.parse(field_quality) },
      ...(actor === null ? {} : { actor }), ...(reason === null ? {} : { reason }),
      ...(exit_reason === null ? {} : { exit_reason }),
    }
  }
  const recordRow = (id: string) => get<RecordRow>('SELECT * FROM records WHERE record_id=?', id)
  const successor = (id: string) => get<RecordRow>('SELECT * FROM records WHERE revises=?', id)
  function checkLinks(r: SpendRecord): string | null {
    const id = r.envelope?.trace.execution_id ?? null
    if (id !== null) {
      const d = dispatch(id) ?? fail('unknown_dispatch', 'the dispatch does not exist')
      if (!equal(d.envelope, r.envelope)) fail('envelope_mismatch', 'the envelope differs from the stored dispatch')
    }
    if (r.revises !== null) {
      const parent = recordRow(r.revises) ?? fail('unknown_revision', 'the revised record does not exist')
      if (successor(r.revises)) fail('already_revised', 'the revised record is not a head')
      if (parent.execution_id !== null && parent.execution_id !== id) fail('moves_charge', 'a correction cannot move a charge')
    }
    return id
  }

  return {
    createDispatch(input) {
      const d = validateDispatch(input)
      return write(() => {
        const { trace, ...envelope } = d.envelope
        const links = [envelope.parent, d.sponsor]
        if (links.includes(trace.execution_id)) fail('invalid', 'a dispatch cannot link to itself')
        const existing = dispatch(trace.execution_id)
        if (existing) {
          if (!equal(existing, d)) fail('dispatch_conflict', 'the execution id has a different dispatch')
          return { outcome: 'existing' }
        }
        for (const link of links) {
          if (link === null) continue
          const linked = dispatch(link) ?? fail('unknown_dispatch', 'the linked dispatch does not exist')
          if (linked.envelope.party !== envelope.party) fail('cross_party_link', 'the linked dispatch belongs to another party')
        }
        insert('dispatches', { ...envelope, execution_id: trace.execution_id, trace_id: trace.id,
          sponsor: d.sponsor, created: d.created })
        return { outcome: 'created' }
      })
    },
    dispatch,
    dispatches: () => all<DispatchRow>('SELECT * FROM dispatches ORDER BY rowid').map(readDispatch),
    beginIntent(input) {
      const i = validateIntent(input)
      return write(() => {
        if (!dispatch(i.execution_id)) fail('unknown_dispatch', 'the dispatch does not exist')
        const existing = intent(i.intent_id)
        if (existing) {
          if (!equal(existing.intent, i)) fail('intent_exists', 'the intent id has different content')
          return existing
        }
        if (get('SELECT 1 FROM intents WHERE execution_id=?', i.execution_id)) {
          fail('intent_exists', 'the execution already has an intent')
        }
        insert('intents', i)
        return { intent: { ...i }, state: 'pending', reservation_confirmed: false, claim_confirmed: false }
      })
    },
    intent,
    confirmReservation: (id, fence, at) => confirm(id, fence, at, 'reservation_confirmed'),
    confirmClaim: (id, fence, at) => confirm(id, fence, at, 'claim_confirmed'),
    startLaunch(id, fence, at) {
      validateId(fence, 'fence')
      return change(id, at, view => {
        active(view)
        if (view.state !== 'ready') fail('not_ready', 'only a ready intent can start a launch')
        if (view.intent.fence !== fence) fail('stale_fence', 'the fence does not match the intent')
        return 'launch_started'
      })
    },
    markAmbiguous: (id, at) => change(id, at, view => launchResult(view, 'ambiguous')),
    reconcile(id, observed, at) {
      choice(['launched', 'not_launched'])(observed, 'observed')
      return change(id, at, view => {
        notClosed(view)
        if (view.state !== 'launching' && view.state !== 'ambiguous') {
          fail('not_ready', 'only an uncertain launch can be reconciled')
        }
        return observed === 'launched' ? 'reconciled_launched' : 'reconciled_not_launched'
      })
    },
    markLaunched: (id, at) => change(id, at, view => launchResult(view, 'launched')),
    compensate(id, at, reason) {
      validateCode(reason, 'reason')
      return change(id, at, view => {
        if (view.state === 'compensated') return null
        active(view)
        return 'compensated'
      }, reason)
    },
    append(input) {
      const r = validateRecord(input)
      return write(() => {
        function duplicate(): AppendOutcome | null {
          const existing = get<RecordRow>('SELECT * FROM records WHERE dedupe_key=?', r.dedupe_key)
          return existing ? { outcome: equal(readRecord(existing), r) ? 'duplicate' : 'dedupe_mismatch',
            record_id: existing.record_id } : null
        }
        const replay = duplicate()
        if (replay) return replay
        if (recordRow(r.record_id)) fail('record_id_taken', 'the record id has another dedupe key')
        const execution_id = checkLinks(r)
        const { envelope, tokens, amount, coverage, actor, reason, exit_reason, ...fact } = r
        try {
          insert('records', { ...fact, ...tokens, execution_id, actor: actor ?? null, reason: reason ?? null,
            exit_reason: exit_reason ?? null, amount_value: amount?.value ?? null, amount_unit: amount?.unit ?? null,
            coverage_state: coverage.state, field_quality: canonical(coverage.field_quality) })
        } catch (error) {
          // The writer lock normally prevents races. Translate the database's backstops too.
          const code = sqliteCode(error)
          if (code === 2067) { // SQLITE_CONSTRAINT_UNIQUE
            const replay = duplicate()
            if (replay) return replay
            if (recordRow(r.record_id)) fail('record_id_taken', 'the record id has another dedupe key')
            if (r.revises !== null && successor(r.revises)) fail('already_revised', 'the revised record is not a head')
          }
          if (code === 787 || code === 1811) checkLinks(r) // foreign key or revision trigger
          throw error
        }
        return { outcome: 'appended', record_id: r.record_id }
      })
    },
    record(id) {
      const row = recordRow(id)
      return row ? readRecord(row) : null
    },
    chain(id) {
      const row = recordRow(id)
      if (!row) return []
      const chain: SpendRecord[] = []
      for (let p = row; p.revises !== null;) {
        p = recordRow(p.revises)!
        chain.push(readRecord(p))
      }
      chain.reverse()
      for (let p: RecordRow | undefined = row; p; p = successor(p.record_id)) chain.push(readRecord(p))
      return chain
    },
    heads: () => all<RecordRow>('SELECT * FROM heads ORDER BY seq').map(readRecord),
    close: () => db.close(),
  }
}
