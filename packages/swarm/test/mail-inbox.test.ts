import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { block, board, type Board, type BoardOptions } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createInbox, MAIL_SCHEMA, registerMailSchema, sendMail, type MailMessage } from '../src/mail/index.ts'

const channel = 'inbox'
const at = '2026-11-20T21:14:00Z'
const now = () => new Date('2026-11-21T00:00:00Z')

function mail(id: string, fields: Partial<MailMessage> = {}): MailMessage {
  return {
    id, class: 'sec.push', urgency: 'p2', from: 'attempt-120', ref: id,
    summary: 'Review ready', body: 'See the findings on the work item.', at, ...fields,
  }
}

async function openBoard(t: TestContext, options: Pick<BoardOptions, 'middleware'> = {}) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, ...options })
  await registerMailSchema(team)
  const inbox = createInbox({ board: team, channel, now })
  const send = (message: MailMessage, scope = 'core') => sendMail(team, channel, message, { scope })
  const queued = async (limit = 10) => (await inbox.readOpen({ limit })).map(({ messageId }) => messageId)
  return { team, inbox, send, queued }
}

async function rootIds(team: Board) {
  const { messages } = await team.channel(channel).messages({ after: '0' })
  return messages.filter(({ re }) => re === null).map(({ id }) => id)
}

async function rejectedWith(team: Board, id: string, reason: string) {
  const { message, replies } = await team.thread(id)
  assert.equal(message.deleted, false)
  assert.equal(message.labels['swarm.state'], 'rejected')
  assert.deepEqual(replies.map(({ text }) => text.split(/[:\s]/, 1)[0]), [reason])
}

test('retry after a lost response does not post a second root', async (t) => {
  const { team, send } = await openBoard(t)
  const message = mail('lost-response')
  const lost = new Error('response lost after commit')
  const sender: Pick<Board, 'post'> = {
    async post(...args) {
      await team.post(...args)
      throw lost
    },
  }

  await assert.rejects(sendMail(sender, channel, message, { scope: 'core' }), (error) => error === lost)
  const [first] = await rootIds(team)
  assert.ok(first)
  assert.equal((await send(message)).id, first)
  assert.deepEqual(await rootIds(team), [first])
})

test('changed payload under the same sender id is not accepted as a retry', async (t) => {
  const { team, send } = await openBoard(t)
  const message = mail('collision')
  const root = await send(message)

  await assert.rejects(send({ ...message, body: 'Different findings.' }), { reason: 'id_collision' })
  assert.deepEqual(await rootIds(team), [root.id])
  assert.deepEqual((await team.thread(root.id)).message.blocks[0]?.data, message)
})

test('a failed post leaves no half message and retry lands one complete root', async (t) => {
  const message = mail('failed-post')
  let drop = true
  const { team, send } = await openBoard(t, {
    // Refuse the full payload, not a partial root a broken sender might stage first.
    middleware: [({ write, next }) => drop && write.text.includes(message.body) ? undefined : next()],
  })

  await assert.rejects(send(message), { code: 'dropped' })
  assert.deepEqual(await rootIds(team), [])
  drop = false
  const root = await send(message)
  assert.deepEqual(await rootIds(team), [root.id])
  assert.equal(root.blocks.length, 1)
  assert.deepEqual(root.blocks[0]?.data, message)
})

test('admit does not mislabel new mail or reopen handled mail on a rescan', async (t) => {
  const { team, inbox, send, queued } = await openBoard(t)
  const message = mail('admit', { class: 'core.escalate', urgency: 'p1' })
  const root = await send(message)
  assert.equal(root.labels['swarm.state'], undefined)

  await inbox.admit()
  const { labels } = (await team.thread(root.id)).message
  assert.equal(labels['swarm.class'], message.class)
  assert.equal(labels['swarm.urgency'], message.urgency)
  assert.equal(labels['swarm.state'], 'open')
  assert.deepEqual(await queued(), [root.id])

  assert.equal(await inbox.take(root.id), true)
  await inbox.admit()
  assert.equal((await team.thread(root.id)).message.labels['swarm.state'], 'handled')
  assert.deepEqual(await queued(), [])
})

test('concurrent admits do not open a duplicate or leave two rejection replies', async (t) => {
  const { team, inbox, send, queued } = await openBoard(t)
  const first = await send(mail('first', { ref: 'work' }))
  await inbox.admit()
  const repeat = await send(mail('repeat', { ref: 'work' }))
  const fresh = await send(mail('fresh'))

  await Promise.all([inbox.admit(), inbox.admit()])
  assert.deepEqual(new Set(await queued()), new Set([first.id, fresh.id]))
  await rejectedWith(team, repeat.id, 'duplicate')
})

test('dedupe rejects equal and older revisions without suppressing other tuples or the newer revision', async (t) => {
  const { team, inbox, send, queued } = await openBoard(t)
  const original = mail('original', { ref: 'work' })
  const first = await send(original)
  await inbox.admit()
  const equal = await send({ ...original, id: 'equal', at: '2026-11-20T22:14:00+01:00' })
  const older = await send({ ...original, id: 'older', at: '2026-11-20T21:13:59Z' })
  const otherSender = await send({ ...original, id: 'other-sender', from: 'attempt-121' })
  const otherRef = await send({ ...original, id: 'other-ref', ref: 'other-work' })
  const otherClass = await send({ ...original, id: 'other-class', class: 'sec.retry' })
  await inbox.admit()
  await rejectedWith(team, equal.id, 'duplicate')
  await rejectedWith(team, older.id, 'duplicate')
  const unrelated = [otherSender.id, otherRef.id, otherClass.id]
  assert.deepEqual(new Set(await queued()), new Set([first.id, ...unrelated]))

  const newer = await send({ ...original, id: 'newer', at: '2026-11-20T21:14:00.0001Z' })
  await inbox.admit()
  await rejectedWith(team, first.id, 'superseded')
  assert.deepEqual(new Set(await queued()), new Set([newer.id, ...unrelated]))
})

test('admit does not open or delete invalid roots and leaves a rejection reason', async (t) => {
  const { team, inbox, queued } = await openBoard(t)
  const cases = [
    ['invalid_block', 'Not a mail block.'],
    ['expiry_not_allowed', block(MAIL_SCHEMA, mail('p0', { urgency: 'p0', expires: at }))],
    ['expiry_not_allowed', block(MAIL_SCHEMA, mail('p1', { urgency: 'p1', expires: at }))],
    // The board schema accepts a time with no zone, but mail requires an instant.
    ['invalid_at', block(MAIL_SCHEMA, mail('bad-at', { at: '2026-11-20T21:14:00' }))],
    ['invalid_expires', block(MAIL_SCHEMA, mail('bad-expires', { expires: '2026-11-21T00:00:00' }))],
  ] as const
  const posted = []
  for (const [reason, text] of cases) {
    posted.push({ root: await team.post(channel, text), reason })
  }

  await inbox.admit()
  await inbox.admit()
  assert.deepEqual(await queued(), [])
  for (const { root, reason } of posted) await rejectedWith(team, root.id, reason)
})

test('send rejects oversized mail with too_large before a root lands', async (t) => {
  const { team, send } = await openBoard(t)
  // The board text limit is lower than the mail byte limit, so this cannot land for admission.
  await assert.rejects(send(mail('oversize', { body: '😀'.repeat(17_000) })), { reason: 'too_large' })
  assert.deepEqual(await rootIds(team), [])
})

test('readOpen does not bury or truncate p0 across pages even at limit one', async (t) => {
  const { inbox, send, queued } = await openBoard(t)
  const normal = await send(mail('normal', { urgency: 'p1' }))
  const first = await send(mail('first-p0', { urgency: 'p0' }))
  for (let i = 0; i < 100; i++) await send(mail(`filler-${i}`))
  const last = await send(mail('last-p0', { urgency: 'p0', at: '2026-11-20T21:15:00Z' }))
  await inbox.admit()

  assert.deepEqual(await queued(1), [first.id, last.id])
  assert.deepEqual(await queued(3), [first.id, last.id, normal.id])
})

test('readOpen expires due p2 and p3 without expiring old p0', async (t) => {
  const { team, inbox, send, queued } = await openBoard(t)
  const p2 = await send(mail('due-p2', { expires: now().toISOString() }))
  const p3 = await send(mail('past-p3', { urgency: 'p3', expires: at }))
  const p0 = await send(mail('old-p0', { urgency: 'p0', at: '2000-01-01T00:00:00Z' }))
  const future = await send(mail('future-p2', { expires: '2026-11-22T00:00:00Z' }))
  await inbox.admit()
  for (const root of [p2, p3]) {
    assert.equal((await team.thread(root.id)).message.labels['swarm.state'], 'open')
  }

  assert.deepEqual(await queued(), [p0.id, future.id])
  for (const root of [p2, p3]) {
    const { message } = await team.thread(root.id)
    assert.equal(message.labels['swarm.state'], 'expired')
    assert.equal(message.deleted, false)
  }
  assert.equal((await team.thread(p0.id)).message.labels['swarm.state'], 'open')
})

test('concurrent takes cannot both win or leave the winner in readOpen', async (t) => {
  const { team, inbox, send, queued } = await openBoard(t)
  const root = await send(mail('take'))
  await inbox.admit()
  assert.deepEqual(await queued(), [root.id])

  const results = await Promise.all([inbox.take(root.id), inbox.take(root.id)])
  assert.deepEqual(results.sort(), [false, true])
  assert.equal((await team.thread(root.id)).message.labels['swarm.state'], 'handled')
  assert.deepEqual(await queued(), [])
})

test('same sender id in separate scopes does not collapse onto one root', async (t) => {
  const { team, send } = await openBoard(t)
  const message = mail('shared-id')
  const core = await send(message, 'core')
  const spawner = await send(message, 'spawner')

  assert.notEqual(core.id, spawner.id)
  assert.deepEqual(new Set(await rootIds(team)), new Set([core.id, spawner.id]))
})
