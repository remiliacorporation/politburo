import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { boardScoreboard, createRouter, registerScoreboardSchema, type AttemptContract, type AttemptResult, type Evidence, type RouterOptions } from '../src/index.ts'
import { fixtureStart } from './support.ts'

async function fixture(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  const writer = team.as('router')
  const channel = 'runtime/scoreboard'
  const author = (await writer.me()).actor
  await registerScoreboardSchema(team)
  const scoreboard = boardScoreboard({ board: writer, channel, author })
  const work = { ...fixtureStart().work, allowedPaths: ['src/', 'README.md'], requiredCheckIds: ['test'], limits: { wallMs: 1000, maxCostMicros: 30 } }
  const evidence: Evidence = {
    baseSha: work.baseSha, headSha: '2'.repeat(40), changedPaths: ['src/index.ts', 'README.md'], passedCheckIds: ['test'],
  }
  let time = 0
  const advance = (ms: number) => time += ms
  const model = (provider: string, model = 'small', maxCostMicros = 10) => ({ provider, model, maxCostMicros })
  const candidate = (overrides: Partial<Evidence> = {}): AttemptResult => ({ outcome: 'candidate', evidence: { ...evidence, ...overrides }, costMicros: 2 })
  const router = (execute: RouterOptions['execute'], options: Partial<RouterOptions> = {}) => createRouter({
    models: [model('a'), model('a', 'large'), model('b')], scoreboard, execute, now: () => time,
    cooldownMs: { auth: 100, quota: 100, timeout: 50 }, probeTimeoutMs: 20, maxAttempts: 3, ...options,
  })
  return { team, writer, channel, author, scoreboard, work, evidence, candidate, model, router, advance }
}

const modelName = ({ provider, model }: Pick<AttemptContract['target'], 'provider' | 'model'>) => `${provider}/${model}`
const picked = (contract: AttemptContract) => modelName(contract.target)

test('routing modes select by persisted success, measured cost, or latency', async (t) => {
  const { scoreboard, writer, channel, author, router, candidate, work, advance, model } = await fixture(t)
  await scoreboard.record({ attemptId: 'one', provider: 'a', model: 'small', outcome: 'verified', costMicros: 9, latencyMs: 12 })
  await scoreboard.record({ attemptId: 'two', provider: 'a', model: 'large', outcome: 'timeout', costMicros: 1, latencyMs: 10 })
  await scoreboard.record({ attemptId: 'three', provider: 'b', model: 'small', outcome: 'bad-output', costMicros: 8, latencyMs: 3 })
  const seen: string[] = []
  const route = router(async (attempt) => {
    seen.push(picked(attempt))
    advance(20)
    return candidate()
  }, { models: [model('unscored'), model('b'), model('a', 'large'), model('a')], scoreboard: boardScoreboard({ board: writer, channel, author }) })
  for (const mode of ['quality', 'cost', 'latency'] as const) {
    assert.equal((await route({ taskId: mode, work, mode })).status, 'verified')
  }
  assert.deepEqual(seen, ['a/small', 'a/large', 'b/small'])
})

test('board scores are one fact per attempt, bounded to the window and attributed to the writer', async (t) => {
  const { scoreboard, writer, channel, author, team } = await fixture(t)
  const sample = { attemptId: 'older', provider: 'a', model: 'small', outcome: 'verified', costMicros: 99, latencyMs: 100 } as const
  await scoreboard.record(sample)
  const recent = { ...sample, attemptId: 'recent', costMicros: 4, latencyMs: 10 }
  await scoreboard.record(recent)
  await scoreboard.record(recent)
  await scoreboard.record({ ...sample, attemptId: 'unknown', outcome: 'timeout', costMicros: null, latencyMs: 20 })
  await team.as('not-router').post(channel, block('runtime-attempt@1', { ...recent, attemptId: 'spoof', costMicros: 0 }))
  const messages = (await team.channel(channel).messages()).messages
  assert.equal(messages.length, 4)
  assert.equal(messages[1]?.by.actor, author)
  assert.deepEqual(messages[1]?.blocks[0]?.data, recent)
  assert.deepEqual(await boardScoreboard({ board: writer, channel, author, window: 3 }).read(), [
    { provider: 'a', model: 'small', attempts: 2, successRate: 0.5, meanCostMicros: 4, meanLatencyMs: 15 },
  ])
})

test('a bad output retries with the same frozen contract and never settles work', async (t) => {
  const { team, work, router, candidate, evidence } = await fixture(t)
  const { task } = await team.tasks.create('work', 'change the fixture')
  const claim = await team.tasks.claim(task.id)
  const attempts: AttemptContract[] = []
  const route = router(async (attempt) => {
    assert.throws(() => (attempt.work.allowedPaths as string[]).push('private/'), TypeError)
    assert.throws(() => Object.assign(attempt.work.limits, { maxCostMicros: 999 }), TypeError)
    assert.throws(() => Object.assign(attempt.target, { model: 'other' }), TypeError)
    assert.throws(() => Object.assign(attempt, { taskId: 'another-task' }), TypeError)
    attempts.push(attempt)
    if (attempts.length === 1) {
      work.allowedPaths.push('private/')
      work.requiredCheckIds.length = 0
      work.limits.maxCostMicros = 0
      return { outcome: 'bad-output', costMicros: 6 }
    }
    return candidate()
  })
  const result = await route({ taskId: task.id, work, mode: 'quality' })
  assert.deepEqual(attempts.map(picked), ['a/small', 'a/large'])
  assert.notEqual(attempts[0]?.attemptId, attempts[1]?.attemptId)
  for (const attempt of attempts) {
    assert.deepEqual(attempt.work.allowedPaths, ['src/', 'README.md'])
    assert.deepEqual(attempt.work.requiredCheckIds, ['test'])
    assert.equal(attempt.work.limits.maxCostMicros, 30)
  }
  assert.equal(result.status, 'verified')
  if (result.status === 'verified') assert.deepEqual(result.evidence, evidence)
  assert.equal(result.chargedMicros, 8)
  assert.equal((await team.thread(task.id)).message.task?.state, 'claimed')
  await claim.release()
  assert.equal((await team.thread(task.id)).message.task?.state, 'ready')
})

for (const [name, evidence] of Object.entries({
  'wrong base': { baseSha: '3'.repeat(40) },
  'outside paths': { changedPaths: ['src-other/index.ts'] },
  'traversal': { changedPaths: ['src/../private.ts'] },
  'missing check': { passedCheckIds: ['other'] },
})) {
  test(`verification stops routing on ${name}`, async (t) => {
    const { router, candidate, work, scoreboard } = await fixture(t)
    const result = await router(async () => candidate(evidence))({ taskId: 'task', work, mode: 'quality' })
    assert.equal(result.status === 'stopped' && result.reason, 'verification-failed')
    assert.deepEqual(result.attempts.map(({ outcome }) => outcome), ['verification-failed'])
    assert.equal((await scoreboard.read())[0]?.successRate, 0)
  })
}

test('budget reserves each model cap and charges unknown failed usage at the cap', async (t) => {
  const { router, work, model } = await fixture(t)
  const selected: string[] = []
  const route = router(async (attempt) => {
    selected.push(picked(attempt))
    return { outcome: 'bad-output', costMicros: null }
  }, { models: [model('too-costly', 'one', 12), model('a', 'small', 5), model('b', 'small', 7)] })
  const outcome = await route({ taskId: 'budget', work: { ...work, limits: { ...work.limits, maxCostMicros: 11 } }, mode: 'quality' })
  assert.deepEqual(selected, ['a/small'])
  assert.equal(outcome.status === 'stopped' && outcome.reason, 'budget-exhausted')
  assert.equal(outcome.chargedMicros, 5)
})

test('a provider that exceeds its cap cannot produce verified work or trigger another attempt', async (t) => {
  const { router, work, evidence } = await fixture(t)
  const outcome = await router(async () => ({ outcome: 'candidate', evidence, costMicros: 11 }))({ taskId: 'overrun', work, mode: 'quality' })
  assert.equal(outcome.status === 'stopped' && outcome.reason, 'budget-overrun')
  assert.equal(outcome.attempts.length, 1)
  assert.equal(outcome.attempts[0]?.costMicros, 11)
  assert.notEqual(outcome.attempts[0]?.outcome, 'verified')
})

test('quota cools the provider; a confirmed timeout cools only the model', async (t) => {
  const { router, candidate, work, advance, scoreboard } = await fixture(t)
  // Keep the cost ranking fixed so dispatch reveals the scope of each cooldown.
  for (const [id, provider, model] of [['one', 'a', 'small'], ['two', 'a', 'large'], ['three', 'b', 'small']] as const) {
    await scoreboard.record({ attemptId: id, provider, model, outcome: 'verified', costMicros: 2, latencyMs: 1 })
  }
  const route = router(async (attempt) => {
    if (attempt.taskId === 'quota' && attempt.target.provider === 'a') return { outcome: 'quota', costMicros: 2 }
    if (attempt.taskId === 'timeout' && picked(attempt) === 'a/small') return { outcome: 'timeout', costMicros: 2 }
    return candidate()
  })
  const run = async (taskId: string) => (await route({ taskId, work, mode: 'cost' })).attempts.map(modelName)
  assert.deepEqual(await run('quota'), ['a/small', 'b/small'])
  advance(99)
  assert.deepEqual(await run('during-quota'), ['b/small'])
  advance(1)
  assert.deepEqual(await run('timeout'), ['a/small', 'a/large'])
  advance(49)
  assert.deepEqual(await run('during-timeout'), ['a/large'])
  advance(1)
  assert.deepEqual(await run('after-timeout'), ['a/small'])
})

test('an access incident gets a single recovery probe after cooldown, including concurrent routing', async (t) => {
  const { router, candidate, work, advance } = await fixture(t)
  const probeStarted = Promise.withResolvers<void>()
  const finishProbe = Promise.withResolvers<boolean>()
  let probes = 0
  const route = router(async (attempt) => attempt.taskId === 'auth' && attempt.target.provider === 'a' ? { outcome: 'auth', costMicros: 0 } : candidate(), {
    probeTimeoutMs: 1000,
    probes: { a: async () => {
      if (++probes > 1) return true
      probeStarted.resolve()
      return finishProbe.promise
    } },
  })
  const run = (taskId: string) => route({ taskId, work, mode: 'cost' })
  assert.deepEqual((await run('auth')).attempts.map(modelName), ['a/small', 'b/small'])
  advance(99)
  assert.deepEqual((await run('too-soon')).attempts.map(modelName), ['b/small'])
  assert.equal(probes, 0)
  advance(1)
  const recovering = run('recovery')
  await probeStarted.promise
  const concurrent = await run('concurrent')
  finishProbe.resolve(true)
  const resumed = await recovering
  assert.deepEqual(concurrent.attempts.map(modelName), ['b/small'])
  assert.equal(resumed.status, 'verified')
  assert.deepEqual(resumed.attempts.map(modelName), ['a/small'])
  assert.deepEqual((await run('recovered')).attempts.map(modelName), ['a/small'])
  assert.equal(probes, 1)
})

test('a hung probe is aborted and does not reopen access or get a second try', async (t) => {
  const { router, candidate, work, model, advance } = await fixture(t)
  let probes = 0
  let probeSignal: AbortSignal | undefined
  const route = router(async (attempt) => attempt.taskId === 'auth' ? { outcome: 'auth', costMicros: 0 } : candidate(), {
    models: [model('a')], probes: { a: async (signal) => { probes++; probeSignal = signal; return new Promise(() => {}) } },
  })
  const run = (taskId: string) => route({ taskId, work, mode: 'quality' })
  await run('auth')
  advance(100)
  const outcome = await run('try-probe')
  assert.equal(outcome.status === 'stopped' && outcome.reason, 'unavailable')
  assert.equal(probeSignal?.aborted, true)
  advance(1000)
  assert.equal((await run('after-probe')).attempts.length, 0)
  assert.equal(probes, 1)
})

test('attempt limit stops fallback even with other eligible models', async (t) => {
  const { router, work } = await fixture(t)
  const route = router(async () => ({ outcome: 'bad-output', costMicros: 0 }), { maxAttempts: 1 })
  const result = await route({ taskId: 'limited', work, mode: 'quality' })
  assert.equal(result.status === 'stopped' && result.reason, 'attempt-limit')
  assert.equal(result.attempts.length, 1)
})

test('the watchdog aborts a hung execution and does not retry while its stop is unconfirmed', async (t) => {
  const { router, work, candidate } = await fixture(t)
  let runSignal: AbortSignal | undefined
  const route = router(async (attempt, signal) => {
    if (picked(attempt) !== 'a/small') return candidate()
    runSignal = signal
    return new Promise(() => {})
  })
  const request = { taskId: 'hangs', work: { ...work, limits: { ...work.limits, wallMs: 20 } }, mode: 'quality' } as const
  const running = route(request)
  const concurrent = await route(request)
  assert.equal(concurrent.status === 'stopped' && concurrent.reason, 'busy')
  const result = await running
  assert.equal(result.status === 'stopped' && result.reason, 'execution-uncertain')
  assert.equal(runSignal?.aborted, true)
  assert.deepEqual(result.attempts.map(({ outcome }) => outcome), ['timeout'])
})
