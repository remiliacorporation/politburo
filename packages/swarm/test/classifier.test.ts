import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Worker } from 'node:worker_threads'
import {
  ClassifierInvalid, ClassifierUnavailable, createClassifier, fakeClassifier, runClassifierCli,
  typesafeClassifier, type Ask, type Classifier, type ClassifierInput,
} from '../src/classifier/index.ts'

const mail: Ask = {
  question: 'J2', urgency: 'p1', case_ref: 'review-1',
  state: { excerpt: 'The review is ready.', source_kind: 'mail', fields: {} },
}
const drop = { label: 'no_spawner', probabilities: { no_spawner: 1, needs_spawner: 0 } }
const dropClassifier = fakeClassifier({ needs_spawner: drop })
const sentinel = 'test-only-typesafe-sentinel'
const baseUrl = 'https://classifier.invalid'
const clientInput: ClassifierInput = {
  question: 'needs_spawner', promptVersion: 1, instruction: 'Choose a label.',
  choices: ['needs_spawner', 'no_spawner'], state: mail.state,
}

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-classifier-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function service(dir: string, classifier = dropClassifier, state = 'live', key = 'needs_spawner', limit = '1/500') {
  return createClassifier({ dir, classifier, config: {
    secretary: { questions: { [key]: { enabled: true, state, threshold: 0.97, late_p1_rate_limit: limit } } },
  } })
}

function callLog(dir: string) {
  return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
}

test('p0 reaches the classifier or fails to wake', async (t) => {
  const calls: ClassifierInput[] = []
  const classifier: Classifier = { async classify(input) { calls.push(input); return drop } }
  const decision = await service(tempDir(t), classifier).ask({ ...mail, urgency: 'p0' })
  assert.equal(calls.length, 0)
  assert.equal(decision.action, 'wake')
})

test('a below-threshold drop suppresses a live wake', async (t) => {
  const classifier = fakeClassifier({ needs_spawner: {
    label: 'no_spawner', probabilities: { no_spawner: 0.96, needs_spawner: 0.04 },
  } })
  const decision = await service(tempDir(t), classifier).ask(mail)
  assert.equal(decision.reason, 'below_threshold')
  assert.equal(decision.action, 'wake')
})

test('shadow acts on a drop or fails to log what it would do', async (t) => {
  const dir = tempDir(t)
  const decision = await service(dir, dropClassifier, 'shadow').ask(mail)
  assert.equal(decision.action, 'wake')
  assert.equal(decision.action_would, 'drop')
  const record = JSON.parse(callLog(dir).trim())
  assert.equal(record.action_taken, 'wake')
  assert.equal(record.action_would, 'drop')
})

test('unavailable, invalid or refused classifications suppress a wake or send a request', async (t) => {
  const dir = tempDir(t)
  const fetch = t.mock.fn(async () => Response.json({ choice: drop.label, probabilities: drop.probabilities }))
  const unavailable = service(dir, typesafeClassifier({ baseUrl, env: {}, fetch }))
  const invalid = service(dir, fakeClassifier({ needs_spawner: {
    label: drop.label, probabilities: { no_spawner: 1, needs_spawner: 1 },
  } }))
  const refused = service(dir, typesafeClassifier({ baseUrl, env: { TYPESAFE_API_KEY: sentinel }, fetch }))
  const cases = [
    [unavailable, mail, 'unavailable'],
    [invalid, mail, 'invalid'],
    ...['diff --git a/note b/note', 'api_key=synthetic', '```text\nnote\n```', 'x'.repeat(601)]
      .map((excerpt) => [refused, { ...mail, state: { ...mail.state, excerpt } }, 'guard'] as const),
  ] as const
  for (const [classifier, input, reason] of cases) {
    const decision = await classifier.ask(input)
    assert.equal(fetch.mock.callCount(), 0, reason)
    assert.equal(decision.action, 'wake', reason)
    assert.equal(decision.reason, reason)
  }
})

test('a costly breach does not stay latched or a reasoned clear does not release it', async (t) => {
  const dir = tempDir(t)
  const live = service(dir)
  for (const case_ref of ['review-1', 'review-2']) {
    const decision = await live.ask({ ...mail, case_ref })
    assert.equal(decision.action, 'drop')
    assert.ok(decision.call_id)
    live.outcome(decision.call_id, { spawner_did: 'wake', costly: true })
  }
  const reopened = service(dir)
  const latched = await reopened.ask({ ...mail, case_ref: 'review-3' })
  assert.equal(latched.action, 'wake')
  assert.equal(latched.action_would, 'drop')
  assert.equal(latched.reason, 'shadow')
  assert.throws(() => reopened.clear('J2', ' '), /invalid classifier clear/)
  reopened.clear('J2', 'Core reviewed the missed wakes')
  assert.equal((await service(dir).ask({ ...mail, case_ref: 'review-4' })).action, 'drop')
})

test('a breach with a missing switch ages out after non-costly outcomes and suppresses a wake', async (t) => {
  const dir = tempDir(t)
  const open = () => service(dir, dropClassifier, 'live', 'needs_spawner', '1/3')
  const live = open()
  const ids: string[] = []
  for (let i = 0; i < 6; i++) {
    const { call_id } = await live.ask({ ...mail, case_ref: `review-${i}` })
    assert.ok(call_id)
    ids.push(call_id)
  }
  for (const [i, id] of ids.entries()) {
    live.outcome(id, { spawner_did: 'wake', costly: i < 2 })
  }
  rmSync(join(dir, 'switches.jsonl'))

  const reopened = open()
  const decision = await reopened.ask({ ...mail, case_ref: 'review-next' })
  assert.equal(decision.action, 'wake')
  assert.equal(decision.action_would, 'drop')
  assert.equal(reopened.report().find(({ id }) => id === 'J2')?.latched, true)
})

test('appending after torn tails corrupts classifier logs or loses complete records', async (t) => {
  const dir = tempDir(t)
  const live = service(dir)
  const { call_id } = await live.ask(mail)
  assert.ok(call_id)
  live.clear('J2', 'Initial review')
  const switches = join(dir, 'switches.jsonl')
  const callsBefore = callLog(dir)
  const switchesBefore = readFileSync(switches, 'utf8')
  appendFileSync(join(dir, 'calls.jsonl'), '{"call_id":')
  appendFileSync(switches, '{"type":')

  live.outcome(call_id, { spawner_did: 'wake', costly: true })
  live.clear('J2', 'Reviewed the missed wake')

  const reopened = service(dir)
  const row = reopened.report().find(({ id }) => id === 'J2')
  assert.equal(row?.calls, 1)
  assert.equal(row?.costly, 1)
  const callsAfter = callLog(dir)
  const switchesAfter = readFileSync(switches, 'utf8')
  assert.ok(callsAfter.startsWith(callsBefore))
  assert.ok(switchesAfter.startsWith(switchesBefore))
  const clear = JSON.parse(switchesAfter.slice(switchesBefore.length))
  assert.equal(clear.type, 'clear')
  assert.equal(clear.reason, 'Reviewed the missed wake')
})

test('outcomes that arrive out of call order hide a breach in the last window', async (t) => {
  const dir = tempDir(t)
  const open = () => service(dir, dropClassifier, 'live', 'needs_spawner', '1/2')
  const live = open()
  const ids: string[] = []
  for (const case_ref of ['review-a', 'review-b', 'review-c']) {
    const { call_id } = await live.ask({ ...mail, case_ref })
    assert.ok(call_id)
    ids.push(call_id)
  }
  live.outcome(ids[2]!, { spawner_did: 'wake', costly: true })
  live.outcome(ids[0]!, { spawner_did: 'drop', costly: false })
  live.outcome(ids[1]!, { spawner_did: 'wake', costly: true })
  rmSync(join(dir, 'switches.jsonl'), { force: true })

  const decision = await open().ask({ ...mail, case_ref: 'review-next' })
  assert.equal(decision.action, 'wake')
  assert.equal(decision.reason, 'shadow')
})

test('two repairs of one torn tail cannot drop a record the other appended', async (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'calls.jsonl'), '{"id":"kept"}\n{"id":')
  const shared = new SharedArrayBuffer(8)
  const view = new Int32Array(shared)
  const workers = ['a', 'b'].map((id) => new Worker(new URL('./classifier-repair-worker.ts', import.meta.url), {
    workerData: { dir, id, shared },
  }))
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once('error', reject)
      worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`repair worker exited ${code}`)))
    })))
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
  assert.equal(Atomics.load(view, 1), 1)
  const lines = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n')
  assert.deepEqual(lines.map((line) => JSON.parse(line).id ?? JSON.parse(line).call_id).sort(), ['a', 'b', 'kept'])
})

test('pre-clear outcomes cause one new costly outcome to breach again', async (t) => {
  const dir = tempDir(t)
  const live = service(dir)
  const ids = []
  for (const case_ref of ['review-1', 'review-2', 'review-3']) {
    const { call_id } = await live.ask({ ...mail, case_ref })
    assert.ok(call_id)
    ids.push(call_id)
  }
  for (const id of ids.slice(0, 2)) live.outcome(id, { spawner_did: 'wake', costly: true })
  live.clear('J2', 'Core reviewed the missed wakes')
  live.outcome(ids[2]!, { spawner_did: 'wake', costly: true })

  assert.equal((await service(dir).ask({ ...mail, case_ref: 'review-4' })).action, 'drop')
})

test('TypeSafe leaks the excerpt or key to logs or errors, or sends the key outside Authorization', async (t) => {
  const dir = tempDir(t)
  let transportFails = false
  const requests: Request[] = []
  const classifier = typesafeClassifier({ baseUrl, env: { TYPESAFE_API_KEY: sentinel }, async fetch(input, init) {
    requests.push(new Request(input, init))
    if (transportFails) throw new Error(`${sentinel}: ${mail.state.excerpt}`)
    return Response.json({ choice: drop.label, probabilities: drop.probabilities, snapshot: sentinel })
  } })
  assert.equal((await service(dir, classifier).ask(mail)).action, 'drop')
  transportFails = true
  await assert.rejects(classifier.classify(clientInput), (error) => {
    assert.ok(error instanceof ClassifierUnavailable)
    assert.equal(error.message.includes(sentinel), false, 'key in error')
    assert.equal(error.message.includes(mail.state.excerpt), false, 'excerpt in error')
    return true
  })
  assert.ok(requests.length > 0)
  for (const request of requests) {
    assert.equal(request.headers.get('authorization') === `Bearer ${sentinel}`, true, 'missing bearer header')
    request.headers.delete('authorization')
    assert.equal(JSON.stringify([...request.headers]).includes(sentinel), false, 'key in another header')
    assert.equal(request.url.includes(sentinel), false, 'key in URL')
    assert.equal((await request.text()).includes(sentinel), false, 'key in body')
  }
  const log = callLog(dir)
  assert.equal(log.includes(mail.state.excerpt), false, 'excerpt in call log')
  assert.equal(log.includes(sentinel), false, 'key in call log')
})

test('TypeSafe accepts a label outside the choices or probabilities that do not sum to one', async () => {
  for (const response of [
    { choice: 'invented', probabilities: drop.probabilities },
    { choice: drop.label, probabilities: { no_spawner: 1, needs_spawner: 1 } },
  ]) {
    const classifier = typesafeClassifier({ baseUrl, env: { TYPESAFE_API_KEY: sentinel },
      async fetch() { return Response.json(response) },
    })
    await assert.rejects(classifier.classify(clientInput), ClassifierInvalid, response.choice)
  }
})

test('J1 routes to a repo no longer among the supplied candidates', async (t) => {
  const candidateRepos = ['repo-a', 'repo-b']
  let revoke = false
  const classifier: Classifier = { async classify({ choices }) {
    if (revoke) candidateRepos.splice(candidateRepos.indexOf('repo-a'), 1)
    return { label: 'repo-a', probabilities: Object.fromEntries(choices.map((choice) => [choice, Number(choice === 'repo-a')])) }
  } }
  const intake = service(tempDir(t), classifier, 'live', 'intake_route')
  assert.equal((await intake.ask({ ...mail, question: 'J1', candidateRepos })).action, 'route:repo-a')
  revoke = true
  const decision = await intake.ask({ ...mail, question: 'J1', candidateRepos })
  assert.equal(decision.action, 'wake')
  assert.equal(decision.reason, 'invalid')
})

test('J1 through J10 lack a wake-compatible default or a report line', async (t) => {
  const dir = tempDir(t)
  const defaults = createClassifier({ dir, classifier: dropClassifier })
  const ids = Array.from({ length: 10 }, (_, i) => `J${i + 1}`)
  for (const question of ids) {
    const decision = await defaults.ask({ ...mail, question })
    assert.equal(decision.action, 'wake', question)
    assert.equal(decision.reason, 'disabled', question)
  }
  const log = t.mock.method(console, 'log', () => {})
  assert.equal(runClassifierCli(['report', dir]), 0)
  const lines = log.mock.calls.flatMap(({ arguments: args }) => String(args[0]).split('\n'))
  assert.deepEqual(lines.map((line) => line.trim().split(/\s+/)[0]).sort(), [...ids].sort())
  for (const line of lines) assert.match(line, /^J\d+\s+shadow\b/)
})
