import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { board, type EventsPage } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { refill, type RefillContext, type RefillDraft } from '../../src/ops/refill.ts'

const channel = 'runtime/refill'
const draft = { title: 'Compare formats', body: 'Read the two fixture reports.', kind: 'research' } as const

function openBoard(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  return board({ backend })
}

async function seed(team: ReturnType<typeof openBoard>, count: number) {
  return team.tasks.createMany(channel, Array.from({ length: count }, (_, i) => ({ text: `Existing work ${i + 1}` })))
}

test('refill below threshold proposes work that never becomes ready before approval', async (t) => {
  const team = openBoard(t)
  await seed(team, 4)
  const { task: held } = await team.tasks.create(channel, 'Already held')
  await team.tasks.block(held.id, 'Awaiting review')
  await team.tasks.create('runtime/other', 'Ready elsewhere')
  const contexts: RefillContext[] = []

  assert.deepEqual(await refill(team, {
    channel,
    async agent(context) {
      contexts.push(context)
      return [draft]
    },
  }), { drafted: 1, skipped: false })
  assert.deepEqual(contexts, [{ channel, ready: 4, threshold: 5, max: 15 }])

  const label = { kind: 'research' }
  const { tasks } = await team.tasks.list({ channel, label, state: 'blocked' })
  assert.equal(tasks.length, 1)
  const { message } = tasks[0]!
  assert.equal(message.text, `${draft.title}\n\n${draft.body}`)
  assert.equal(message.task?.blocked?.kind, 'awaiting_approval')
  assert.equal(await team.tasks.claim({ channel, label }), null)
  const worker = team.as('worker', { can: ['read', 'label'] })
  await assert.rejects(worker.tasks.claim(message.id), { code: 'task_blocked' })
  await assert.rejects(worker.tasks.unblock(message.id), { code: 'task_not_owned' })

  const response = await team.request(`/events?channel=${channel}&after=0`)
  assert.equal(response.status, 200)
  const { events } = await response.json() as EventsPage
  const history = events.filter((event) => event.message?.id === message.id)
  assert.ok(history.some((event) => event.message?.task?.state === 'blocked'))
  assert.ok(!history.some((event) => ['ready', 'claimed'].includes(event.message?.task?.state ?? '')))

  await team.tasks.unblock(message.id)
  const claim = await worker.tasks.claim(message.id)
  assert.equal(claim.task.id, message.id)
  await claim.release()
})

test('refill skips at and above the ready threshold without calling the agent', async (t) => {
  const team = openBoard(t)
  await seed(team, 5)
  const options = {
    channel,
    async agent() { assert.fail('agent must not run when enough work is ready') },
  }

  assert.deepEqual(await refill(team, options), { drafted: 0, skipped: true })
  await team.tasks.create(channel, 'One more ready task')
  assert.deepEqual(await refill(team, options), { drafted: 0, skipped: true })
  assert.equal((await team.tasks.list({ channel, state: 'all' })).tasks.length, 6)
})

test('refill enforces the hard cap of 15 even if a higher max is requested', async (t) => {
  const team = openBoard(t)
  const drafts: RefillDraft[] = Array.from({ length: 20 }, (_, i) => ({
    title: `Draft ${i + 1}`, body: 'Fixture body.', kind: 'write-up',
  }))

  assert.deepEqual(await refill(team, {
    channel, max: 20,
    async agent(context) {
      assert.equal(context.max, 15)
      return drafts
    },
  }), { drafted: 15, skipped: false })

  const { tasks } = await team.tasks.list({ channel, state: 'all' })
  assert.deepEqual(tasks.map(({ message }) => message.text), drafts.slice(0, 15).map(({ title, body }) => `${title}\n\n${body}`))
  assert.ok(tasks.every(({ message }) => message.task?.state === 'blocked'))
})

test('refill respects a smaller requested maximum', async (t) => {
  const team = openBoard(t)
  assert.deepEqual(await refill(team, {
    channel, max: 1,
    async agent() { return [draft, { ...draft, title: 'Another proposal', kind: 'critique' }] },
  }), { drafted: 1, skipped: false })
  assert.equal((await team.tasks.list({ channel, state: 'all' })).tasks.length, 1)
})
