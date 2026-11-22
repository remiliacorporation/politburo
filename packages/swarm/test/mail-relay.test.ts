import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { block, board, type Board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createInbox, createRelay, MAIL_SCHEMA, registerMailSchema, sendMail, type MailMessage } from '../src/mail/index.ts'

const outbox = 'outbox'
const channel = 'inbox'
const now = () => new Date('2026-11-21T00:00:00Z')
const state = 'swarm.state'
const delivery = 'swarm.delivery'

function mail(id: string, fields: Partial<MailMessage> = {}): MailMessage {
  return {
    id, class: 'sec.push', urgency: 'p2', from: 'attempt-120', ref: id,
    summary: 'Review ready', body: 'See the findings on the work item.', at: '2026-11-20T21:14:00Z',
    to: 'B/inbox', ...fields,
  }
}

async function openBoard(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  await registerMailSchema(team)
  return team
}

async function setup(t: TestContext) {
  const a = await openBoard(t)
  const b = await openBoard(t)
  const sender = a.as('sender', { can: { [outbox]: ['post'] } })
  const source = a.as('relay')
  const destination = b.as('relay')
  const send = (message: MailMessage) => sendMail(sender, outbox, message, { scope: 'A' })
  const relay = (boards: Record<string, Board> = { B: destination }, handle = source) =>
    createRelay({ source: { name: 'A', board: handle, outbox }, boards, now })
  const inbox = createInbox({ board: b, channel, now })
  return { a, b, sender, source, destination, send, relay, inbox }
}

async function roots(team: Board) {
  const { messages } = await team.channel(channel).messages({ after: '0' })
  return messages.filter(({ re }) => re === null)
}

async function rejectedWith(team: Board, id: string, reason: string) {
  const { message, replies } = await team.thread(id)
  assert.equal(message.deleted, false)
  assert.equal(message.labels[state], 'rejected')
  assert.deepEqual(replies.map(({ text }) => text), [reason])
}

async function forwardedTo(a: Board, sourceId: string, destinationId: string, name = 'B') {
  const { message, replies } = await a.thread(sourceId)
  assert.equal(message.labels[state], 'forwarded')
  assert.deepEqual(replies.map(({ text }) => text), [`delivered to ${name}/${channel}: ${destinationId}`])
}

for (const [step, cut] of ['after destination post', 'after receipt reply', 'before forwarded label'].entries()) {
  test(`restart ${cut} does not lose or duplicate delivery`, async (t) => {
    const { a, b, send, source, destination, relay, inbox } = await setup(t)
    const message = mail(`restart-${step}`)
    const root = await send(message)
    const killed = new Error(`relay killed ${cut}`)
    const interrupted = relay({ B: {
      ...destination,
      async post(...args) {
        const landed = await destination.post(...args)
        if (step === 0) throw killed
        return landed
      },
    } }, {
      ...source,
      async reply(...args) {
        const landed = await source.reply(...args)
        if (step === 1) throw killed
        return landed
      },
      async label(...args) {
        if (step === 2) throw killed
        return source.label(...args)
      },
    })
    // A failed destination call is reported as down; failures on the source reject the pass.
    if (step === 0) assert.deepEqual((await interrupted.deliverOnce()).down, ['B'])
    else await assert.rejects(interrupted.deliverOnce(), (error) => error === killed)

    const [landed, ...duplicates] = await roots(b)
    assert.ok(landed)
    assert.deepEqual(duplicates, [])
    const before = await a.thread(root.id)
    const receipt = `delivered to B/${channel}: ${landed.id}`
    assert.deepEqual(before.replies.map(({ text }) => text), step === 0 ? [] : [receipt])
    assert.equal(before.message.labels[state], undefined)

    const restarted = relay()
    await restarted.deliverOnce()
    assert.deepEqual((await roots(b)).map(({ id }) => id), [landed.id])
    await inbox.admit()
    assert.deepEqual(await inbox.readOpen({ limit: 10 }), [{ messageId: landed.id, message }])
    await forwardedTo(a, root.id, landed.id)
    const after = await a.thread(root.id)
    if (step !== 0) assert.equal(after.replies[0]?.id, before.replies[0]?.id)
    const delivered = await roots(b)
    assert.deepEqual(await restarted.deliverOnce(), { delivered: 0, rejected: 0, pending: 0, down: [] })
    assert.deepEqual(await roots(b), delivered)
    assert.deepEqual(await a.thread(root.id), after)
  })
}

test('racing relays do not leave duplicate roots or receipts', { timeout: 5000 }, async (t) => {
  const { a, b, send, destination, relay } = await setup(t)
  const root = await send(mail('race'))
  const both = Promise.withResolvers<void>()
  let arrived = false
  const racing: Board = {
    ...destination,
    async post(...args) {
      // Both relays must see the source pending before either destination write can land.
      if (arrived) both.resolve()
      arrived = true
      await both.promise
      return destination.post(...args)
    },
  }
  await Promise.all([relay({ B: racing }).deliverOnce(), relay({ B: racing }).deliverOnce()])
  const landed = await roots(b)
  assert.equal(landed.length, 1)
  await forwardedTo(a, root.id, landed[0]!.id)
})

function offline(): Board {
  return new Proxy({} as Board, {
    get() {
      return () => { throw new Error('board B is down') }
    },
  })
}

test('a down board is reported without blocking another board or losing mail', async (t) => {
  const { a, b, send, destination, relay } = await setup(t)
  const c = await openBoard(t)
  const forB = await send(mail('for-b'))
  const forC = await send(mail('for-c', { to: 'C/inbox' }))
  const boards = { B: offline(), C: c.as('relay') }
  const service = relay(boards)
  assert.deepEqual((await service.deliverOnce()).down, ['B'])
  const onC = await roots(c)
  assert.equal(onC.length, 1)
  await forwardedTo(a, forC.id, onC[0]!.id, 'C')
  assert.deepEqual(await roots(b), [])
  const pending = await a.thread(forB.id)
  assert.equal(pending.message.labels[state], undefined)
  assert.deepEqual(pending.replies, [])

  boards.B = destination
  await service.deliverOnce()
  const onB = await roots(b)
  assert.equal(onB.length, 1)
  await forwardedTo(a, forB.id, onB[0]!.id)
  assert.deepEqual(await roots(c), onC)
  await forwardedTo(a, forC.id, onC[0]!.id, 'C')
})

test('p0 survives a destination outage and is not delivered behind p1 through p3', async (t) => {
  const { a, b, send, destination, relay } = await setup(t)
  for (const urgency of ['p1', 'p2', 'p3'] as const) await send(mail(urgency, { urgency }))
  const urgent = await send(mail('p0', { urgency: 'p0' }))
  const boards = { B: offline() }
  const service = relay(boards)
  assert.equal((await service.deliverOnce()).pending, 4)
  const pending = await a.thread(urgent.id)
  assert.equal(pending.message.labels[state], undefined)
  assert.deepEqual(pending.replies, [])

  boards.B = destination
  await service.deliverOnce()
  const [first, ...rest] = await roots(b)
  assert.equal(first?.blocks[0]?.data.id, 'p0')
  assert.deepEqual(rest.map((root) => root.blocks[0]?.data.id).sort(), ['p1', 'p2', 'p3'])
  await forwardedTo(a, urgent.id, first!.id)
})

test('bad addresses are rejected with a durable reason instead of retried or deleted', async (t) => {
  const { a, b, sender, send, relay } = await setup(t)
  const { to: _to, ...unaddressed } = mail('no-address')
  const missing = await send(unaddressed)
  const malformed = await sender.post(outbox, {
    id: 'mail:A:bad-address', text: block(MAIL_SCHEMA, mail('bad-address', { to: 'B' })),
  })
  const unknown = await send(mail('unknown-board', { to: 'unknown/inbox' }))
  const service = relay()
  assert.equal((await service.deliverOnce()).rejected, 3)
  assert.deepEqual(await service.deliverOnce(), { delivered: 0, rejected: 0, pending: 0, down: [] })
  await rejectedWith(a, missing.id, 'missing_to')
  await rejectedWith(a, malformed.id, 'invalid_to')
  await rejectedWith(a, unknown.id, 'unknown_board')
  assert.deepEqual(await roots(b), [])
})

test('a different payload already landed under the sender id is not acknowledged as delivered', async (t) => {
  const { a, b, send, destination, relay } = await setup(t)
  const message = mail('collision')
  const original = { ...message, body: 'Already on the destination.' }
  const previous = await sendMail(destination, channel, original, { scope: 'A' })
  const source = await send(message)

  await relay().deliverOnce()
  await rejectedWith(a, source.id, 'id_collision')
  const landed = await roots(b)
  assert.deepEqual(landed.map(({ id }) => id), [previous.id])
  assert.deepEqual(landed[0]!.blocks[0]?.data, original)
})

test('post-only mail cannot impersonate relay delivery and is still admitted as sender mail', async (t) => {
  const { b, send, relay, inbox } = await setup(t)
  const sender = b.as('direct-sender', { can: { [channel]: ['post'] } })
  const { to: _to, ...direct } = mail('direct')
  const message = mail('relayed')
  const source = await send(message)
  const provenance = `A:${source.id}`
  await assert.rejects(sender.post(channel, {
    id: 'mail:direct:direct', text: block(MAIL_SCHEMA, direct), labels: { [delivery]: provenance },
  }), { status: 403 })
  const directRoot = await sendMail(sender, channel, direct, { scope: 'direct' })

  await relay().deliverOnce()
  await inbox.admit()
  const open = await inbox.readOpen({ limit: 10 })
  assert.equal(open.length, 2)
  assert.deepEqual(open.find(({ messageId }) => messageId === directRoot.id)?.message, direct)
  assert.equal((await b.thread(directRoot.id)).message.labels[delivery], undefined)
  const copy = open.find(({ message: entry }) => entry.id === message.id)
  assert.ok(copy)
  assert.equal((await b.thread(copy.messageId)).message.labels[delivery], provenance)
})
