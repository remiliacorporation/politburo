import { expect, it } from 'vitest'
import type { BoardEventView } from '../src/api/routes.ts'
import { createBoardClient } from '../src/client/client.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'

const bindingFor = (actor: string) => ({
  controller: { principal: actor, actor },
  owner: { principal: actor, actor },
  provider: 'fixture-provider',
  model: 'fixture-model',
  session: 'sess-1',
  branch: 'plb/plb-133',
  worktree: 'worktrees/plb-133',
  baseCommit: 'a'.repeat(40),
})

it('reads a task’s events oldest first, including the claim binding', async () => {
  const api = localBoard()
  try {
    const client = createBoardClient({
      url: BOARD_URL,
      token: await personToken('u_ada', BOARD_URL),
      fetch: (input, init) => api.fetch(new Request(input, init)),
    })
    const { actor } = await client.me()
    const { task } = await client.tasks.create('work', { text: 'Paint the barn' })
    await client.reply(task.id, 'the notes')
    await client.label(task.id, { set: { 'review.verdict': 'pass', 'review.head': 'abc123', 'pr.number': '12' } })
    const claim = await client.tasks.claim(task.id, { binding: bindingFor(actor) })
    await claim.renew()
    await claim.release()
    await client.tasks.block(task.id, 'approve the wording', { kind: 'needs_input' })
    await client.tasks.unblock(task.id)
    const again = await client.tasks.claim(task.id)
    await again.complete('the barn is up')
    const { events } = await client.tasks.events(task.id)
    const types = events.map((event) => event.type)
    const at = (type: BoardEventView['type']) => types.indexOf(type)
    expect(at('task.created')).toBeGreaterThanOrEqual(0)
    expect(at('message.posted')).toBeGreaterThanOrEqual(0)
    expect(at('task.created')).toBeLessThan(at('task.claimed'))
    expect(at('task.claimed')).toBeLessThan(at('task.renewed'))
    expect(at('task.renewed')).toBeLessThan(at('task.released'))
    expect(at('task.released')).toBeLessThan(at('task.blocked'))
    expect(at('task.blocked')).toBeLessThan(at('task.unblocked'))
    expect(at('task.unblocked')).toBeLessThan(types.lastIndexOf('task.claimed'))
    expect(types.lastIndexOf('task.claimed')).toBeLessThan(at('task.completed'))
    expect(events.find((event) => event.type === 'task.claimed')?.payload).toMatchObject({
      binding: { provider: 'fixture-provider', model: 'fixture-model', session: 'sess-1', branch: 'plb/plb-133' },
    })
    expect(events.find((event) => event.type === 'labels.changed')?.payload).toMatchObject({
      set: { 'review.verdict': 'pass', 'review.head': 'abc123', 'pr.number': '12' },
    })
    expect(events.find((event) => event.type === 'message.posted' && event.payload.re !== null)?.payload).toMatchObject({ text: 'the notes' })
    expect(events.find((event) => event.type === 'task.blocked')?.payload).toMatchObject({ kind: 'needs_input', reason: 'approve the wording' })
    expect(events.find((event) => event.type === 'task.completed')?.payload).toMatchObject({ result: 'the barn is up' })
    const other = await client.tasks.create('work', { text: 'Other barn' })
    await client.reply(other.task.id, 'not this one')
    const reread = await client.tasks.events(task.id)
    expect(reread.events.some((event) => event.type === 'message.posted' && event.payload.text === 'not this one')).toBe(false)
    const letter = await client.post('work', 'just a letter')
    await expect(client.tasks.events(letter.id)).rejects.toMatchObject({ status: 404, code: 'not_a_task' })
    await expect(client.tasks.events('m999999')).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
  } finally {
    await api.close()
  }
})
