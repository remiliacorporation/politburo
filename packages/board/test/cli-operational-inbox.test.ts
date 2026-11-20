import { beforeAll, expect, it } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { bearer, board, personToken } from './harness.ts'
import { url, useBoard, vb } from './cli-harness.ts'

useBoard()
let team: ReturnType<typeof board>
beforeAll(async () => {
  team = board({ backend: http(url, { fetch: bearer(fetch, await personToken('u_julian', url)) }) }).as(null)
})

const json = async (...args: string[]) => {
  const { code, stdout, stderr } = await vb([...args, '--json'])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  return JSON.parse(stdout)
}

it('reads, acknowledges and archives operational messages over HTTP, with SDK-shaped JSON', async () => {
  const { principal } = await team.me()
  const sent = await team.operationalInbox.send({ to: { agent: principal }, topic: 'Review', text: '\u001b[31mPlease review the patch.\u001b[0m' })
  const { id } = sent.message
  const outsider = await vb(['inbox', 'read', '--json'], { BOARD_TOKEN: await personToken('u_ada', url) })
  expect(outsider).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(outsider.stdout)).toEqual({ messages: [] })
  expect(await json('inbox', 'read')).toEqual({ messages: [sent.message] })
  const read = await vb(['inbox', 'read'])
  expect(read).toMatchObject({ code: 0, stderr: '' })
  expect(read.stdout).toContain('Please review the patch.')
  expect(read.stdout).not.toContain('\u001b')

  const invalid = await vb(['inbox', 'ack', id, 'done', '--json'])
  expect(invalid).toMatchObject({ code: 2, stdout: '' })
  expect(JSON.parse(invalid.stderr)).toMatchObject({ reason: expect.any(String), message: expect.stringMatching(/seen or acted/) })
  const seen = await json('inbox', 'ack', id, 'seen')
  expect(seen).toEqual({ message: { ...sent.message, seenAt: expect.any(String) } })
  const acted = await json('inbox', 'ack', id, 'acted')
  expect(acted).toEqual({ message: { ...seen.message, actedAt: expect.any(String) } })
  expect(await team.operationalInbox.read()).toEqual({ messages: [acted.message] })
  expect(await json('inbox', 'archive', id)).toEqual({ message: { ...acted.message, archivedAt: expect.any(String) } })
  expect(await json('inbox', 'read')).toEqual({ messages: [] })
  const archived = await vb(['inbox', 'ack', id, 'seen', '--json'])
  expect(archived).toMatchObject({ code: 1, stdout: '' })
  expect(JSON.parse(archived.stderr)).toMatchObject({ reason: 'operational_message_not_found', data: { error: { status: 404 } } })
})

it('preserves the raw sync inbox and escapes a reserved sync key with inbox raw', async () => {
  await team.register({ watch: {}, sync: ['slack', 'read'].map((key) => ({ key, platform: 'slack' })) })
  const event = (id: string, channel: string) => ({
    id,
    event: { kind: 'message' as const, channel, thread: `${channel}:1`, subthread: null, message: id, isRoot: id === '1', text: `from Slack ${id}`, context: null,
      author: { id: `${channel.split(':')[0]}:user:U1`, handle: 'ada', name: 'Ada', avatar: null, isBot: false } },
    raw: { id },
  })
  for (const key of ['slack', 'read']) await team.inboxPush(key, [event('1', `${key}:C1`), event('2', `${key}:C1`), event('3', `${key}:C2`)])
  // Rows in one batch can share a timestamp. Check selection and SDK parity, not a tie order.
  for (const [key, cmd] of [['slack', ['slack']], ['read', ['raw', 'read']]] as const) {
    const channel = `${key}:C1`
    const events = await team.inbox(key, { channel, limit: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ channel })
    expect(await json('inbox', ...cmd, channel, '--limit', '1')).toEqual({ events })
  }
})
