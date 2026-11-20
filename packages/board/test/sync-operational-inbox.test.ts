import { expect, it, vi } from 'vitest'
import { slack } from '../src/sync/slack.ts'
import { BOARD_URL, testBoard } from './harness.ts'
import { fakePlatform } from './sync-fixtures.ts'

it('does not lend the sync principal’s operational inbox to an inbound callback', async () => {
  const { adapter } = fakePlatform('slack')
  const to = { role: 'ops' }
  const attempt = (call: Promise<unknown>) => call.then(() => 'allowed', (error: unknown) => error)
  let id: string
  let attempts: Record<string, unknown> = {}
  const team = testBoard({
    inboxRoles: { ops: ['board:sync', 'board:client'] },
    sync: {
      slack: slack({ adapter }, async (sync) => {
        if (sync.direction !== 'in') return
        const inbox = sync.board.operationalInbox
        attempts = {
          read: await attempt(inbox.read()),
          send: await attempt(inbox.send({ to, topic: 'from callback', text: 'should not land' })),
          ack: await attempt(inbox.ack(id, 'acted')),
          archive: await attempt(inbox.archive(id)),
        }
        await sync.board.post('triage', 'callback still posts')
      }),
    },
  })
  const { message } = await team.operationalInbox.send({ to, topic: 'review', text: 'private ops message' })
  id = message.id
  const response = await team.fetch(new Request(`${BOARD_URL}/webhooks/slack`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U_ADA' }),
  }))
  expect(response.ok).toBe(true)
  await vi.waitFor(async () => {
    const { messages } = await team.channel('triage').messages()
    expect(messages).toMatchObject([{ text: 'callback still posts', by: { actor: 'slack:user:U_ADA' } }])
  })
  const denied = expect.objectContaining({ status: 403, code: 'forbidden' })
  expect(attempts).toEqual({ read: denied, send: denied, ack: denied, archive: denied })
  expect(await team.operationalInbox.read()).toEqual({ messages: [message] })
  expect(await team.inbox('slack')).toHaveLength(1)
})
