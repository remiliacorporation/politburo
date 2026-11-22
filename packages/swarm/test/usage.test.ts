import { spawnSync as spawnSwarm } from 'node:child_process'
import { test as routingTest } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { capacity } from '@remilia/politburo-runtime'
import { admit } from '../src/usage/admission.ts'
import { stopGuard } from '../src/usage/guard.ts'
import { memoryLedger, type BudgetRule } from '../src/usage/ledger-port.ts'
import { resetWake } from '../src/usage/wake.ts'

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
  const time = clock()
  const window = { usedFraction: 0, resetAt: 100 }
  const source = { read: () => window }
  for (const [stopPercent, below, at] of [[undefined, 0.999, 1], [90, 0.89, 0.9]] as const) {
    const guard = stopGuard({ source, now: time.now, ...(stopPercent === undefined ? {} : { stopPercent }) })
    window.usedFraction = below
    assert.deepEqual(await guard.check(), { allowed: true })
    window.usedFraction = at
    assert.deepEqual(await guard.check(), { allowed: false, resetAt: window.resetAt })
  }
  for (const stopPercent of [0, 101]) assert.throws(() => stopGuard({ source, stopPercent }), RangeError)
  window.usedFraction = 1
  await time.tick(101)
  assert.deepEqual(await stopGuard({ source, now: time.now }).check(), { allowed: true })
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

test('reset wake after downtime: an unfired, overdue wake is lost or replayed', async (t) => {
  const { wake, makeWake, wakes } = fixture(t)
  await wake.arm(100)
  const restarted = makeWake(clock(101)) // The old process and its timer are gone.
  await restarted.resume()
  await restarted.resume()
  assert.deepEqual(wakes, [101])
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

test('reservation retry: the same key consumes budget twice', async (t) => {
  const { ledger } = fixture(t)
  for (let retry = 0; retry < 2; retry++) assert.equal((await ledger.reserve(rule, 4, 'same')).ok, true)
  assert.equal(await ledger.outstanding(rule), 4)
})

test('usage check CLI: exit codes conflate allow, refusal, and misuse or output leaks env', (t) => {
  const file = join(tempDir(t), 'usage.json')
  // Fake only the clock and child environment. No ambient env values enter the child.
  const script = `import { run } from './src/usage/cli.ts'; Date.now = () => 0;
    process.exitCode = await run(process.argv.slice(1));`
  const canary = 'usage-check-fixture-canary'
  for (const [fraction, status, flags] of [[0.999, 0, []], [1, 1, []], [1, 2, ['--stop-percent', '0']]] as const) {
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
