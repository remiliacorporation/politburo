import assert from 'node:assert/strict'
import childProcess, { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { run } from '../src/cutover/cli.ts'
import { apply, rollback, type Context } from '../src/cutover/cutover.ts'
import type { ProcessPort } from '../src/cutover/ports.ts'
import type { State } from '../src/cutover/state.ts'

const tag = 'pb'

function rehearsal(t: TestContext, mode: State['mode'] = 'files', pending?: State['pending']) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-cutover-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateDir = join(dir, 'state'), stateFile = join(stateDir, `${tag}.json`), gateFile = join(dir, 'gate.json')
  const gate = { tag, decision: 'proceed', by: 'core', at: new Date(Date.now() - 60_000).toISOString(),
    evidence: 'synthetic private rehearsal notes' }
  writeFileSync(gateFile, JSON.stringify(gate))
  if (mode === 'service' || pending) {
    mkdirSync(stateDir)
    writeFileSync(stateFile, JSON.stringify({ tag, mode, pending, history: [] }))
  }
  const state = (): State => JSON.parse(readFileSync(stateFile, 'utf8'))
  const running = { oldLoop: mode === 'files' && pending !== 'applying', service: mode === 'service' }
  type Loop = keyof typeof running
  type Sync = 'current' | 'stale' | 'fail' | 'hang'
  const controls: { sync: () => Sync; failStart?: Loop; unconfirmedStop?: Loop } = { sync: () => 'current' }
  let current = false
  let stopUnconfirmed: Loop | undefined
  const events: { action: string; oldLoop: boolean; service: boolean; current: boolean; pending?: State['pending'] }[] = []
  const record = (action: string) => events.push({ action, ...running, current,
    pending: existsSync(stateFile) ? state().pending : undefined })
  const process = (loop: Loop): ProcessPort => ({
    async start() {
      if (controls.failStart === loop) {
        record(`${loop}.start failed`)
        throw new Error('test process did not start')
      }
      running[loop] = true
      record(`${loop}.start`)
    },
    async stop() {
      if (controls.unconfirmedStop === loop) stopUnconfirmed = loop
      else {
        running[loop] = false
        // Mail delivered during service shutdown is not in the pre-stop drain.
        if (loop === 'service') current = false
      }
      record(`${loop}.stop`)
    },
    async status() { return stopUnconfirmed === loop ? 'unknown' : running[loop] ? 'running' : 'stopped' },
  })
  const lines: string[] = []
  const ctx: Context = { stateDir, gateFile, clock: Date, log: (line) => lines.push(line), ports: {
    oldLoop: process('oldLoop'), service: process('service'), bridge: {
      async status() { return { current } },
      async sync() {
        const outcome = controls.sync()
        current = outcome === 'current'
        record(`bridge.${outcome}`)
        if (outcome === 'hang') return new Promise<never>(() => {})
        if (outcome === 'fail') throw new Error('test bridge failed')
        return { current }
      },
    },
  } }
  return { dir, stateFile, gateFile, gate, ctx, state, running, events, lines, controls,
    assertNoOverlap() {
      // Every process transition is logged, including transient states before recovery.
      for (const event of events) assert.ok(!(event.oldLoop && event.service), `both running after ${event.action}`)
    },
  }
}

function cliRehearsal(t: TestContext, f: ReturnType<typeof rehearsal>) {
  const commands = join(f.dir, 'commands.json')
  const { service, oldLoop, bridge } = f.ctx.ports
  const health = { running: 0, stopped: 1, unknown: 2 }
  const handlers: Record<string, () => Promise<number | void>> = {
    'service.start': () => service.start(tag), 'service.stop': () => service.stop(tag),
    'service.status': async () => health[await service.status(tag)],
    'oldLoop.start': () => oldLoop.start(tag), 'oldLoop.stop': () => oldLoop.stop(tag),
    'oldLoop.status': async () => health[await oldLoop.status(tag)],
    'bridge.sync': async () => (await bridge.sync(tag)).current ? 0 : 1,
    'bridge.status': async () => (await bridge.status(tag)).current ? 0 : 1,
  }
  writeFileSync(commands, JSON.stringify({ [tag]: {
    service: { start: ['service.start'], stop: ['service.stop'], status: ['service.status'] },
    oldLoop: { start: ['oldLoop.start'], stop: ['oldLoop.stop'], status: ['oldLoop.status'] },
    bridge: { sync: ['bridge.sync'], status: ['bridge.status'] },
  } }))
  const spawnReal = childProcess.spawn
  const spawn = t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
    // The lock helper is real; no service, old-loop, or bridge command is spawned.
    if (command === 'perl') return spawnReal(command, args, options)
    const child = new EventEmitter() as ChildProcess
    void Promise.resolve().then(() => handlers[command]?.() ?? 2)
      .then((code) => child.emit('close', code ?? 0), (error) => child.emit('error', error))
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports() })
  const output: string[] = []
  t.mock.method(console, 'log', (line: string) => output.push(line))
  const execute = (action: 'apply' | 'rollback', stateDir = f.ctx.stateDir, file = commands, flags: string[] = []) => run([
    action, tag, '--execute', '--commands', file, '--state-dir', stateDir, '--gate', f.gateFile, '--json', ...flags,
  ])
  return { commands, output, execute }
}

test('apply does not touch the loops without a gate file', async (t) => {
  const f = rehearsal(t)
  rmSync(f.gateFile)
  await assert.rejects(apply(tag, f.ctx), { reason: 'gate_missing' })
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.running, { oldLoop: true, service: false })
  assert.equal(existsSync(f.ctx.stateDir), false)

  const errors: string[] = []
  t.mock.method(console, 'error', (line: string) => errors.push(line))
  assert.equal(await run(['apply', tag, '--execute', '--state-dir', f.ctx.stateDir]), 1)
  assert.match(errors.join('\n'), /^error: a gate decision file is required/)
  assert.equal(existsSync(f.ctx.stateDir), false)
})

for (const [condition, override, headline] of [
  ['for another tag', { tag: 'abc' }, /wrong tag/],
  ['with a hold decision', { decision: 'hold' }, /must be proceed/],
  ['with an unknown field', { unexpected: true }, /unknown fields/],
  ['dated in the future', { at: '2099-01-01T00:00:00.000Z' }, /future/],
] as const) {
  test(`apply does not accept a gate ${condition}`, async (t) => {
    const f = rehearsal(t)
    writeFileSync(f.gateFile, JSON.stringify({ ...f.gate, ...override }))
    await assert.rejects(apply(tag, f.ctx), { reason: 'gate_invalid', headline })
    assert.deepEqual(f.events, [])
    assert.equal(existsSync(f.ctx.stateDir), false)
  })
}

test('apply rejects a gate with an impossible calendar date before touching processes', async (t) => {
  const f = rehearsal(t)
  f.ctx.clock = { now: () => Date.parse('2025-03-03T12:00:00Z') }
  writeFileSync(f.gateFile, JSON.stringify({ ...f.gate, at: '2025-02-30T12:00:00Z' }))
  const serviceStatus = t.mock.method(f.ctx.ports.service, 'status')
  const oldStatus = t.mock.method(f.ctx.ports.oldLoop, 'status')
  await assert.rejects(apply(tag, f.ctx), { reason: 'gate_invalid' })
  assert.deepEqual(f.events, [])
  assert.equal(serviceStatus.mock.callCount() + oldStatus.mock.callCount(), 0)
})

test('rollback is refused while apply is starting the service for the same tag', async (t) => {
  const f = rehearsal(t)
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const service = f.ctx.ports.service, start = service.start
  service.start = async (tag) => {
    entered.resolve()
    await gate.promise
    await start(tag)
  }
  const applying = apply(tag, { ...f.ctx, budgetMs: 5000 })
  try {
    await Promise.race([entered.promise, applying])
    await assert.rejects(rollback(tag, f.ctx), { reason: 'locked', headline: /another cutover for pb is running/ })
    assert.equal(f.running.oldLoop, false)
    assert.ok(!f.events.some((e) => e.action === 'oldLoop.start'))
  } finally {
    gate.resolve()
    assert.equal((await applying).message, 'applied')
  }
  assert.equal(existsSync(join(f.ctx.stateDir, `${tag}.lock`)), false)
  f.assertNoOverlap()
})

test('apply takes over a lock left by a dead cutover', async (t) => {
  const f = rehearsal(t, 'files', 'applying')
  const lock = join(f.ctx.stateDir, `${tag}.lock`)
  const deadPid = process.pid + 1
  writeFileSync(lock, String(deadPid))
  const kill = process.kill
  t.mock.method(process, 'kill', (pid: number, signal: number) => {
    if (pid === deadPid && signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    return kill(pid, signal)
  })
  assert.equal((await apply(tag, f.ctx)).message, 'applied')
  assert.equal(existsSync(lock), false)
})

test('stale cleanup excludes a contender until the new owner has finished', { timeout: 5000 }, async (t) => {
  const f = rehearsal(t, 'files', 'applying')
  const lock = join(f.ctx.stateDir, `${tag}.lock`)
  const deadPid = 0x7fffffff
  writeFileSync(lock, `${deadPid}\n`)
  const kill = process.kill
  t.mock.method(process, 'kill', (pid: number, signal: number) => {
    if (pid === deadPid && signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    return kill(pid, signal)
  })
  const reaping = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const rmReal = fs.rm
  let pause = true
  const rm = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (pause && args[0] === lock) {
      pause = false
      // Pause after the stale marker is gone but before the reaper publishes its PID.
      await rmReal(...args)
      reaping.resolve()
      await resume.promise
      return
    }
    return rmReal(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { rm.mock.restore(); syncBuiltinESMExports() })
  const applying = apply(tag, f.ctx)
  try {
    await Promise.race([reaping.promise, applying])
    await assert.rejects(rollback(tag, f.ctx), { reason: 'locked' })
    assert.equal(existsSync(lock), false)
    assert.deepEqual(f.events, [])
  } finally {
    resume.resolve()
    assert.equal((await applying).message, 'applied')
  }
  f.assertNoOverlap()
})

for (const text of ['', 'incomplete pid']) {
  test(`apply recovers an aged ${text ? 'malformed' : 'empty'} lock but refuses a fresh one`, async (t) => {
    const f = rehearsal(t, 'files', 'applying')
    const lock = join(f.ctx.stateDir, `${tag}.lock`)
    writeFileSync(lock, text)
    await assert.rejects(apply(tag, f.ctx), { reason: 'locked' })
    assert.equal(readFileSync(lock, 'utf8'), text)
    assert.deepEqual(f.events, [])
    const old = new Date(Date.now() - 61_000)
    utimesSync(lock, old, old)
    assert.equal((await apply(tag, f.ctx)).message, 'applied')
    assert.equal(existsSync(lock), false)
    f.assertNoOverlap()
  })
}

test('CLI refuses concurrent cutovers for the same commands through a symlink and different state dir', { timeout: 5000 }, async (t) => {
  const f = rehearsal(t)
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const service = f.ctx.ports.service, start = service.start
  service.start = async (tag) => {
    entered.resolve()
    await resume.promise
    await start(tag)
  }
  const cli = cliRehearsal(t, f)
  const alias = join(f.dir, 'alias.json'), other = join(f.dir, 'other-state')
  symlinkSync(cli.commands, alias)
  const applying = cli.execute('apply')
  try {
    await Promise.race([entered.promise, applying])
    assert.equal(await cli.execute('rollback', other, alias), 1)
    assert.equal(JSON.parse(cli.output.at(-1)!).reason, 'locked')
    assert.equal(existsSync(other), false)
    assert.equal(f.running.oldLoop, false)
  } finally {
    resume.resolve()
    assert.equal(await applying, 0)
  }
  f.assertNoOverlap()
})

test('apply does not overlap the loops or repeat a completed handoff', async (t) => {
  const f = rehearsal(t)
  assert.equal((await apply(tag, f.ctx)).message, 'applied')
  f.assertNoOverlap()
  assert.deepEqual(f.events.map((e) => e.action), ['bridge.current', 'oldLoop.stop', 'service.start'])
  assert.equal(f.events.find((e) => e.action === 'oldLoop.stop')?.pending, 'applying')
  assert.deepEqual(f.running, { oldLoop: false, service: true })
  assert.equal(f.state().mode, 'service')
  assert.equal(f.state().pending, undefined)
  const bytes = readFileSync(f.stateFile)
  const events = f.events.slice()

  assert.equal((await apply(tag, f.ctx)).message, 'already applied')
  assert.deepEqual(f.events, events)
  assert.deepEqual(readFileSync(f.stateFile), bytes)
  f.assertNoOverlap()
})

test('apply does not expose gate evidence in state or output', async (t) => {
  const f = rehearsal(t)
  await apply(tag, f.ctx)
  assert.deepEqual(f.state().gate, { file: f.gateFile, by: f.gate.by, at: f.gate.at,
    sha256: createHash('sha256').update(readFileSync(f.gateFile)).digest('hex') })
  assert.equal(readFileSync(f.stateFile, 'utf8').includes(f.gate.evidence), false)
  assert.equal(f.lines.join('\n').includes(f.gate.evidence), false)
  f.assertNoOverlap()
})

test('apply does not touch either loop when the bridge reports stale files', async (t) => {
  const f = rehearsal(t)
  for (const outcome of ['stale', 'fail'] as const) {
    f.controls.sync = () => outcome
    await assert.rejects(apply(tag, f.ctx), { reason: 'bridge_not_current' })
    assert.equal(f.events.at(-1)?.action, `bridge.${outcome}`)
    assert.deepEqual(f.running, { oldLoop: true, service: false })
    assert.equal(existsSync(f.stateFile), false)
    assert.equal(existsSync(join(f.ctx.stateDir, `${tag}.lock`)), false)
  }
  assert.deepEqual(f.events.map((e) => e.action), ['bridge.stale', 'bridge.fail'])
  f.assertNoOverlap()
})

test('apply does not leave the old loop down when service start fails', async (t) => {
  const f = rehearsal(t)
  f.controls.failStart = 'service'
  await assert.rejects(apply(tag, f.ctx), { reason: 'service_start_failed', headline: /automatically rolled back/ })
  assert.deepEqual(f.events.map((e) => e.action), [
    'bridge.current', 'oldLoop.stop', 'service.start failed', 'service.stop', 'bridge.current', 'oldLoop.start',
  ])
  assert.equal(f.events.find((e) => e.action === 'oldLoop.start')?.current, true)
  assert.deepEqual(f.running, { oldLoop: true, service: false })
  assert.equal(f.state().mode, 'files')
  assert.equal(f.state().pending, undefined)
  f.assertNoOverlap()
})

test('apply does not replay the old-loop stop or skip service start after a crash', async (t) => {
  const f = rehearsal(t, 'files', 'applying')
  await apply(tag, f.ctx)
  assert.deepEqual(f.events.filter((e) => !e.action.startsWith('bridge.')).map((e) => e.action), ['service.start'])
  assert.deepEqual(f.running, { oldLoop: false, service: true })
  assert.equal(f.state().mode, 'service')
  assert.equal(f.state().pending, undefined)
  f.assertNoOverlap()
})

for (const [action, handoff, mode, loop] of [
  ['apply', apply, 'files', 'oldLoop'],
  ['rollback', rollback, 'service', 'service'],
] as const) {
  test(`${action} does not start the replacement after an unconfirmed stop`, async (t) => {
    const f = rehearsal(t, mode)
    f.controls.unconfirmedStop = loop
    await assert.rejects(handoff(tag, f.ctx), { reason: 'unconfirmed_stop' })
    f.assertNoOverlap()
    assert.deepEqual(f.running, { oldLoop: loop === 'oldLoop', service: loop === 'service' })
    assert.equal(f.state().mode, mode)
    assert.equal(f.state().pending, action === 'apply' ? 'applying' : 'rolling_back')
  })
}

test('rollback does not overlap the loops, start on stale files, or misreport elapsed time', async (t) => {
  const f = rehearsal(t, 'service')
  const started = performance.now()
  const result = await rollback(tag, { ...f.ctx, gateFile: undefined })
  assert.ok(performance.now() - started < 300_000, 'rollback wall time exceeded five minutes')
  assert.ok(result.elapsedMs >= 0 && result.elapsedMs < 300_000)
  assert.deepEqual(f.lines, [`rolled back  ${result.elapsedMs} ms`])
  assert.equal(f.state().history.at(-1)?.detail, `${result.elapsedMs} ms`)
  f.assertNoOverlap()
  assert.deepEqual(f.events.map((e) => e.action), ['bridge.current', 'service.stop', 'bridge.current', 'oldLoop.start'])
  assert.deepEqual(f.events.filter((e) => e.action === 'bridge.current').map((e) => e.service), [true, false])
  const start = f.events.find((e) => e.action === 'oldLoop.start')
  assert.equal(start?.current, true, 'files must already be current when the old loop starts')
  assert.equal(start?.pending, 'rolling_back')
  assert.deepEqual(f.running, { oldLoop: true, service: false })
  assert.equal(f.state().mode, 'files')
  assert.equal(f.state().pending, undefined)
})

for (const pending of ['applying', 'rolling_back'] as const) {
  test(`rollback stops a delayed service start after a stopped status with pending ${pending}`, async (t) => {
    const f = rehearsal(t, 'files', pending)
    f.running.oldLoop = false
    const service = f.ctx.ports.service, status = service.status
    service.status = async (tag) => {
      const observed = await status(tag)
      service.status = status
      // The timed-out start lands just after status sampled a stopped service.
      f.running.service = true
      return observed
    }
    assert.equal((await rollback(tag, f.ctx)).message, 'rolled back')
    assert.ok(f.events.some((e) => e.action === 'service.stop'))
    assert.equal(f.events.find((e) => e.action === 'oldLoop.start')?.service, false)
    f.assertNoOverlap()
  })
}

for (const unconfirmed of [false, true]) {
  test(`CLI rollback ${unconfirmed ? 'fails closed on' : 'stops'} a service start that lands after starting the old loop`, async (t) => {
    const f = rehearsal(t, 'service')
    const old = f.ctx.ports.oldLoop, start = old.start
    old.start = async (tag) => {
      await start(tag)
      // A delayed service start lands after the confirmed stop and final drain.
      f.running.service = true
      if (unconfirmed) f.controls.unconfirmedStop = 'service'
    }
    const status = f.ctx.ports.service.status
    if (unconfirmed) f.ctx.ports.service.status = async (tag) => f.running.oldLoop ? 'unknown' : status(tag)
    const cli = cliRehearsal(t, f)
    assert.equal(await cli.execute('rollback'), unconfirmed ? 1 : 0)
    const result = JSON.parse(cli.output.join('\n'))
    assert.equal(f.events.find((e) => e.action === 'oldLoop.start')?.current, true)
    if (unconfirmed) {
      assert.equal(result.reason, 'both_running_detected')
      assert.equal(f.state().pending, 'rolling_back')
      assert.deepEqual(f.running, { oldLoop: false, service: true })
    } else {
      assert.equal(result.message, 'rolled back')
      assert.equal(f.state().pending, undefined)
      assert.deepEqual(f.running, { oldLoop: true, service: false })
    }
  })
}

test('rollback stops an unknown service before a stale drain when the old loop is running', async (t) => {
  const f = rehearsal(t)
  f.running.service = true
  f.ctx.ports.service.status = async () => f.running.service ? 'unknown' : 'stopped'
  f.controls.sync = () => 'stale'
  await assert.rejects(rollback(tag, f.ctx), { reason: 'files_stale' })
  assert.deepEqual(f.events.map((e) => e.action), ['service.stop', 'bridge.stale'])
  assert.deepEqual(f.running, { oldLoop: true, service: false })
  f.assertNoOverlap()
})

test('rollback does not restore the service after a crashed apply with stale files', async (t) => {
  const f = rehearsal(t, 'files', 'applying')
  f.controls.sync = () => 'stale'
  const cli = cliRehearsal(t, f)
  assert.equal(await cli.execute('rollback'), 1)
  const failure = JSON.parse(cli.output.join('\n'))
  assert.equal(failure.reason, 'files_stale')
  assert.deepEqual(f.events.filter((e) => e.action.endsWith('.start')).map((e) => e.action), [])
  assert.match(failure.headline, /fix the bridge/)
  assert.match(failure.headline, /--allow-stale/)
  assert.deepEqual(f.running, { oldLoop: false, service: false })
  assert.equal(f.state().mode, 'files')
  assert.equal(f.state().pending, 'rolling_back')

  f.controls.sync = () => 'current'
  assert.equal((await apply(tag, f.ctx)).message, 'applied')
  f.assertNoOverlap()
})

for (const unconfirmed of [false, true]) {
  test(`rollback ${unconfirmed ? 'fails closed on' : 'stops'} a late old-loop start after a stale drain`, async (t) => {
    const f = rehearsal(t, 'service')
    const old = f.ctx.ports.oldLoop, status = old.status
    if (unconfirmed) f.controls.unconfirmedStop = 'oldLoop'
    f.controls.sync = () => {
      if (f.running.service) return 'current'
      old.status = async (tag) => {
        const observed = await status(tag)
        old.status = status
        // A prior rollback's start lands just after status samples the stopped loop.
        await old.start(tag)
        return observed
      }
      return 'stale'
    }
    await assert.rejects(rollback(tag, f.ctx), unconfirmed
      ? { reason: 'unconfirmed_stop' }
      : { reason: 'files_stale', headline: /the service was restored/ })
    f.assertNoOverlap()
    if (unconfirmed) {
      assert.ok(!f.events.some((e) => e.action === 'service.start'))
      assert.equal(f.state().pending, 'rolling_back')
      assert.deepEqual(f.running, { oldLoop: true, service: false })
    } else {
      const actions = f.events.map((e) => e.action)
      const stop = actions.lastIndexOf('oldLoop.stop')
      assert.ok(actions.indexOf('oldLoop.start') < stop && stop < actions.indexOf('service.start'))
      assert.deepEqual(f.running, { oldLoop: false, service: true })
    }
  })
}

test('rollback restores the service when the final drain is stale', async (t) => {
  const f = rehearsal(t, 'service')
  f.controls.sync = () => f.running.service ? 'current' : 'stale'
  const cli = cliRehearsal(t, f)
  assert.equal(await cli.execute('rollback'), 1)
  const failure = JSON.parse(cli.output.join('\n'))
  assert.equal(failure.reason, 'files_stale')
  assert.match(failure.headline, /rollback refused: files are stale; the service was restored/)
  assert.match(failure.headline, /fix the bridge, then re-run/)
  assert.ok(!f.events.some((e) => e.action === 'oldLoop.start'))
  assert.deepEqual(f.running, { oldLoop: false, service: true })
  assert.equal(f.state().mode, 'service')
  assert.equal(f.state().pending, undefined)
  f.assertNoOverlap()
})

test('rollback leaves no router when restoring the service after a stale drain fails', async (t) => {
  const f = rehearsal(t, 'service')
  f.controls.sync = () => f.running.service ? 'current' : 'stale'
  // A start command can report success even though the service never runs.
  f.ctx.ports.service.start = async () => {}
  const cli = cliRehearsal(t, f)
  assert.equal(await cli.execute('rollback'), 1)
  assert.deepEqual(JSON.parse(cli.output.join('\n')), {
    reason: 'no_router',
    headline: 'no router running: start the service or the old loop by hand',
  })
  assert.ok(!f.events.some((e) => e.action === 'oldLoop.start'))
  assert.deepEqual(f.running, { oldLoop: false, service: false })
  assert.equal(f.state().mode, 'service')
  assert.equal(f.state().pending, 'rolling_back')
  f.assertNoOverlap()
})

test('rollback does not restore the service if the old loop starts during a stale final drain', async (t) => {
  const f = rehearsal(t, 'service', 'rolling_back')
  f.controls.sync = () => {
    if (f.running.service) return 'current'
    f.running.oldLoop = true // A prior attempt's delayed start lands during the final drain.
    return 'stale'
  }
  await assert.rejects(rollback(tag, f.ctx), { reason: 'files_stale' })
  assert.deepEqual(f.running, { oldLoop: true, service: false })
  assert.equal(f.state().pending, 'rolling_back')
  f.assertNoOverlap()
})

test('cutover accepts --allow-stale only on rollback --execute', async (t) => {
  const f = rehearsal(t, 'service')
  const cli = cliRehearsal(t, f)
  for (const [action, ...flags] of [['rollback'], ['plan', '--execute'], ['apply', '--execute']] as const) {
    cli.output.length = 0
    assert.equal(await run([action, tag, '--allow-stale', '--json', '--commands', cli.commands,
      '--state-dir', f.ctx.stateDir, '--gate', f.gateFile, ...flags]), 2)
    assert.equal(JSON.parse(cli.output.join('\n')).reason, 'usage')
  }
  assert.deepEqual(f.events, [])
  assert.equal(f.state().pending, undefined)
})

test('rollback --allow-stale starts the old loop on a stale final drain', async (t) => {
  const f = rehearsal(t, 'service')
  f.controls.sync = () => f.running.service ? 'current' : 'stale'
  const cli = cliRehearsal(t, f)
  assert.equal(await cli.execute('rollback', f.ctx.stateDir, cli.commands, ['--allow-stale']), 1)
  const failure = JSON.parse(cli.output.join('\n'))
  assert.equal(failure.reason, 'rolled_back_stale')
  assert.match(failure.headline, /files were stale/)
  assert.equal(f.events.find((e) => e.action === 'oldLoop.start')?.current, false)
  assert.deepEqual(f.running, { oldLoop: true, service: false })
  assert.equal(f.state().mode, 'files')
  assert.equal(f.state().pending, undefined)
  assert.equal(f.state().history.at(-1)?.event, 'rolled_back_stale')
  f.assertNoOverlap()
})

test('rollback does not start the old loop on a stale final drain and does not get stuck on retry', async (t) => {
  const f = rehearsal(t, 'service')
  f.controls.sync = () => f.running.service ? 'current' : 'stale'
  const cli = cliRehearsal(t, f)
  assert.equal(await cli.execute('rollback'), 1)
  const failure = JSON.parse(cli.output.join('\n'))
  assert.equal(failure.reason, 'files_stale')
  assert.match(failure.headline, /rollback refused: files are stale; the service was restored/)
  assert.match(failure.headline, /swarm cutover rollback pb --execute/)
  assert.deepEqual(f.events.map((e) => e.action),
    ['bridge.current', 'service.stop', 'bridge.stale', 'oldLoop.stop', 'service.start'])
  assert.ok(!f.events.some((e) => e.action === 'oldLoop.start'))
  assert.deepEqual(f.running, { oldLoop: false, service: true })
  assert.equal(f.state().mode, 'service')
  assert.equal(f.state().pending, undefined)

  f.controls.sync = () => 'current'
  const retry = f.events.length
  assert.equal((await rollback(tag, f.ctx)).message, 'rolled back')
  assert.deepEqual(f.events.slice(retry).map((e) => e.action), ['bridge.current', 'service.stop', 'bridge.current', 'oldLoop.start'])
  assert.equal(f.events.find((e) => e.action === 'oldLoop.start')?.current, true)
  assert.deepEqual(f.running, { oldLoop: true, service: false })
  assert.equal(f.state().mode, 'files')
  assert.equal(f.state().pending, undefined)
  f.assertNoOverlap()
})

test('rollback does not wait out a hung port beyond its budget or lose the pending handoff', async (t) => {
  const f = rehearsal(t, 'service')
  f.controls.sync = () => f.running.service ? 'current' : 'hang'
  const watchdog = new AbortController()
  t.after(() => watchdog.abort())
  const attempt = rollback(tag, { ...f.ctx, budgetMs: 100 })
  await assert.rejects(Promise.race([attempt, delay(2000, null, { signal: watchdog.signal }).then(() => {
    throw new Error('hung port outlived the rollback budget')
  })]), { reason: 'budget_exceeded' })
  assert.equal(f.events.at(-1)?.action, 'bridge.hang')
  assert.deepEqual(f.running, { oldLoop: false, service: false })
  assert.equal(f.state().mode, 'service')
  assert.equal(f.state().pending, 'rolling_back')

  f.controls.sync = () => 'current'
  assert.equal((await rollback(tag, f.ctx)).message, 'rolled back')
  assert.equal(f.state().mode, 'files')
  assert.equal(f.state().pending, undefined)
  assert.equal(f.events.find((e) => e.action === 'oldLoop.start')?.current, true)
  f.assertNoOverlap()
})

test('rollback does not change files or processes when already rolled back', async (t) => {
  const f = rehearsal(t, 'service')
  await rollback(tag, f.ctx)
  const bytes = readFileSync(f.stateFile)
  const events = f.events.slice()
  assert.equal((await rollback(tag, f.ctx)).message, 'already rolled back')
  assert.deepEqual(f.events, events)
  assert.deepEqual(readFileSync(f.stateFile), bytes)
  f.assertNoOverlap()
})

test('apply and rollback do not execute by default', async (t) => {
  const f = rehearsal(t)
  const output: string[] = []
  t.mock.method(console, 'log', (line: string) => output.push(line))
  for (const action of ['apply', 'rollback']) {
    const offset = output.length
    // No --commands: even a broken execution default cannot touch live processes.
    assert.equal(await run([action, tag, '--gate', f.gateFile, '--state-dir', f.ctx.stateDir, '--json']), 0, action)
    const result = JSON.parse(output.slice(offset).join('\n'))
    assert.equal(result.message, 'dry run', action)
    assert.equal(result.dryRun, true, action)
    assert.equal(result.steps[0]?.step, action === 'apply' ? 'verify gate' : 'record rollback')
    assert.equal(existsSync(f.ctx.stateDir), false, action)
  }
})

test('CLI plan and dry-run apply do not write state or invoke mutating commands', (t) => {
  const f = rehearsal(t)
  const script = join(f.dir, 'fake-port.cjs'), marker = join(f.dir, 'mutated'), commands = join(f.dir, 'commands.json')
  writeFileSync(script, `
    const [action, marker, tag] = process.argv.slice(2)
    if (tag !== 'pb') process.exit(2)
    if (action === 'running') process.exit(0)
    if (action === 'stopped') process.exit(1)
    require('node:fs').appendFileSync(marker, action + '\\n')
  `)
  const change = [process.execPath, script, 'mutate', marker]
  const running = [process.execPath, script, 'running', marker]
  const stopped = [process.execPath, script, 'stopped', marker]
  writeFileSync(commands, JSON.stringify({ [tag]: { service: { start: change, stop: change, status: stopped },
    oldLoop: { start: change, stop: change, status: running }, bridge: { sync: change, status: running } } }))
  const before = readdirSync(f.dir)
  for (const action of ['plan', 'apply']) {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'cutover', action, tag,
      '--gate', f.gateFile, '--commands', commands, '--state-dir', f.ctx.stateDir], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000,
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.startsWith('dry run\n'), action === 'apply')
    assert.match(result.stdout, /^do\s+oldLoop\.stop\s+old loop running$/m)
    assert.match(result.stdout, /^do\s+service\.start\s+service stopped$/m)
    assert.ok(result.stdout.indexOf('oldLoop.stop') < result.stdout.indexOf('service.start'))
    assert.equal(existsSync(marker), false, `${action} touched a mutating port`)
    assert.deepEqual(readdirSync(f.dir), before, `${action} wrote files`)
  }
})
