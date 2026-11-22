import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { correct, ingest, openLedger, rollupLevel, type Intent } from '../src/ledger/index.ts'
import { dispatch, memory, record, seedHierarchy, time } from './support.ts'

function ledgerPath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-spend-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'ledger.sqlite')
}

function intent(intent_id = 'intent', execution_id = 'exec'): Intent {
  return {
    intent_id, execution_id, board_id: 'board', task_id: 'work', claim_epoch: 2,
    fence: 'fence-2', reservation_ref: `reservation:${intent_id}`, created: time,
  }
}

test('a second connection cannot update, delete or replace ledger history', (t) => {
  const path = ledgerPath(t)
  const ledger = openLedger(path)
  const d = dispatch()
  const r = record('original', d.envelope)
  const i = intent()
  try {
    ledger.createDispatch(d)
    ingest(ledger, r)
    ledger.beginIntent(i)
    ledger.confirmReservation('intent', 'fence-2', time)
    correct(ledger, { revises: r.record_id, record_id: 'fix', dedupe_key: 'fix-key', actor: 'auditor',
      reason: 'late report', received: time, changes: { status: 'failed' } })
  } finally {
    ledger.close()
  }

  // Disable foreign keys on this connection so they cannot mask a missing delete guard.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false })
  try {
    for (const [table, change] of [
      ['records', 'output = 99'], ['dispatches', "session = 'rewritten'"],
      ['intents', "fence = 'rewritten'"], ['intent_events', "detail = 'rewritten'"],
    ]) {
      const update = db.prepare(`UPDATE ${table} SET ${change}`)
      const remove = db.prepare(`DELETE FROM ${table}`)
      assert.throws(() => update.run(), Error, `${table} must refuse UPDATE`)
      assert.throws(() => remove.run(), Error, `${table} must refuse DELETE`)
    }
    const refused = { message: 'ledger is append-only' }
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO dispatches
      SELECT execution_id, 'rewritten', repo, work_id, attempt, tier, parent, session, trace_id, sponsor, created
      FROM dispatches WHERE execution_id = 'exec'`), refused, 'REPLACE cannot change the stored party')
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO intents
      SELECT intent_id, execution_id, board_id, task_id, claim_epoch, 'rewritten', reservation_ref, created
      FROM intents WHERE intent_id = 'intent'`), refused, 'REPLACE cannot change the stored fence')
    const replaceRecord = db.prepare(`INSERT OR REPLACE INTO records
      (record_id, dedupe_key, execution_id, source, source_version, source_event_key, evidence_ref,
       output, basis, received, status, coverage_state, field_quality)
      SELECT ?, ?, execution_id, source, source_version, source_event_key, evidence_ref,
       99, basis, received, status, coverage_state, field_quality FROM records WHERE record_id = 'original'`)
    assert.throws(() => replaceRecord.run(r.record_id, 'new-key'), refused, 'REPLACE cannot reuse a record id')
    assert.throws(() => replaceRecord.run('new-record', r.dedupe_key), refused, 'REPLACE cannot reuse a dedupe key')
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO intents
      SELECT 'other-intent', execution_id, board_id, task_id, claim_epoch, 'rewritten', reservation_ref, created
      FROM intents WHERE intent_id = 'intent'`), refused, 'REPLACE cannot take an execution\'s intent by its execution id')
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO intent_events (seq, intent_id, event, at)
      SELECT seq, intent_id, 'compensated', at FROM intent_events WHERE seq = 1`), refused,
    'REPLACE cannot rewrite an intent event by its row id')
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO records
      (record_id, dedupe_key, revises, actor, reason, execution_id, source, source_version, source_event_key,
       evidence_ref, output, basis, received, status, coverage_state, field_quality)
      SELECT 'sneaky', 'sneaky-key', revises, actor, reason, execution_id, source, source_version, source_event_key,
       evidence_ref, 99, basis, received, status, coverage_state, field_quality FROM records WHERE record_id = 'fix'`),
    refused, 'REPLACE cannot take a correction\'s place by what it revises')
  } finally {
    db.close()
  }
  const reopened = openLedger(path)
  try {
    assert.deepEqual(reopened.dispatch('exec'), d)
    assert.deepEqual(reopened.record(r.record_id), r)
    assert.deepEqual(reopened.intent(i.intent_id)?.intent, i)
  } finally {
    reopened.close()
  }
})

test('a concurrent writer is refused and reopening does not lose dispatches, records or intents', (t) => {
  const path = ledgerPath(t)
  const ledger = openLedger(path)
  const d = dispatch()
  const r = record('original', d.envelope)
  const i = intent()
  try {
    ledger.createDispatch(d)
    ingest(ledger, r)
    ledger.beginIntent(i)
    assert.throws(() => openLedger(path).close(), { code: 'locked' }, 'second open must be locked')
  } finally {
    ledger.close()
  }

  const reopened = openLedger(path)
  try {
    assert.deepEqual(reopened.dispatch('exec'), d)
    assert.deepEqual(reopened.record(r.record_id), r)
    assert.deepEqual(reopened.intent(i.intent_id), {
      intent: i, state: 'pending', reservation_confirmed: false, claim_confirmed: false,
    })
  } finally {
    reopened.close()
  }
})

test('pending dispatches reject premature, stale, ambiguous and closed changes without losing reconciliation', (t) => {
  const path = ledgerPath(t)
  const ledger = openLedger(path)
  const i = intent()
  const j = intent('release', 'release-exec')
  try {
    ledger.createDispatch(dispatch(i.execution_id))
    ledger.createDispatch(dispatch(j.execution_id))
    ledger.beginIntent(i)
    ledger.beginIntent(j)
    assert.throws(() => ledger.beginIntent(intent('another-intent')), { code: 'intent_exists' },
      'one execution cannot have two intents')
    ledger.createDispatch(dispatch('unbound'))
    ledger.beginIntent({ ...intent('no-reservation', 'unbound'), reservation_ref: null })
    assert.throws(() => ledger.confirmReservation('no-reservation', 'fence-2', time), { code: 'not_ready' },
      'an intent with no reservation bound at creation cannot confirm one')
    assert.throws(() => ledger.markLaunched(i.intent_id, time), { code: 'not_ready' })
    assert.throws(() => ledger.markAmbiguous(i.intent_id, time), { code: 'not_ready' },
      'an unconfirmed intent cannot be marked ambiguous and reconciled as launched')
    assert.throws(() => ledger.reconcile(i.intent_id, 'launched', time), { code: 'not_ready' })
    assert.throws(() => ledger.confirmReservation(i.intent_id, 'fence-1', time), { code: 'stale_fence' })
    assert.throws(() => ledger.confirmClaim(i.intent_id, 'fence-1', time), { code: 'stale_fence' })
    ledger.confirmReservation(i.intent_id, i.fence, time)
    ledger.confirmClaim(j.intent_id, j.fence, time)
    assert.throws(() => ledger.startLaunch(i.intent_id, i.fence, time), { code: 'not_ready' }, 'reservation alone cannot launch')
    assert.throws(() => ledger.startLaunch(j.intent_id, j.fence, time), { code: 'not_ready' }, 'claim alone cannot launch')
    assert.equal(ledger.confirmClaim(i.intent_id, i.fence, time).state, 'ready')
    assert.throws(() => ledger.markLaunched(i.intent_id, time), { code: 'not_ready' }, 'ready is not a recorded launch')
    assert.throws(() => ledger.startLaunch(i.intent_id, 'fence-1', time), { code: 'stale_fence' }, 'launch needs the current fence')
    assert.equal(ledger.startLaunch(i.intent_id, i.fence, time).state, 'launching')

    assert.equal(ledger.confirmReservation(j.intent_id, j.fence, time).state, 'ready')
    const released = ledger.compensate(j.intent_id, time, 'abandoned')
    assert.equal(released.state, 'compensated')
    assert.deepEqual(ledger.compensate(j.intent_id, time, 'abandoned'), released, 'replaying compensation must not change the release')
    assert.throws(() => ledger.confirmReservation(j.intent_id, j.fence, time), { code: 'intent_closed' })
    assert.throws(() => ledger.startLaunch(j.intent_id, j.fence, time), { code: 'intent_closed' }, 'a released intent cannot launch')
  } finally {
    ledger.close()
  }

  const reopened = openLedger(path)
  try {
    const id = i.intent_id
    const start = () => reopened.startLaunch(id, i.fence, time)
    const compensate = () => reopened.compensate(id, time, 'abandoned')
    assert.deepEqual(reopened.intent(id), {
      intent: i, state: 'launching', reservation_confirmed: true, claim_confirmed: true,
    }, 'the launch request may have been sent before a crash')
    assert.throws(compensate, { code: 'intent_ambiguous' }, 'a persisted launch in progress blocks compensation')
    assert.throws(start, { code: 'intent_ambiguous' }, 'a persisted launch in progress cannot be replayed blindly')
    const ready = reopened.reconcile(id, 'not_launched', time)
    assert.deepEqual(ready, { intent: i, state: 'ready', reservation_confirmed: true, claim_confirmed: true })
    assert.equal(start().state, 'launching', 'definitive no-launch permits a retry')
    assert.equal(reopened.markAmbiguous(id, time).state, 'ambiguous')
    assert.throws(compensate, { code: 'intent_ambiguous' }, 'an ambiguous launch blocks compensation')
    assert.throws(start, { code: 'intent_ambiguous' })
    assert.throws(() => reopened.markLaunched(id, time), { code: 'not_ready' })
    assert.deepEqual(reopened.reconcile(id, 'not_launched', time), ready)
    start()
    assert.equal(reopened.reconcile(id, 'launched', time).state, 'launched')
    assert.throws(compensate, { code: 'intent_closed' })
    assert.throws(() => reopened.markLaunched(id, time), { code: 'intent_closed' })
    assert.throws(() => reopened.markAmbiguous(id, time), { code: 'intent_closed' })
    assert.deepEqual(reopened.intent(j.intent_id), {
      intent: j, state: 'compensated', reservation_confirmed: true, claim_confirmed: true,
    })

    for (const result of ['launched', 'ambiguous'] as const) {
      const next = intent(result, `${result}-exec`)
      reopened.createDispatch(dispatch(next.execution_id))
      reopened.beginIntent(next)
      reopened.confirmReservation(next.intent_id, next.fence, time)
      reopened.confirmClaim(next.intent_id, next.fence, time)
      reopened.startLaunch(next.intent_id, next.fence, time)
      if (result === 'ambiguous') {
        reopened.markAmbiguous(next.intent_id, time)
        assert.equal(reopened.reconcile(next.intent_id, 'launched', time).state, 'launched')
      } else {
        assert.equal(reopened.markLaunched(next.intent_id, time).state, 'launched')
      }
    }
  } finally {
    reopened.close()
  }
})

test('dispatch links cannot cross parties, point to missing executions or point to themselves', (t) => {
  const ledger = memory(t)
  seedHierarchy(ledger)
  const before = rollupLevel(ledger, 'party', { party: 'party' })
  const otherParty = { party: 'party-b' }
  assert.throws(() => ledger.createDispatch(dispatch('foreign-child', { ...otherParty, parent: 'mob' })),
    { code: 'cross_party_link' }, 'a foreign parent would pull spend into another party’s mob')
  assert.throws(() => ledger.createDispatch(dispatch('foreign-sponsor', otherParty, 'old-spawner')),
    { code: 'cross_party_link' }, 'a foreign sponsor would pull spend into another party’s spawner')
  assert.throws(() => ledger.createDispatch(dispatch('orphan', { parent: 'missing' })), { code: 'unknown_dispatch' })
  assert.throws(() => ledger.createDispatch(dispatch('unsponsored', {}, 'missing')), { code: 'unknown_dispatch' })
  assert.throws(() => ledger.createDispatch(dispatch('self-parent', { parent: 'self-parent' })), { code: 'invalid' })
  assert.throws(() => ledger.createDispatch(dispatch('self-sponsor', {}, 'self-sponsor')), { code: 'invalid' })
  assert.deepEqual(rollupLevel(ledger, 'party'), before, 'refused links must leave party roll-ups unchanged')
})

test('ledger writes reject invalid UTC times and free-text compensation reasons', (t) => {
  const ledger = memory(t)
  const d = dispatch()
  const i = intent()
  const badTime = 'not-a-date'
  assert.throws(() => ledger.createDispatch({ ...d, created: badTime }), { code: 'invalid' })
  ledger.createDispatch(d)
  assert.throws(() => ledger.beginIntent({ ...i, created: badTime }), { code: 'invalid' })
  assert.throws(() => ledger.append({ ...record('bad-receipt', d.envelope), received: badTime }), { code: 'invalid' })
  const pending = ledger.beginIntent(i)
  assert.throws(() => ledger.confirmReservation(i.intent_id, i.fence, badTime), { code: 'invalid' }, 'event time must be UTC')
  assert.throws(() => ledger.compensate(i.intent_id, time, 'Launch was abandoned.'), { code: 'invalid' },
    'compensation accepts a short code, not a sentence')
  assert.deepEqual(ledger.intent(i.intent_id), pending, 'invalid events must not change intent state')
})
