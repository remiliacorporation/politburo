import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { ingest, openLedger, type Intent } from '../src/ledger/index.ts'
import { dispatch, record, time } from './support.ts'

function ledgerPath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-spend-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'ledger.sqlite')
}

function intent(intent_id = 'intent'): Intent {
  return {
    intent_id, execution_id: 'exec', board_id: 'board', task_id: 'work', claim_epoch: 2,
    fence: 'fence-2', reservation_ref: `reservation:${intent_id}`, created: time,
  }
}

test('a second connection cannot rewrite or delete ledger history', (t) => {
  const path = ledgerPath(t)
  const ledger = openLedger(path)
  const d = dispatch()
  try {
    ledger.createDispatch(d)
    ingest(ledger, record('original', d.envelope))
    ledger.beginIntent(intent())
    ledger.confirmReservation('intent', 'fence-2', time)
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
  } finally {
    db.close()
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
  const j = intent('release')
  const launch = (id: string) => ledger.markLaunched(id, time)
  const compensate = (id: string) => ledger.compensate(id, time, 'launch abandoned')
  try {
    ledger.createDispatch(dispatch())
    ledger.beginIntent(i)
    ledger.beginIntent(j)
    assert.throws(() => launch(i.intent_id), { code: 'not_ready' })
    assert.throws(() => ledger.confirmReservation(i.intent_id, 'fence-1', time), { code: 'stale_fence' })
    assert.throws(() => ledger.confirmClaim(i.intent_id, 'fence-1', time), { code: 'stale_fence' })
    ledger.confirmReservation(i.intent_id, i.fence, time)
    ledger.confirmClaim(j.intent_id, j.fence, time)
    assert.throws(() => launch(i.intent_id), { code: 'not_ready' }, 'reservation alone cannot launch')
    assert.throws(() => launch(j.intent_id), { code: 'not_ready' }, 'claim alone cannot launch')
    assert.equal(ledger.confirmClaim(i.intent_id, i.fence, time).state, 'ready')

    assert.equal(ledger.markAmbiguous(i.intent_id, time).state, 'ambiguous')
    assert.throws(() => compensate(i.intent_id), { code: 'intent_ambiguous' }, 'ambiguity must block compensation')
    assert.throws(() => launch(i.intent_id), { code: 'intent_ambiguous' })
    assert.equal(ledger.reconcile(i.intent_id, 'not_launched', time).state, 'ready')
    // A retry may return ambiguously too. Reconcile that attempt as launched.
    assert.equal(ledger.markAmbiguous(i.intent_id, time).state, 'ambiguous')
    assert.equal(ledger.reconcile(i.intent_id, 'launched', time).state, 'launched')
    assert.throws(() => compensate(i.intent_id), { code: 'intent_closed' })
    assert.throws(() => launch(i.intent_id), { code: 'intent_closed' }, 'a launched intent cannot launch twice')
    assert.throws(() => ledger.markAmbiguous(i.intent_id, time), { code: 'intent_closed' })

    assert.equal(ledger.confirmReservation(j.intent_id, j.fence, time).state, 'ready')
    const released = compensate(j.intent_id)
    assert.equal(released.state, 'compensated')
    assert.deepEqual(compensate(j.intent_id), released, 'replaying compensation must not change the release')
    assert.throws(() => ledger.confirmReservation(j.intent_id, j.fence, time), { code: 'intent_closed' })
    assert.throws(() => launch(j.intent_id), { code: 'intent_closed' }, 'a released intent cannot launch')

    ledger.beginIntent(intent('retry'))
    ledger.confirmReservation('retry', i.fence, time)
    ledger.confirmClaim('retry', i.fence, time)
    ledger.markAmbiguous('retry', time)
    ledger.reconcile('retry', 'not_launched', time)
    assert.equal(launch('retry').state, 'launched', 'definitive no-launch permits a retry')
  } finally {
    ledger.close()
  }

  const reopened = openLedger(path)
  try {
    assert.deepEqual(reopened.intent(i.intent_id), {
      intent: i, state: 'launched', reservation_confirmed: true, claim_confirmed: true,
    })
    assert.deepEqual(reopened.intent(j.intent_id), {
      intent: j, state: 'compensated', reservation_confirmed: true, claim_confirmed: true,
    })
  } finally {
    reopened.close()
  }
})
