import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { harnessConformance } from '../src/conformance.ts'
import { fake } from '../src/fake.ts'
import { pi, type PiOptions } from '../src/pi.ts'
import { subprocess } from '../src/subprocess.ts'
import { fixtureStart, output, terminal, waitFor } from './support.ts'

const processFile = fileURLToPath(new URL('./fixtures/process.mjs', import.meta.url))
const piFile = fileURLToPath(new URL('./fixtures/pi-task.mjs', import.meta.url))
const localFixture = (...args: string[]) => subprocess({ command: process.execPath, args: [processFile, ...args] })
const piFixture = (brief: string, options: Partial<PiOptions> = {}) => pi({
  readBrief: () => brief, command: piFile, idleMs: 3_000, ...options,
})

harnessConformance('fake', { interactive: true, open: (_, wallMs) => ({ harness: fake(), input: fixtureStart(wallMs) }) })
harnessConformance('subprocess', { interactive: true, open: (_, wallMs) => ({ harness: localFixture(), input: fixtureStart(wallMs) }) })
harnessConformance('pi', { interactive: false, open: (brief, wallMs) => ({ harness: piFixture(brief), input: fixtureStart(wallMs, brief) }) })

test('subprocess start replay launches the fixed command only once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const audit = join(dir, 'launches')
  const harness = localFixture('environment', audit)
  const input = fixtureStart()
  const [first, second] = await Promise.all([harness.start(input), harness.start(input)])
  assert.equal(first, second)
  assert.equal((await terminal(harness, first)).exitCode, 0)
  assert.equal(await harness.start(input), first)
  assert.equal(await readFile(audit, 'utf8'), 'started\n')
})

test('subprocess has a temporary home and no ambient test secret', async (t) => {
  process.env.RUNTIME_TEST_SECRET = 'invented-fixture-value'
  t.after(() => { delete process.env.RUNTIME_TEST_SECRET })
  const harness = localFixture('environment')
  const run = await harness.start(fixtureStart())
  assert.equal((await terminal(harness, run)).exitCode, 0)
  const { cwd, home, ambient } = JSON.parse(await output(harness, run))
  assert.equal(home, cwd)
  assert.equal(dirname(cwd), tmpdir())
  assert.equal(ambient, false)
  await assert.rejects(readFile(join(cwd, 'anything')), { code: 'ENOENT' })
})

for (const stop of ['cancel', 'timeout'] as const) {
  test(`subprocess ${stop} stops a grandchild holding the output pipe`, async (t) => {
    const harness = localFixture('tree')
    const run = await harness.start(fixtureStart(stop === 'timeout' ? 1_250 : 6_000))
    t.after(() => harness.cancel(run))
    const pid = await waitFor(async () => (await output(harness, run)).match(/grandchild (\d+)\n/)?.[1])
    t.after(() => {
      // Keep a deliberately broken implementation from hanging the test process.
      try { process.kill(Number(pid), 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    })
    if (stop === 'cancel') await harness.cancel(run)
    const result = await terminal(harness, run)
    assert.equal(result.outcome, stop === 'cancel' ? 'canceled' : 'failed')
    assert.equal(result.failure, stop === 'timeout' ? 'timeout' : undefined)
  })
}

test('pi gives the pinned task and only explicit extras to each model in order', async (t) => {
  process.env.RUNTIME_TEST_SECRET = 'invented-fixture-value'
  t.after(() => { delete process.env.RUNTIME_TEST_SECRET })
  const harness = piFixture('fallback', {
    maxSeconds: 7, models: ['first-model', 'codex-cursor'],
    env: { RUNTIME_TEST_OPT_IN: 'fixture-opt-in' }, spawn: (command, args, options) => spawn(command, args, options),
    classifyExit: () => 'quota',
  })
  const run = await harness.start({ ...fixtureStart(6_000, 'fallback'), model: 'first-model' })
  assert.equal((await terminal(harness, run)).exitCode, 0)
  const lines = (await output(harness, run)).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines, ['first-model', 'codex-cursor'].map((model) => ({
    model, maxSeconds: '7', task: 'fallback', explicit: 'fixture-opt-in', ambient: false,
  })))
})

test('pi refuses to execute an unpinned brief', async () => {
  const harness = piFixture('success')
  const run = await harness.start(fixtureStart(6_000, 'different contents'))
  assert.equal((await terminal(harness, run)).failure, 'verification')
  assert.equal(await output(harness, run), '')
})

test('pi fails an idle command before the overall wall deadline', async () => {
  const harness = piFixture('hang', { idleMs: 150 })
  const run = await harness.start(fixtureStart(8_000))
  assert.equal((await terminal(harness, run)).failure, 'timeout')
})

test('pi output on stderr resets the idle deadline', async () => {
  const harness = piFixture('pulses', { idleMs: 200 })
  const run = await harness.start(fixtureStart(6_000, 'pulses'))
  assert.equal((await terminal(harness, run)).exitCode, 0)
  const events = (await harness.observe(run, { limit: 100 })).events
  assert.ok(events.every(({ type }) => type === 'stderr'))
  assert.equal(events.map(({ text }) => text).join(''), 'pulse\n'.repeat(4))
})
