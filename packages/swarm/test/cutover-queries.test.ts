import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const tag = 'abc'
const at = '2025-01-01T12:00:00Z'
const onTime = '2025-01-01T12:00:30Z'

function ledger(t: TestContext, records: object[], options: { raw?: string; exit?: number; since?: string; missing?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-ledger-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'fake ledger.cjs'), data = join(dir, 'ledger.json')
  const expectedArgs = options.since === undefined ? [tag] : [tag, '--since', options.since]
  writeFileSync(data, JSON.stringify({ expectedArgs, stdout: options.raw ?? JSON.stringify(records), exit: options.exit ?? 0 }))
  writeFileSync(script, `
    const { readFileSync } = require('node:fs')
    const assert = require('node:assert/strict')
    const [data, ...args] = process.argv.slice(2)
    const { expectedArgs, stdout, exit } = JSON.parse(readFileSync(data, 'utf8'))
    assert.deepEqual(args, expectedArgs)
    process.stdout.write(stdout)
    process.exitCode = exit
  `)
  const command = options.missing ? [join(dir, 'missing-ledger')] : [process.execPath, script, data]
  return (action: 'soak' | 'acks', ...flags: string[]) => {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'cutover', action, tag,
      '--ledger-cmd', JSON.stringify(command), ...flags], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {}, timeout: 5000,
    })
    if (result.error) throw result.error
    return result
  }
}

function mail(id: string, urgency = 'p1', receipt: object = {}) {
  return { id, urgency, from: 'core', at, ...receipt }
}

function document(result: ReturnType<ReturnType<typeof ledger>>, status: number) {
  assert.equal(result.status, status, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

test('soak does not treat a p1 without deliveredAt as on time', (t) => {
  const run = ledger(t, [mail('missing')])
  const report = document(run('soak', '--json'), 1)
  assert.deepEqual(report.missedP0P1, ['missing'])
  assert.deepEqual(report.lateP1, [])
  assert.equal(report.verdict, 'not clean')
})

test('soak does not ignore a duplicate delivery even when it was on time', (t) => {
  const run = ledger(t, [mail('twice', 'p1', { deliveredAt: onTime, deliveries: 2 })])
  const report = document(run('soak', '--json'), 1)
  assert.deepEqual(report.duplicates, ['twice'])
  assert.equal(report.verdict, 'not clean')
})

test('soak does not call an on-time p0 with missing deliveries clean', (t) => {
  const run = ledger(t, [mail('unknown-count', 'p0', { deliveredAt: onTime })])
  const report = document(run('soak', '--json'), 1)
  assert.deepEqual(report.unknownDeliveries, ['unknown-count'])
  assert.equal(report.verdict, 'not clean')
  const text = run('soak')
  assert.equal(text.status, 1)
  assert.match(text.stdout, /^unknown deliveries +1 \(unknown-count\)$/m)
})

test('soak does not ignore p1 delivery past the configured window or flag its exact boundary', (t) => {
  const run = ledger(t, [
    mail('at-limit', 'p1', { deliveredAt: '2025-01-01T12:02:00Z' }),
    mail('over-limit', 'p1', { deliveredAt: '2025-01-01T12:02:01Z' }),
  ])
  const report = document(run('soak', '--json', '--p1-minutes', '2'), 1)
  assert.deepEqual(report.lateP1, ['over-limit'])
  assert.equal(report.verdict, 'not clean')
})

test('soak does not give p0 more than 60 seconds to arrive', (t) => {
  const run = ledger(t, [mail('late-p0', 'p0', { deliveredAt: '2025-01-01T12:01:01Z' })])
  const report = document(run('soak', '--json'), 1)
  assert.deepEqual(report.lateP0, ['late-p0'])
  assert.equal(report.verdict, 'not clean')
})

test('soak does not treat an unparseable delivery time as a known delay', (t) => {
  const run = ledger(t, [mail('invalid-time', 'p1', { deliveredAt: 'not a date' })])
  const report = document(run('soak', '--json'), 1)
  assert.equal(report.unknownTimes, 1)
  assert.equal(report.verdict, 'not clean')
})

test('soak counts a delivery before send as an unknown time', (t) => {
  const run = ledger(t, [mail('early', 'p0', { deliveredAt: '2025-01-01T11:59:59Z', deliveries: 1 })])
  const report = document(run('soak', '--json'), 1)
  assert.equal(report.unknownTimes, 1)
  assert.deepEqual(report.lateP0, [])
  assert.equal(report.verdict, 'not clean')
})

test('soak counts a sub-millisecond delivery before send as an unknown time', (t) => {
  const run = ledger(t, [mail('early-fraction', 'p0', {
    at: '2025-01-01T12:00:00.0009Z', deliveredAt: '2025-01-01T12:00:00.0001Z', deliveries: 1,
  })])
  const report = document(run('soak', '--json'), 1)
  assert.equal(report.unknownTimes, 1)
  assert.deepEqual(report.lateP0, [])
  assert.equal(report.verdict, 'not clean')
})

test('soak counts impossible send and delivery dates as unknown times', (t) => {
  const run = ledger(t, [
    mail('invalid-send', 'p0', { at: '2025-02-30T12:00:00Z', deliveredAt: '2025-03-02T12:00:30Z', deliveries: 1 }),
    mail('invalid-delivery', 'p0', { at: '2025-03-02T12:00:00Z', deliveredAt: '2025-02-30T12:00:30Z', deliveries: 1 }),
  ])
  const report = document(run('soak', '--json'), 1)
  assert.equal(report.unknownTimes, 2)
  assert.deepEqual(report.lateP0, [])
  assert.equal(report.verdict, 'not clean')
})

test('soak does not call an empty ledger clean', (t) => {
  const run = ledger(t, [])
  assert.equal(document(run('soak', '--json'), 0).verdict, 'empty')
})

for (const [failure, options] of [
  ['malformed JSON', { raw: 'not JSON' }],
  ['nonzero ledger exit despite valid JSON', { exit: 7 }],
  ['a ledger spawn error', { missing: true }],
] as const) {
  test(`soak does not turn ${failure} into a verdict`, (t) => {
    const run = ledger(t, [], options)
    const error = document(run('soak', '--json'), 1)
    assert.equal(error.reason, 'ledger_unreadable')
    assert.equal(error.verdict, undefined)
  })
}

test('soak does not exit unsuccessfully or report dirty for a clean ledger', (t) => {
  const run = ledger(t, [
    mail('p0-at-limit', 'p0', { deliveredAt: '2025-01-01T12:01:00Z', deliveries: 1 }),
    mail('p1-at-default-limit', 'p1', { deliveredAt: '2025-01-01T12:10:00Z', deliveries: 1 }),
  ])
  const report = document(run('soak', '--json'), 0)
  assert.equal(report.verdict, 'clean')
  assert.deepEqual(report.counts, { p0: 1, p1: 1, p2: 0, p3: 0 })
})

test('acks does not omit an old woken but unacked p0 from overdue', (t) => {
  // Anchor the two ages to this run, with room on either side of the cutoff.
  const now = Date.now()
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  const run = ledger(t, [
    { ...mail('old-woken', 'p0'), at: ago(16), deliveredAt: ago(16), wokenAt: ago(1) },
    { ...mail('recent-woken', 'p0'), at: ago(14), deliveredAt: ago(14), wokenAt: ago(1) },
    { ...mail('old-acked', 'p1'), at: ago(20), deliveredAt: ago(19), ackedAt: ago(18) },
    { ...mail('old-p2', 'p2'), at: ago(20) },
  ])
  const report = document(run('acks', '--json'), 0)
  assert.deepEqual(report.overdue, ['old-woken'])
  assert.deepEqual(Object.fromEntries(report.records.map(({ id, state }: { id: string; state: string }) => [id, state])), {
    'old-woken': 'woken', 'recent-woken': 'woken', 'old-acked': 'acked',
  })
})

test('an old p0 with invalid ackedAt has an unknown time and stays overdue', (t) => {
  const run = ledger(t, [mail('invalid-ack', 'p0', { deliveredAt: onTime, deliveries: 1, ackedAt: 'not a date' })])
  const acks = document(run('acks', '--json'), 0)
  assert.equal(acks.records[0].state, 'delivered')
  assert.deepEqual(acks.overdue, ['invalid-ack'])
  const soak = document(run('soak', '--json'), 1)
  assert.equal(soak.unknownTimes, 1)
  assert.equal(soak.verdict, 'not clean')
})

test('acks does not report undelivered p1 as acked', (t) => {
  const run = ledger(t, [mail('not-delivered')])
  const report = document(run('acks', '--json'), 0)
  assert.equal(report.records.find(({ id }: { id: string }) => id === 'not-delivered')?.state, 'undelivered')
})

test('CLI soak does not lose the tag or since argument on the way to the ledger', (t) => {
  const run = ledger(t, [mail('in-window', 'p1', { deliveredAt: onTime, deliveries: 1 })], { since: at })
  const result = run('soak', '--since', at)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^p1 +1$/m)
  assert.match(result.stdout, /^verdict +clean$/m)
})

test('CLI acks does not lose the query route or its delivered row', (t) => {
  const run = ledger(t, [mail('received', 'p0', { deliveredAt: onTime })], { since: at })
  const result = run('acks', '--since', at)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^received +p0 +delivered$/m)
})
