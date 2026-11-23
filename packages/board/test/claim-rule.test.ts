import { expect, it } from 'vitest'
import { localBoard, personToken } from './harness.ts'
import { caller } from './tokens.ts'

it('refuses ID and next claims with the rule’s code and leaves the task ready', async ({ onTestFinished }) => {
  const refuse = { code: 'cooling', message: 'wait before claiming' }
  const team = localBoard({ claimRule: async ({ actor, channel, task }) => {
    if (actor === 'board:client' && channel === 'work' && (task === root.id || task === null)) return { refuse }
  } })
  onTestFinished(() => team.close())
  const { task: root } = await team.tasks.create('work', 'a task in cooldown')
  const denied = { status: 409, ...refuse }
  await expect(team.tasks.claim(root.id)).rejects.toMatchObject(denied)
  await expect(team.tasks.claim({ channel: 'work' })).rejects.toMatchObject(denied)
  expect((await team.thread(root.id)).message.task?.state).toBe('ready')
})

it('fails closed with 503 when the rule throws', async ({ onTestFinished }) => {
  const team = localBoard({ claimRule: () => { throw new Error('could not reach the rule store') } })
  onTestFinished(() => team.close())
  const { task } = await team.tasks.create('work', 'a task to leave alone')
  await expect(team.tasks.claim(task.id)).rejects.toMatchObject({ status: 503, code: 'claim_rule_failed' })
  expect((await team.thread(task.id)).message.task?.state).toBe('ready')
})

it('checks access before consulting the rule, including for a subtree', async ({ onTestFinished }) => {
  const team = localBoard({ claimRule: () => { throw new Error('the rule must not run') } })
  onTestFinished(() => team.close())
  const { task } = await team.tasks.create('work/queue', 'a task without label access')
  const restricted = team.as(null, { can: { '*': ['read'], elsewhere: ['label'] } })
  for (const attempt of [() => restricted.tasks.claim(task.id), () => restricted.tasks.claim({ channel: 'work' }), () => restricted.tasks.claim({ channel: 'work/' })]) {
    await expect(attempt()).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  }
})

it('refuses a binding naming a different owner before consulting the rule', async ({ onTestFinished }) => {
  const team = localBoard({ claimRule: () => { throw new Error('the rule must not run') } })
  onTestFinished(() => team.close())
  const ada = caller(team.fetch, await personToken('u_ada'))
  const { task } = await team.tasks.create('work', 'a task for a bound claim')
  const bo = { principal: 'vercel:user:u_bo', actor: 'vercel:user:u_bo' }
  const binding = { controller: bo, owner: bo, provider: 'test', model: 'test', session: 'test', branch: 'work', worktree: 'work', baseCommit: 'a'.repeat(40) }
  for (const [path, body] of [[`/tasks/${task.id}/claim-bound`, { binding }], ['/tasks/claim-bound', { channel: 'work', binding }]] as const) {
    expect(await ada('POST', path, body)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
  }
})

it('admits exactly one of two simultaneous claims under an open-claim cap', async ({ onTestFinished }) => {
  const refuse = { code: 'at_cap', message: 'one claim is already open' }
  const team = localBoard({ claimRule: async () => {
    if ((await team.tasks.list({ state: 'claimed' })).tasks.length) return { refuse }
  } })
  onTestFinished(() => team.close())
  const first = await team.tasks.create('work', 'first task')
  await team.tasks.create('next', 'second task')
  const results = await Promise.allSettled([
    team.as('one').tasks.claim(first.task.id),
    team.as('two').tasks.claim({ channel: 'next' }),
  ])
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(results.find(({ status }) => status === 'rejected')).toMatchObject({ reason: { status: 409, ...refuse } })
  expect((await team.tasks.list({ state: 'claimed' })).tasks).toHaveLength(1)
})

it('renews an existing claim even after the rule starts refusing new claims', async ({ onTestFinished }) => {
  let closed = false
  const team = localBoard({ claimRule: () => { if (closed) return { refuse: { code: 'closed', message: 'not taking new claims' } } } })
  onTestFinished(() => team.close())
  const { task } = await team.tasks.create('work', 'a task to keep working')
  const claim = await team.tasks.claim(task.id, { lease: 30 })
  closed = true
  expect(Date.parse((await claim.renew(60)).until)).toBeGreaterThan(Date.parse(claim.until))
})
