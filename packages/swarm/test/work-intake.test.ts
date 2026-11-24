import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { block, board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { http } from '../../board/src/backend-http/index.default.ts'
import { board as boardOverHttp } from '../../board/src/server/index.default.ts'
import { bearer, BOARD_URL, localUserToken, testLocal } from '../../board/test/tokens.ts'
import { decideIntake, IntakeError, listIntake, registerIntakeSchemas, registerWorkSchemas, submitIntake } from '../src/work/index.ts'

const contract = `## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
- [ ] kind: report
      location: docs/retry-cap.md
      required_sections: [findings, recommendation]
      evidence: path

## Verification
- completion_rule: any_outcome
- reviewer: jockey
- on_no_match: release_and_dock`

async function fixture(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  let dropWork = false
  let beforeDecision: (() => Promise<void>) | undefined
  const server: Parameters<typeof board>[0] = {
    backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }),
    middleware: [async ({ write, next }) => {
      if (write.kind === 'post' && write.channel === 'work/web' && write.labels['work.id'] && dropWork) return
      if (write.kind === 'post' && write.channel === 'intake/web' && write.re) await beforeDecision?.()
      await next()
    }],
  }
  const team = board(server)
  const spawner = team.as('intake-spawner')
  const otherSpawner = team.as('intake-spawner')
  const token = await localUserToken('colleague')
  const colleague = boardOverHttp({ backend: http(BOARD_URL, {
    fetch: bearer((input, init) => team.fetch(new Request(input, init)), token),
  }) })
  await registerWorkSchemas(spawner)
  await registerIntakeSchemas(spawner)
  const submitter = (await colleague.me()).actor
  const spawnerActor = (await spawner.me()).actor
  const input = { tag: 'WEB', repo: 'acme/web', title: 'Fix retry cap (#42)', description: 'Work on it' }
  // WP-403 local grant stub, keyed by the verified actor and repo.
  const mayUse = (actor: string, repo: string) => actor === submitter && repo === input.repo
  const options = { tag: input.tag, tags: ['web'], channel: 'work/web', mayUse }
  const routes = { web: { repo: input.repo, spawner: spawnerActor }, ops: { repo: 'acme/ops', spawner: spawnerActor } }
  return {
    spawner, otherSpawner, colleague, submitter, spawnerActor, input, options, routes,
    dropWork: (drop: boolean) => { dropWork = drop },
    beforeDecision: (hook: () => Promise<void>) => { beforeDecision = hook },
    submit: (description = input.description) => submitIntake(colleague, { ...input, description, mayUse }, routes),
    list: () => listIntake(spawner, 'web', routes),
    decide: (requestId: string, decision: 'approve' | 'deny', reason = '') =>
      decideIntake(spawner, { ...options, requestId, decision, reason }, routes),
    tasks: async () => (await spawner.tasks.list({ channel: options.channel, state: 'all', label: ['work.id'] })).tasks,
  }
}

test('a colleague without repo access must leave the intake channel empty', async t => {
  const f = await fixture(t)
  const spawnerOnly = (actor: string, repo: string) => actor === f.spawnerActor && repo === f.input.repo
  const input = { ...f.input, mayUse: spawnerOnly, actor: f.spawnerActor }
  await assert.rejects(submitIntake(f.colleague, input, f.routes), { name: IntakeError.name, code: 'repo_forbidden' })
  assert.deepEqual((await f.spawner.threads({ channel: 'intake/web' })).threads, [])
})

test('submission replay must not duplicate the request or sync it externally', async t => {
  const f = await fixture(t)
  const input = { ...f.input, mayUse: f.options.mayUse, id: 'retry-cap-42' }
  const first = await submitIntake(f.colleague, input, f.routes)
  const replay = await submitIntake(f.colleague, input, f.routes)
  assert.equal(replay.id, first.id)
  assert.equal(first.noSync, true)
  assert.deepEqual((await f.list()).map(r => [r.id, r.status, r.by.actor]), [[first.id, 'pending', f.submitter]])
})

test('ops intake must refuse acme/web even when the submitter can use acme/web', async t => {
  const f = await fixture(t)
  await assert.rejects(submitIntake(f.colleague, { ...f.input, tag: 'ops', mayUse: () => true }, f.routes),
    { code: 'repo_forbidden' })
  assert.deepEqual((await f.spawner.threads({ channel: 'intake/ops' })).threads, [])
})

for (const [field, changed] of [
  ['title', { title: 'Different title' }],
  ['description', { description: 'Different description' }],
  ['repo on the same route', { repo: 'acme/ops' }],
  ['repo across routes', { tag: 'ops', repo: 'acme/ops' }],
] as const) {
  test(`a submission id replay must conflict when its ${field} changes`, async t => {
    const f = await fixture(t)
    const input = { ...f.input, mayUse: () => true, id: 'retry-cap-42' }
    const first = await submitIntake(f.colleague, input, f.routes)
    await assert.rejects(submitIntake(f.colleague, { ...input, ...changed }, f.routes), { code: 'submission_conflict' })
    assert.equal((await submitIntake(f.colleague, input, f.routes)).id, first.id)
  })
}

for (const [field, changed] of [['repo', { work_repo: 'acme/ops' }], ['tag', { tag: 'ops' }]] as const) {
  test(`a direct board request naming the wrong ${field} must not be listed or approved`, async t => {
    const f = await fixture(t)
    const { id } = await f.colleague.post('intake/web', block('intake-request@1', {
      work_repo: f.input.repo, tag: 'web', title: f.input.title, description: f.input.description,
      submitted_at: new Date().toISOString(), ...changed,
    }))
    assert.deepEqual(await f.list(), [])
    await assert.rejects(decideIntake(f.spawner, {
      ...f.options, requestId: id, decision: 'approve', reason: '', mayUse: () => true,
    }, f.routes), { code: 'invalid_request' })
    assert.deepEqual((await f.spawner.thread(id)).replies, [])
    assert.deepEqual(await f.tasks(), [])
  })
}

test('approval must not make a ticket without a contract claimable or infer a link from its title', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  const decision = await f.decide(id, 'approve')
  const tasks = await f.tasks()
  assert.equal(tasks.length, 1)
  const { message } = tasks[0]!
  assert.equal(message.text, `${f.input.title}\n\n${f.input.description}`)
  await assert.rejects(f.colleague.tasks.claim(message.id), { code: 'task_blocked' })
  const { replies } = await f.spawner.thread(message.id)
  assert.deepEqual(replies.flatMap(r => r.blocks).find(b => b.schema === 'work-item')?.data.links, [])
  const [request] = await f.list()
  assert.equal(request?.status, 'approved')
  assert.equal(request.decision?.work_id, message.labels['work.id'])
  assert.equal(request.decision?.work_id, decision.work_id)
})

test('approval must preserve a valid contract so the resulting ticket can be claimed', async t => {
  const f = await fixture(t)
  await f.decide((await f.submit(contract)).id, 'approve')
  const tasks = await f.tasks()
  assert.equal(tasks.length, 1)
  const { task } = await f.colleague.tasks.claim(tasks[0]!.message.id)
  assert.equal(task.text, `${f.input.title}\n\n${contract}`)
})

test('a blank denial reason must not leave a decision reply', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  await assert.rejects(f.decide(id, 'deny', '  '), { code: 'reason_required' })
  assert.deepEqual((await f.spawner.thread(id)).replies, [])
})

test('a later competing decision must not reverse the denial or create work', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  await f.decide(id, 'deny', 'out of scope')
  await assert.rejects(f.decide(id, 'approve'), { code: 'already_decided' })
  const [request] = await f.list()
  assert.equal(request?.status, 'denied')
  assert.equal(request.decision?.reason, 'out of scope')
  assert.deepEqual(await f.tasks(), [])
})

test('a non-spawner reply must not prevent the configured spawner from deciding', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  await f.colleague.reply(id, block('intake-decision@1', {
    request: id, decision: 'deny', reason: 'forged', work_id: null,
  }))
  await f.decide(id, 'deny', 'out of scope')
  assert.equal((await f.list())[0]?.decision?.reason, 'out of scope')
})

test('listIntake must not count a forged decision even when read by its author', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  await f.colleague.reply(id, block('intake-decision@1', {
    request: id, decision: 'deny', reason: 'forged', work_id: null,
  }))
  assert.equal((await listIntake(f.colleague, 'web', f.routes))[0]?.status, 'pending')
})

test('decideIntake must reject a caller other than the configured spawner', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  await assert.rejects(decideIntake(f.colleague, {
    ...f.options, requestId: id, decision: 'deny', reason: 'forged',
  }, f.routes), { code: 'not_spawner' })
  assert.deepEqual((await f.spawner.thread(id)).replies, [])
})

for (const winner of ['approve', 'deny'] as const) {
  test(`concurrent independent deciders must not both win when ${winner} lands first`, { timeout: 5000 }, async t => {
    const f = await fixture(t)
    const { id } = await f.submit()
    const loser = winner === 'approve' ? 'deny' : 'approve'
    const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>()
    const { promise: released, resolve: release } = Promise.withResolvers<void>()
    let first = true
    f.beforeDecision(async () => {
      if (!first) return
      first = false
      arrive()
      await released
    })
    const competing = assert.rejects(decideIntake(f.otherSpawner, {
      ...f.options, requestId: id, decision: loser, reason: 'competing decision',
    }, f.routes), { code: 'already_decided' })
    await Promise.all([
      arrived.then(() => f.decide(id, winner, 'winner')).finally(release),
      competing,
    ])
    const [request] = await f.list()
    assert.equal(request?.status, winner === 'approve' ? 'approved' : 'denied')
    assert.equal(request.decision?.reason, 'winner')
    assert.equal((await f.spawner.thread(id)).replies.length, 1)
    assert.equal((await f.tasks()).length, winner === 'approve' ? 1 : 0)
  })
}

test('a crash before task creation must leave pending-work and retry the same reservation exactly once', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  // Inject the failure through real board middleware, before the work task lands.
  f.dropWork(true)
  await assert.rejects(f.decide(id, 'approve'), { code: 'dropped' })
  const [pending] = await f.list()
  assert.equal(pending?.status, 'pending-work')
  assert.ok(pending.decision?.work_id)
  assert.deepEqual(await f.tasks(), [])
  await assert.rejects(f.decide(id, 'approve', 'different reason'), { code: 'already_decided' })
  f.dropWork(false)
  await decideIntake(f.otherSpawner, { ...f.options, requestId: id, decision: 'approve', reason: '' }, f.routes)
  await f.decide(id, 'approve')
  const [approved] = await f.list()
  assert.equal(approved?.status, 'approved')
  assert.deepEqual((await f.tasks()).map(({ message }) => message.labels['work.id']), [pending.decision.work_id])
  assert.equal((await f.spawner.thread(id)).replies.length, 1)
})

test('editing the decision reply must not turn a denial into an approval or unlock it', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  await f.decide(id, 'deny', 'out of scope')
  const [reply] = (await f.spawner.thread(id)).replies
  await f.spawner.edit(reply!.id, block('intake-decision@1', {
    request: id, decision: 'approve', reason: '', work_id: 'web-1',
  }))
  assert.equal((await f.list())[0]?.status, 'pending')
  await assert.rejects(f.decide(id, 'approve'), { code: 'already_decided' })
  assert.deepEqual(await f.tasks(), [])
})

test('approval must recheck the original submitter and leave no decision or work after revocation', async t => {
  const f = await fixture(t)
  const { id } = await f.submit()
  await assert.rejects(decideIntake(f.spawner, {
    ...f.options, requestId: id, decision: 'approve', reason: '',
    mayUse: (actor, repo) => actor === f.spawnerActor && repo === f.input.repo,
  }, f.routes), { code: 'repo_forbidden' })
  assert.deepEqual((await f.spawner.thread(id)).replies, [])
  assert.deepEqual(await f.tasks(), [])
})
