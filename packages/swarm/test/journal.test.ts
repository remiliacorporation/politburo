import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { launch, launchKey, openJournal, recover, type Binding, type HookStep, type Provider } from '../src/lifecycle/launch.ts'

const crash = new Error('simulated crash')
const crashAt = (target: HookStep) => (step: HookStep) => { if (step === target) throw crash }
const session = 'provider-session'
const one = { kind: 'one', session } as const
const absent = { kind: 'absent' } as const
const unknown = { kind: 'unknown' } as const
const binding: Binding = { kind: 'implement', repo: 'acme/web', account: 'fixture', envelopeRef: 'envelope',
  briefRef: 'brief', briefDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64), generation: 1, epoch: 1, createdAt: 0 }

async function fixture(t: TestContext, attemptId = 'attempt') {
  const dir = await mkdtemp(fileURLToPath(new URL('./.journal-', import.meta.url)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'launch.jsonl')
  const key = launchKey({ ...binding, workId: 'work', round: 1, attemptId })
  const live: { epoch: number | 'unknown'; probe: Awaited<ReturnType<Provider['probe']>> } = { epoch: 1, probe: absent }
  const sends: { key: string; epoch: typeof live.epoch; bound: number }[] = []
  const alerts: string[] = []
  const provider: Provider = {
    async send(request) { sends.push({ key: request.key, epoch: live.epoch, bound: request.binding.epoch }); return { session } },
    async probe() { return live.probe },
  }
  const options = { journal: openJournal(dir), provider, now: () => 0,
    control: { async epoch() { return live.epoch }, async matches() { return true } },
    attention: { async raise(input: { key: string }) { alerts.push(input.key) } } }
  const bytes = () => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  return { options, key, live, sends, alerts, dir, path, bytes,
    restart: (known = true) => { options.journal = openJournal(dir, { known }) },
    tick: (hook?: (step: HookStep) => void | Promise<void>) => launch({ ...options, key, binding, hook }),
    recover: (hook?: (step: HookStep) => void) => recover({ ...options, hook }),
    async row() {
      const replay = await options.journal.load()
      assert.ok(replay.ok)
      return replay.latest.get(key)
    },
  }
}

function mulberry32(seed: number) {
  return () => {
    let n = seed = (seed + 0x6d2b79f5) | 0
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 2 ** 32
  }
}

const steps: HookStep[] = ['load', 'intended', 'binding', 'epoch_before_sent', 'sent', 'epoch_before_send',
  'send', 'confirmed', 'probe', 'uncertain', 'abandoned', 'attention_reserved', 'attention']

test('crashes and duplicate ticks do not replay sends or defeat the pause fence', async (t) => {
  const { SWARM_SEED, SWARM_SEEDS } = process.env
  const seeds = SWARM_SEED === undefined ? Array.from({ length: Number(SWARM_SEEDS ?? 100) }, (_, i) => i) : [Number(SWARM_SEED)]
  for (const seed of new Set([...seeds, 13, 66, 215, 257])) {
    const f = await fixture(t, String(seed)), rng = mulberry32(seed)
    const pick = <T,>(values: T[]) => values[Math.floor(rng() * values.length)]!
    const plan = {
      crashes: [pick(steps.slice(0, 8)), ...Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(steps))],
      pause: pick(['sent', 'epoch_before_send', 'binding', 'probe', null]),
      ambiguous: rng() < 0.3, hidden: Array.from({ length: Math.floor(rng() * 3) }, () => pick([absent, unknown])),
    }
    const trace: string[] = []
    let paused = false, hidden = 0, crashed = false
    const { provider } = f.options, send = provider.send
    provider.send = async (request) => {
      trace.push(`provider accepted at epoch ${f.live.epoch}`)
      const result = await send(request)
      if (plan.ambiguous) throw new Error('reply lost after acceptance')
      return result
    }
    provider.probe = async () => {
      const result = f.sends.length ? plan.hidden[hidden++] ?? one : absent
      trace.push(`provider probe: ${result.kind}`)
      return result
    }
    async function run(recovering: boolean, target?: HookStep) {
      const before = (await f.row())?.state, sent = f.sends.length
      trace.push(`${recovering ? 'recover' : 'tick'} from ${before ?? 'empty'} at epoch ${f.live.epoch}`)
      const hook = (step: HookStep) => {
        trace.push(step)
        if (step === target) throw crash
        if (!paused && step === plan.pause) {
          paused = true; f.live.epoch = 'unknown'; trace.push('pause')
        }
      }
      try { await (recovering ? f.recover(hook) : f.tick(hook)) } catch (error) {
        if (error !== crash) throw error
        crashed = true; trace.push('crash; reopen'); f.restart((await f.bytes()).length > 0)
      }
      if (f.live.epoch === 'unknown') { f.live.epoch = 2; trace.push('resume at epoch 2') }
      if (before && before !== 'intended') assert.equal(f.sends.length, sent, `send from ${before}`)
    }
    try {
      await run(false, plan.crashes[0])
      for (const target of plan.crashes.slice(1)) await run(true, crashed ? target : 'load')
      await run(true)
      const before = (await f.row())?.state, sentBeforeTicks = f.sends.length
      trace.push(`two duplicate ticks from ${before ?? 'empty'}`)
      await Promise.all([f.tick(), f.tick()])
      if (before && before !== 'intended') assert.equal(f.sends.length, sentBeforeTicks, `tick sent from ${before}`)
      for (let i = 0; i <= plan.hidden.length; i++) await run(true)
      assert.ok(f.sends.length <= 1, 'duplicate provider send')
      for (const sent of f.sends) assert.deepEqual(sent, { key: f.key, epoch: binding.epoch, bound: binding.epoch })
      assert.ok(f.alerts.length <= 1, 'duplicate attention')
      const row = await f.row()
      assert.ok(row && ['confirmed', 'abandoned', 'uncertain'].includes(row.state), 'key did not close')
      if (row.state === 'confirmed') {
        assert.equal(f.sends.length, 1)
        assert.equal(row.session, session)
      }
    } catch (error) {
      t.diagnostic(`seed=${seed} plan=${JSON.stringify(plan)}\n${trace.join(' -> ')}`)
      throw error
    }
  }
})

test('the provider cannot receive a send before its sent line is on disk', async (t) => {
  const f = await fixture(t), send = f.options.provider.send
  let atSend: string | undefined
  f.options.provider.send = async (request) => { atSend = await f.bytes(); return send(request) }
  await f.tick()
  assert.ok(atSend?.split('\n').slice(0, -1).some((line) => {
    const row = JSON.parse(line)
    return row.key === f.key && row.state === 'sent'
  }), 'no sent line at provider entry')
})

test('a claim that lapses after the sent append cannot dispatch', async (t) => {
  const f = await fixture(t)
  let claimed = true
  f.options.control.matches = async () => claimed
  const result = await f.tick(async (step) => {
    if (step !== 'epoch_before_send') return
    assert.equal((await f.row())?.state, 'sent')
    claimed = false
  })
  assert.deepEqual(f.sends, [])
  assert.deepEqual(result, { key: f.key, status: 'abandoned', reason: 'binding_mismatch' })
  assert.equal((await f.row())?.state, 'abandoned')
})

test('launch and recover cannot dispatch under a live journal lock', async (t) => {
  const f = await fixture(t), lock = join(f.dir, 'launch.lock')
  await assert.rejects(f.tick(crashAt('binding')), crash)
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' })
  const launched = await f.tick(), recovered = await f.recover()
  const refusal = { ok: false, reason: 'locked' }
  assert.deepEqual(launched, refusal)
  assert.deepEqual(recovered, refusal)
  assert.deepEqual(f.sends, [])
  assert.equal(await readFile(lock, 'utf8'), `${process.pid}\n`)
})

test('a dead journal lock owner cannot block launch', async (t) => {
  const f = await fixture(t), lock = join(f.dir, 'launch.lock')
  const child = spawn(process.execPath, ['-e', ''], { env: {}, stdio: 'ignore' })
  assert.deepEqual(await once(child, 'exit'), [0, null])
  assert.ok(child.pid)
  await writeFile(lock, `${child.pid}\n`, { flag: 'wx' })
  assert.deepEqual(await f.tick(), { key: f.key, status: 'launched', session })
  assert.equal(f.sends.length, 1)
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
})

test('a torn, corrupt, or known-missing journal cannot send', async (t) => {
  for (const reason of ['torn_tail', 'corrupt', 'missing'] as const) {
    const f = await fixture(t)
    await assert.rejects(f.tick(crashAt(reason === 'torn_tail' ? 'epoch_before_send' : 'binding')), crash)
    if (reason === 'torn_tail') await truncate(f.path, Buffer.byteLength(await f.bytes()) - 4)
    else if (reason === 'corrupt') await appendFile(f.path, 'not-json\n')
    else await rm(f.path)
    f.restart()
    const refusal = { ok: false, reason }
    assert.deepEqual(await f.options.journal.load(), refusal)
    assert.deepEqual(await f.tick(), refusal)
    assert.deepEqual(f.sends, [])
  }
})

test('reopening with defaults cannot dispatch again after journal deletion', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.tick(), { key: f.key, status: 'launched', session })
  await rm(f.path)
  f.options.journal = openJournal(f.dir)
  assert.deepEqual(await f.tick(), { ok: false, reason: 'missing' })
  assert.equal(f.sends.length, 1)
})

test('an absent or unknown probe after send closes replay and raises only one alert', async (t) => {
  for (const probe of [absent, unknown]) {
    const f = await fixture(t)
    await assert.rejects(f.tick(crashAt('confirmed')), crash)
    f.live.probe = probe
    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) f.restart()
      assert.deepEqual(await f.recover(), [{ key: f.key, status: 'uncertain', reason: `probe_${probe.kind}` }])
      assert.equal((await f.row())?.state, 'uncertain')
      assert.equal(f.sends.length, 1)
      assert.deepEqual(f.alerts, [f.key])
    }
  }
})

test('recovery adopts a matching session without relaunching it even if it later goes missing', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.tick(crashAt('confirmed')), crash)
  f.restart(); f.live.probe = one
  assert.deepEqual(await f.recover(), [{ key: f.key, status: 'adopted', session }])
  f.restart()
  assert.deepEqual(await f.recover(), [{ key: f.key, status: 'reattached', session }])
  f.live.probe = absent
  assert.deepEqual(await f.recover(), [{ key: f.key, status: 'confirmed', session, reason: 'missing_session' }])
  assert.equal((await f.row())?.session, session)
  assert.equal(f.sends.length, 1)
})

test('a pre-pause intent cannot send after resume', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.tick(crashAt('sent')), crash)
  f.live.epoch = 2; f.restart()
  assert.deepEqual(await f.recover(), [{ key: f.key, status: 'abandoned', reason: 'board_paused' }])
  await f.tick()
  assert.deepEqual(f.sends, [])
})

test('a binding cannot put a token, raw prompt, or presigned brief URL in the journal', async (t) => {
  const f = await fixture(t), token = 'fixture-private-token', prompt = 'fixture-private-prompt'
  const badBindings = [{ authToken: token }, { rawPrompt: prompt }, { briefRef: `https://example.test/brief?X-Amz-Signature=${token}` },
    { envelopeRef: `token=${token}` }, { account: `https://${token}@example.test` }, { repo: 'a'.repeat(201) }]
  for (const extra of badBindings) {
    const candidate = { ...binding, ...extra }
    const key = launchKey({ ...candidate, workId: 'work', round: 1, attemptId: 'attempt' })
    await assert.rejects(launch({ ...f.options, key, binding: candidate }), /invalid journal record/)
    assert.equal(await f.bytes(), '', 'invalid binding reached the journal')
    assert.deepEqual(f.sends, [])
  }
})
