import { expect, it } from 'vitest'
import { localBoard } from './harness.ts'

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

it('renews an existing claim even after the rule starts refusing new claims', async ({ onTestFinished }) => {
  let closed = false
  const team = localBoard({ claimRule: () => { if (closed) return { refuse: { code: 'closed', message: 'not taking new claims' } } } })
  onTestFinished(() => team.close())
  const { task } = await team.tasks.create('work', 'a task to keep working')
  const claim = await team.tasks.claim(task.id, { lease: 30 })
  closed = true
  expect(Date.parse((await claim.renew(60)).until)).toBeGreaterThan(Date.parse(claim.until))
})
