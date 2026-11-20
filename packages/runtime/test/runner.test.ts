import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { board, BoardError, type MessageView } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { oidcTokens } from '@vercel/board/access'
// Only the test issuer fixture is shared; no imports from board's implementation.
import { BOARD_URL, caller, localUserToken, testLocal } from '../../board/test/tokens.ts'
import { capacity, fake, runTask, subprocess, usageGuard, type Harness, type Result, type RunRef } from '../src/index.ts'
import { fixtureStart, output, terminal, waitFor } from './support.ts'

async function openBoard(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const request = caller(team.fetch, await localUserToken('runtime-test'))
  return {
    team,
    async task(id: string) {
      const response = await request('GET', `/messages/${id}`)
      assert.equal(response.status, 200)
      return (response.body.message as MessageView).task!
    },
  }
}

function job(t: TestContext) {
  const fixture = fileURLToPath(new URL('./fixtures/process.mjs', import.meta.url))
  const processHarness = subprocess({ command: process.execPath, args: [fixture] })
  const runs: RunRef[] = []
  const harness: Harness = {
    ...processHarness,
    async start(input) {
      const ref = await processHarness.start(input)
      runs.push(ref)
      return ref
    },
  }
  t.after(async () => { await Promise.all(runs.map((ref) => harness.cancel(ref))) })
  return {
    harness, runs,
    options: { harness, work: fixtureStart(10_000).work, provider: 'fixture', pollMs: 10, renewEveryMs: 100 },
    ready: () => waitFor(async () => {
      const ref = runs[0]
      return ref && (await output(harness, ref)).includes('ready\n') ? ref : undefined
    }),
  }
}

test('runner renews a selected task, reports exit, and releases without completing it', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: selected } = await team.tasks.create('runtime/fixtures', { text: 'selected', labels: { queue: 'yes' } })
  const { task: skipped } = await team.tasks.create('runtime/fixtures', 'not selected')
  const { task: waiting } = await team.tasks.create('runtime/fixtures', { text: 'waiting', needs: [selected.id] })
  const { options, harness, ready } = job(t)
  const run = runTask({ ...options, board: team, selection: { channel: 'runtime/fixtures', label: { queue: 'yes' } } })
  // Keep the fixture running until the public task view shows an extended lease.
  const ref = await ready()
  const first = (await task(selected.id)).claim?.until
  assert.ok(first)
  await waitFor(async () => {
    const until = (await task(selected.id)).claim?.until
    return until && until > first ? until : undefined
  })
  assert.equal(await harness.send(ref, { id: 'finish', text: 'finish\n' }), 'accepted')
  assert.deepEqual(await run, {
    status: 'released', taskId: selected.id, run: ref,
    result: { outcome: 'exited', exitCode: 0, artifacts: [], usage: null },
  })
  assert.equal((await task(selected.id)).state, 'ready')
  assert.equal((await task(skipped.id)).state, 'ready')
  assert.equal((await task(waiting.id)).state, 'waiting')
  await (await team.as('next-worker').tasks.claim(selected.id)).release()
})

test('runner cancels its process and does not settle after the task owner revokes its lease', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: selected } = await team.tasks.create('runtime/fixtures', 'revocable task')
  const { options, harness, ready } = job(t)
  const run = runTask({ ...options, board: team.as('worker'), taskId: selected.id })
  const ref = await ready()
  assert.equal(await harness.collect(ref), 'not_terminal')
  await team.tasks.cancel(selected.id, 'revoked by owner')
  assert.deepEqual(await run, { status: 'lease_lost', taskId: selected.id })
  assert.equal((await terminal(harness, ref)).outcome, 'canceled')
  assert.equal((await task(selected.id)).state, 'canceled')
  assert.equal((await team.thread(selected.id)).replies.length, 0)
})

test('two runners racing for one claim launch just one process', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: selected } = await team.tasks.create('runtime/fixtures', 'one claim')
  const { options, harness, ready, runs } = job(t)
  const workers = ['ada', 'grace'].map((name) => runTask({ ...options, board: team.as(name), taskId: selected.id })
    .then((value) => ({ value }), (error: unknown) => ({ error })))
  const first = await Promise.race(workers)
  assert.ok('error' in first && first.error instanceof BoardError)
  assert.equal(first.error.code, 'task_claimed')
  const ref = await ready()
  assert.equal((await task(selected.id)).state, 'claimed')
  assert.deepEqual(runs, [ref])
  await harness.send(ref, { id: 'finish', text: 'finish\n' })
  const outcomes = await Promise.all(workers)
  assert.equal(outcomes.filter((result) => 'value' in result && result.value.status === 'released').length, 1)
  assert.equal((await task(selected.id)).state, 'ready')
})

const oneOfEach = { worker: 1, build: 1, qa: 1, review: 1 }
const fixtureOptions = { work: fixtureStart().work, provider: 'fixture', pollMs: 5, renewEveryMs: 20 }

function finishedHarness(outcome: Result['outcome']): Harness {
  return {
    async start() { return 'fixture-run' },
    async observe() { return { state: outcome, cursor: '', events: [], usage: null } },
    async collect() { return { outcome, artifacts: [], usage: null } },
    async send() { return 'not_running' },
    async cancel() {},
  }
}

test('a usage-blocked dispatch leaves the task ready and can run at reset', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: selected } = await team.tasks.create('runtime/fixtures', 'wait for usage reset')
  const resetAt = Date.UTC(2026, 0, 1, 5)
  let now = resetAt - 1
  const guard = usageGuard({ read: () => ({ usedFraction: 0.95, resetAt }) }, { now: () => now })
  const harness = finishedHarness('exited')
  const start = t.mock.method(harness, 'start')
  const options = { ...fixtureOptions, board: team, taskId: selected.id, harness, usageGuard: guard }
  assert.deepEqual(await runTask(options), { status: 'usage_blocked', resetAt })
  assert.equal(start.mock.callCount(), 0)
  assert.equal((await task(selected.id)).epoch, selected.task?.epoch)
  now = resetAt
  assert.equal((await runTask(options)).status, 'released')
  assert.equal(start.mock.callCount(), 1)
})

test('an active run holds its kind until lease revocation cancels it', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: active } = await team.tasks.create('runtime/fixtures', 'active qa')
  const { task: queued } = await team.tasks.create('runtime/fixtures', 'queued qa')
  const directory = await mkdtemp(join(tmpdir(), 'runtime-runner-slots-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const policy = capacity({ limits: oneOfEach, heavy: { directory, slots: 1 } })
  const options = { ...fixtureOptions, board: team.as('qa-worker'), capacity: { policy, kind: 'qa' as const, heavy: true } }
  const worker = fake()
  const harness = finishedHarness('exited')
  const start = t.mock.method(harness, 'start')
  const started = Promise.withResolvers<RunRef>()
  const run = runTask({ ...options, taskId: active.id, harness: {
    ...worker,
    async start(input) {
      const ref = await worker.start(input)
      started.resolve(ref)
      return ref
    },
  } })
  t.after(async () => { await run })
  const ref = await Promise.race([started.promise, run.then(() => { throw new Error('run did not start') })])
  try {
    const next = { ...options, taskId: queued.id, harness }
    assert.deepEqual(await runTask({ ...next, capacity: { policy, kind: 'qa' } }), { status: 'capacity_unavailable' })
    assert.deepEqual(await runTask({ ...next, capacity: { policy, kind: 'build', heavy: true } }), { status: 'capacity_unavailable' })
    assert.equal(start.mock.callCount(), 0)
    assert.equal((await task(queued.id)).epoch, queued.task?.epoch)
  } finally {
    await team.tasks.cancel(active.id, 'revoked by owner')
  }
  assert.deepEqual(await run, { status: 'lease_lost', taskId: active.id })
  assert.equal((await terminal(worker, ref)).outcome, 'canceled')
  assert.equal((await runTask({ ...options, taskId: queued.id, harness })).status, 'released')
})

test('lease loss during start keeps capacity until the late run can be canceled', async (t) => {
  const { team } = await openBoard(t)
  const { task } = await team.tasks.create('runtime/fixtures', 'slow start')
  const claim = await team.tasks.claim(task.id)
  const policy = capacity({ limits: oneOfEach })
  const started = Promise.withResolvers<RunRef>()
  const renewFailed = Promise.withResolvers<void>()
  const returnRef = Promise.withResolvers<void>()
  const worker = fake()
  const run = runTask({
    ...fixtureOptions, capacity: { policy }, taskId: task.id,
    board: { ...team, tasks: { ...team.tasks, async claim() {
      return { ...claim, async renew() {
        await started.promise
        renewFailed.resolve()
        throw new Error('fixture renewal failed')
      } }
    } } },
    harness: { ...worker, async start(input) {
      const ref = await worker.start(input)
      started.resolve(ref)
      await returnRef.promise
      return ref
    } },
  })
  try {
    await Promise.race([renewFailed.promise, run.then(() => { throw new Error('run finished before renewal') })])
    await tick() // Let the renewal rejection reach the runner before allowing start to return.
    assert.equal(await policy.tryReserve({ kind: 'worker' }), null)
  } finally {
    returnRef.resolve()
  }
  assert.deepEqual(await run, { status: 'lease_lost', taskId: task.id })
  assert.equal((await terminal(worker, await started.promise)).outcome, 'canceled')
  const recycled = await policy.tryReserve({ kind: 'worker' })
  assert.ok(recycled)
  await recycled.release()
})

for (const outcome of ['exited', 'failed', 'canceled', 'throws'] as const) {
  test(`capacity is reusable after a run ${outcome}`, async (t) => {
    const { team } = await openBoard(t)
    const { task: first } = await team.tasks.create('runtime/fixtures', 'first run')
    const { task: next } = await team.tasks.create('runtime/fixtures', 'next run')
    const policy = capacity({ limits: oneOfEach })
    const options = { ...fixtureOptions, board: team, capacity: { policy } }
    const harness = finishedHarness('exited')
    const error = new Error('fixture start failed')
    if (outcome === 'throws') {
      const broken: Harness = { ...harness, async start() { throw error } }
      await assert.rejects(runTask({ ...options, taskId: first.id, harness: broken }), error)
    } else {
      const result = await runTask({ ...options, taskId: first.id, harness: finishedHarness(outcome) })
      assert.equal(result.status, 'released')
      assert.equal(result.result.outcome, outcome)
    }
    assert.equal((await runTask({ ...options, taskId: next.id, harness })).status, 'released')
  })
}

test('an empty selection returns its unused reservation', async (t) => {
  const { team } = await openBoard(t)
  const selection = { channel: 'runtime/fixtures' }
  const policy = capacity({ limits: oneOfEach })
  const options = { ...fixtureOptions, board: team, selection, capacity: { policy }, harness: finishedHarness('exited') }
  assert.deepEqual(await runTask(options), { status: 'nothing_ready' })
  await team.tasks.create(selection.channel, 'ready now')
  assert.equal((await runTask(options)).status, 'released')
})
