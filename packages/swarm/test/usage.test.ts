import { spawnSync as spawnSwarm } from 'node:child_process'
import { test as routingTest } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { capacity } from '@remilia/politburo-runtime'
import { admit } from '../src/usage/admission.ts'
import { stopGuard } from '../src/usage/guard.ts'
import { memoryLedger, type BudgetRule } from '../src/usage/ledger-port.ts'
import { readWakeState, resetWake } from '../src/usage/wake.ts'

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-usage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Fake clock and timer queue; the wake state file and wake implementation are real.
function clock(time = 0) {
  const timers = new Map<() => Promise<void>, number>()
  return {
    now: () => time,
    setTimer(callback: () => Promise<void>, delay: number) {
      timers.set(callback, time + delay)
      return () => { timers.delete(callback) }
    },
    async tick(to: number) {
      for (;;) {
        const next = [...timers].sort((a, b) => a[1] - b[1])[0]
        if (!next || next[1] > to) { time = to; return }
        timers.delete(next[0])
        time = next[1]
        await next[0]()
      }
    },
  }
}

const rule: BudgetRule = { scope: 'party', dimension: 'tokens', window: 'day', warn: 10, hard: 15 }

function fixture(t: TestContext, committed: number | 'unknown' = 0) {
  const time = clock()
  const statePath = join(tempDir(t), 'wake.json')
  const wakes: number[] = []
  // Fake provider usage; the in-memory ledger and capacity policy are real.
  const usage = { usedFraction: 0, resetAt: 100 }
  const ledger = memoryLedger({ usage, committed: () => committed })
  const guard = stopGuard({ source: { read: () => usage }, now: time.now })
  const makeWake = (timer = time) => resetWake({ statePath, ...timer, onWake: () => { wakes.push(timer.now()) } })
  const limits = capacity({ limits: { worker: 1, build: 1, qa: 1, review: 1 } })
  const wake = makeWake()
  const launch = (key: string, amount = 3, budget = rule) => admit({ guard, wake, ledger,
    capacity: limits, rules: [budget], request: { key, kind: 'worker', amounts: { tokens: amount } } })
  return { launch, ledger, usage, wakes, time, makeWake, wake }
}

test('usage stop: dispatch stops early, misses the threshold, or stays blocked after reset', async () => {
  // Fake provider windows and clock.
  const window = { usedFraction: 0, resetAt: 100 }
  const source = { read: () => window }
  for (const [stopPercent, below, at] of [
    [undefined, 0.999, 1], [100, 0.9999999999999999, 1], [90, 0.8999999999999999, 0.9],
    [95, 0.9499999999999998, 0.95],
  ] as const) {
    const time = clock(window.resetAt - 1)
    const guard = stopGuard({ source, now: time.now, ...(stopPercent === undefined ? {} : { stopPercent }) })
    window.usedFraction = below
    assert.deepEqual(await guard.check(), { allowed: true }, `below ${stopPercent ?? 100}%`)
    window.usedFraction = at
    assert.deepEqual(await guard.check(), { allowed: false, resetAt: window.resetAt })
    await time.tick(window.resetAt)
    assert.deepEqual(await guard.check(), { allowed: true }, `at reset for ${stopPercent ?? 100}%`)
  }
})

test('stop percent validation: zero and fractions stop in an active window; invalid numbers throw', async () => {
  for (const [stopPercent, usedFraction] of [[0, 0], [0.5, 0.005]] as const) {
    const source = { read: () => ({ usedFraction, resetAt: 100 }) }
    assert.deepEqual(await stopGuard({ source, stopPercent, now: () => 0 }).check(),
      { allowed: false, resetAt: 100 })
  }
  for (const stopPercent of [-0.001, 100.01, NaN, Infinity])
    assert.throws(() => stopGuard({ source: { read: () => ({ usedFraction: 0, resetAt: 100 }) }, stopPercent }), RangeError)
})

test('fractional cutoffs: floating-point division rounds early or late', async () => {
  const check = (stopPercent: number, usedFraction: number) => stopGuard({
    source: { read: () => ({ usedFraction, resetAt: 100 }) }, stopPercent, now: () => 0,
  }).check()
  const refused = { allowed: false, resetAt: 100 }
  assert.deepEqual(await Promise.all([check(1.00001, 0.0100001), check(1.00002, 0.010000199999999999)]),
    [refused, { allowed: true }], 'exact cutoff and adjacent below')
  assert.deepEqual(await check(1.00002, 0.0100002), refused)
  assert.deepEqual(await check(1e-8, 9.999999999999999e-11), { allowed: true })
  assert.deepEqual(await check(1e-8, 1e-10), refused)
})

test('reset wake after repeated refusals: wake is early, missing, or replayed after restart', async (t) => {
  const { launch, usage, time, wakes, makeWake } = fixture(t)
  usage.usedFraction = 1
  for (const key of ['first', 'second'])
    assert.deepEqual(await launch(key), { admitted: false, reason: 'usage_stop', resetAt: 100 })
  await time.tick(99)
  assert.deepEqual(wakes, [])
  await time.tick(100)
  assert.deepEqual(wakes, [100])
  await makeWake(clock(101)).resume()
  assert.deepEqual(wakes, [100])
})

test('reset wake after downtime: rejection must not mark the wake fired or prevent retry', async (t) => {
  const statePath = join(tempDir(t), 'wake.json')
  const now = () => 101
  let fail = true
  const onWake = async () => {
    await Promise.resolve()
    assert.deepEqual(readWakeState(statePath), { resetAt: 100 })
    if (fail) throw new Error('dispatcher unavailable')
  }
  await resetWake({ statePath, ...clock(), onWake }).arm(100)
  const restarted = resetWake({ statePath, now, onWake }) // The old timer is gone.
  await assert.rejects(restarted.resume(), /dispatcher unavailable/)
  assert.deepEqual(readWakeState(statePath), { resetAt: 100 })
  fail = false
  await restarted.resume()
  assert.deepEqual(readWakeState(statePath), { resetAt: 100, firedAt: 101 })
  await resetWake({ statePath, now, onWake }).resume() // Replaying would fail the callback's assertion.
})

test('corrupt wake state throws without rewriting the file or waking dispatch', async (t) => {
  const statePath = join(tempDir(t), 'wake.json')
  let woke = false
  const wake = resetWake({ statePath, ...clock(101), onWake: () => { woke = true } })
  for (const state of [null, [], {}, { resetAt: 100, firedAT: 101 }, { resetAt: 100, firedAt: 101, extra: 0 },
    { resetAt: -1 }, { resetAt: 1.5 }, { resetAt: 2 ** 53 }, { resetAt: '100' },
    ...[null, -1, 1.5, 2 ** 53, '101'].map(firedAt => ({ resetAt: 100, firedAt }))]) {
    const text = JSON.stringify(state)
    writeFileSync(statePath, text)
    await assert.rejects(wake.resume(), /invalid reset wake state/, text)
    await assert.rejects(wake.arm(200), /invalid reset wake state/, text)
    assert.equal(readFileSync(statePath, 'utf8'), text)
    assert.equal(woke, false)
  }
  const valid = { resetAt: Number.MAX_SAFE_INTEGER, firedAt: 0 }
  writeFileSync(statePath, JSON.stringify(valid))
  assert.deepEqual(readWakeState(statePath), valid)
  writeFileSync(statePath, JSON.stringify({ resetAt: valid.resetAt }))
  const result = spawnSwarm(process.execPath, ['src/cli.ts', 'usage', 'wake', '--state', statePath], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {},
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), `armed for ${valid.resetAt}`)
})

test('reset wake replacement: a superseded window still wakes the dispatcher', async (t) => {
  const { wake, time, wakes } = fixture(t)
  await wake.arm(100)
  await wake.arm(200)
  await time.tick(100)
  assert.deepEqual(wakes, [])
  await time.tick(200)
  assert.deepEqual(wakes, [200])
})

test('hard budget: launch overspends committed plus outstanding or leaves a hold', async (t) => {
  const { launch, ledger } = fixture(t, 6)
  assert.equal((await ledger.reserve(rule, 5, 'existing')).ok, true)
  assert.deepEqual(await launch('over', 5), { admitted: false, reason: 'budget_hard', rule })
  assert.equal(await ledger.outstanding(rule), 5)
})

test('warning ceiling: crossing warn blocks launch or goes unreported', async (t) => {
  const result = await fixture(t, 8).launch('warn')
  assert.equal(result.admitted, true)
  assert.match(result.warnings.join('\n'), /warning ceiling exceeded/)
  await result.release()
})

test('unknown spend: strict admits or admit_warn silently treats missing spend as zero', async (t) => {
  const { launch, ledger } = fixture(t, 'unknown')
  assert.deepEqual(await launch('strict', 3, { ...rule, missing_data_policy: 'strict' }),
    { admitted: false, reason: 'budget_unknown' })
  assert.equal(await ledger.outstanding(rule), 0)
  const result = await launch('warn', 3, { ...rule, missing_data_policy: 'admit_warn' })
  assert.equal(result.admitted, true)
  assert.match(result.warnings.join('\n'), /committed spend unknown/)
  await result.release()
})

test('missing request amount: strict bypasses the rule or admit_warn skips a warning or hard limit', async (t) => {
  const { launch } = fixture(t)
  const missing = { ...rule, dimension: 'cost', missing_data_policy: 'strict' } as const
  assert.deepEqual(await launch('strict', 3, missing), { admitted: false, reason: 'budget_unknown' })
  const warn = { ...missing, missing_data_policy: 'admit_warn' } as const
  const over = { ...warn, hard: 10 }
  assert.deepEqual(await fixture(t, 11).launch('over', 3, over),
    { admitted: false, reason: 'budget_hard', rule: over })
  const result = await launch('warn', 3, warn)
  assert.equal(result.admitted, true)
  assert.deepEqual(result.warnings, ['budget party/cost/day: request amount unknown'])
  await result.release()
})

test('missing amount under admit_warn: a reused key bypasses the hard ceiling after spend rises', async () => {
  let spent = 4
  const usage = { usedFraction: 0, resetAt: 100 }
  const ledger = memoryLedger({ usage, committed: () => spent })
  const guard = stopGuard({ source: { read: () => usage }, now: () => 0 })
  const limits = capacity({ limits: { worker: 2, build: 1, qa: 1, review: 1 } })
  const budget = { ...rule, dimension: 'cost', hard: 10, missing_data_policy: 'admit_warn' } as const
  const launch = () => admit({ guard, wake: { arm() {} }, ledger, capacity: limits,
    rules: [budget], request: { key: 'same', kind: 'worker', amounts: {} } })
  assert.equal((await ledger.reserve(budget, 6, 'other')).ok, true)
  const first = await launch()
  assert.equal(first.admitted, true)
  spent = 5
  assert.deepEqual(await launch(), { admitted: false, reason: 'budget_hard', rule: budget })
  await first.release()
})

test('capacity and release: a refused launch leaks budget or stale release frees a new hold', async (t) => {
  const { launch, ledger } = fixture(t)
  const first = await launch('first')
  assert.equal(first.admitted, true)
  assert.deepEqual(await launch('blocked'), { admitted: false, reason: 'capacity' })
  assert.equal(await ledger.outstanding(rule), 3)
  await first.release()
  assert.equal(await ledger.outstanding(rule), 0)
  const next = await launch('first')
  assert.equal(next.admitted, true)
  await first.release()
  assert.equal(await ledger.outstanding(rule), 3)
  assert.deepEqual(await launch('still blocked'), { admitted: false, reason: 'capacity' })
  await next.release()
})

test('failed release can be retried and failed refusal cleanup stays visible', async (t) => {
  const { launch, ledger } = fixture(t)
  // The external ledger fails once before dropping each hold; use real accounting underneath.
  const reserve = ledger.reserve
  ledger.reserve = async (...args) => {
    const hold = await reserve(...args)
    if (!hold.ok) return hold
    let transient = true
    return { ok: true, async release() {
      if (transient) { transient = false; throw new Error('ledger unavailable') }
      await hold.release()
    } }
  }
  const first = await launch('first')
  assert.equal(first.admitted, true)
  assert.deepEqual(await launch('blocked'), { admitted: false, reason: 'capacity', cleanup_failed: true })
  assert.equal(await ledger.outstanding(rule), 6)
  await assert.rejects(first.release(), /reservation release failed/)
  assert.equal(await ledger.outstanding(rule), 6)
  await first.release()
  assert.equal(await ledger.outstanding(rule), 3) // Only the failed compensation's hold remains.
})

test('reservation retry: the same key consumes budget twice', async (t) => {
  const { ledger } = fixture(t)
  for (let retry = 0; retry < 2; retry++) assert.equal((await ledger.reserve(rule, rule.hard, 'same')).ok, true)
  assert.equal(await ledger.outstanding(rule), rule.hard)
})

test('usage check CLI: exit codes conflate allow, refusal, and misuse or output leaks env', (t) => {
  const file = join(tempDir(t), 'usage.json')
  // Fake only the clock and child environment. No ambient env values enter the child.
  const script = `import { run } from './src/usage/cli.ts'; Date.now = () => 0;
    process.exitCode = await run(process.argv.slice(1));`
  const canary = `usage-check-fixture-${process.pid}`
  for (const [fraction, status, flags] of [[0.999, 0, []], [1, 1, []], [0, 1, ['--stop-percent', '0']],
    [1, 2, ['--stop-percent', '101']], [1, 2, ['--stop-percent', '']]] as const) {
    writeFileSync(file, JSON.stringify({ usedFraction: fraction, resetAt: 100 }))
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, '--',
      'check', '--usage', file, '--json', ...flags], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { WP504_CANARY: canary },
    })
    if (result.error) throw result.error
    assert.equal((result.stdout + result.stderr).includes(canary), false, 'CLI leaked an env value')
    assert.equal(result.status, status)
    if (status !== 2) assert.deepEqual(JSON.parse(result.stdout),
      status === 0 ? { allowed: true } : { allowed: false, resetAt: 100 })
  }
})

routingTest('swarm usage reaches its area: a bad subcommand is the area\'s misuse, not an unknown command', () => {
  const result = spawnSwarm(process.execPath, ['src/cli.ts', 'usage', 'bogus'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 2 || /unknown command/.test(result.stderr)) {
    throw new Error(`not routed to usage: ${result.status} ${result.stderr}`)
  }
})
