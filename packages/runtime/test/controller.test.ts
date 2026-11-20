import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { runController, type ControllerBoard, type ControllerClock, type ControllerMessage, type ControllerOptions } from '../src/controller/index.ts'

// Drain promise continuations without advancing virtual time.
const drain = () => new Promise<void>((resolve) => process.nextTick(resolve))

function fakeClock() {
  let time = 0
  const sleepers = new Set<{ at: number; wake(): void }>()
  const clock: ControllerClock = {
    now: () => time,
    sleep(ms, signal) {
      signal.throwIfAborted()
      return new Promise<void>((resolve, reject) => {
        const job = { at: time + ms, wake: () => { cleanup(); resolve() } }
        const abort = () => { cleanup(); reject(signal.reason) }
        const cleanup = () => { sleepers.delete(job); signal.removeEventListener('abort', abort) }
        sleepers.add(job)
        signal.addEventListener('abort', abort, { once: true })
      })
    },
  }
  return {
    clock,
    async advance(ms: number) {
      const end = time + ms
      await drain()
      while (true) {
        const next = Math.min(...Array.from(sleepers, ({ at }) => at))
        if (next > end) break
        time = next
        for (const job of sleepers) if (job.at === next) job.wake()
        await drain()
      }
      time = end
    },
  }
}

const agent = 'worker'
const direct = { agent }
const sender = { actor: 'dispatcher+shipping', principal: 'dispatcher', profile: 'shipping' }
const parent = 'lead'

function fixture(t: TestContext, options: { ackTimeoutMs?: number; wake?: ControllerOptions['wake']; parentOf?: ControllerOptions['registry']['parentOf'] } = {}) {
  const { clock, advance } = fakeClock()
  const stop = new AbortController()
  const messages = new Map<string, ControllerMessage>()
  const woken: ControllerMessage[] = []
  const receipts: [string, 'seen' | 'acted'][] = []
  const sent: ControllerMessage[] = []
  const polls: { at: number; wait: number; after?: string }[] = []
  const lookups: string[] = []
  let activePoll: AbortController | undefined
  let eager = false
  const iso = () => new Date(Date.UTC(2026, 0, 1) + clock.now()).toISOString()
  function mail(id: string, to: ControllerMessage['to'] = direct, fields: Partial<ControllerMessage> = {}) {
    const message = {
      id, to, topic: 'handoff', text: 'A private note for the recipient.', by: sender,
      sentAt: iso(), expiresAt: null, archivedAt: null, seenAt: null, actedAt: null, ...fields,
    }
    messages.set(id, message)
    return message
  }
  const board: ControllerBoard = {
    async poll({ wait, after }, signal) {
      assert.equal(activePoll, undefined, 'the feed does not accept overlapping requests')
      polls.push({ at: clock.now(), wait, after })
      assert.ok(polls.length <= 12, 'unexpected polling burst')
      if (!eager) {
        const pulse = activePoll = new AbortController()
        try {
          await clock.sleep(wait * 1_000, AbortSignal.any([pulse.signal, signal]))
        } catch (error) {
          if (!pulse.signal.aborted) throw error
        } finally {
          activePoll = undefined
        }
      }
      // An inbox change need not carry private events on the generic feed.
      return { cursor: `page-${polls.length}` }
    },
    operationalInbox: {
      async read() { return { messages: structuredClone([...messages.values()]) } },
      async ack(id, status) {
        receipts.push([id, status])
        const message = messages.get(id)!
        const next = { ...message, seenAt: message.seenAt ?? iso(), actedAt: status === 'acted' ? (message.actedAt ?? iso()) : message.actedAt }
        messages.set(id, next)
        return { message: structuredClone(next) }
      },
      async send(input) {
        assert.ok(!('by' in input) && !('sentAt' in input), 'provenance is assigned by the board')
        const message = mail(`sent-${sent.length}`, input.to, { topic: input.topic, text: input.text, by: { actor: agent, principal: agent, profile: null } })
        sent.push(message)
        return { message }
      },
    },
  }
  const done = runController({
    board, clock, agent, roles: ['reviewer'], longPollSeconds: 1, signal: stop.signal,
    ackTimeoutMs: options.ackTimeoutMs ?? 1_200,
    registry: {
      parentOf(id) {
        lookups.push(id)
        if (options.parentOf) return options.parentOf(id)
        return id === agent ? parent : id === parent ? 'coordinator' : null
      },
    },
    wake(message, signal) {
      woken.push(message)
      return options.wake?.(message, signal)
    },
  })
  // Surface any failure even if a test exits early.
  void done.catch(() => {})
  t.after(async () => { stop.abort(); await done })
  return {
    advance, mail, woken, messages, receipts, sent, polls, lookups, board,
    pulse: () => activePoll?.abort(),
    eagerPages: () => { eager = true; activePoll?.abort() },
    close: async () => { stop.abort(); await done },
  }
}

test('wakes once per inbox message across feed pages, even while a handler is busy', async (t) => {
  const handler = Promise.withResolvers<void>()
  const f = fixture(t, { wake: () => handler.promise })
  f.mail('first')
  await f.advance(0)
  assert.deepEqual(f.woken, [], 'waits for the feed')
  f.pulse()
  await f.advance(0)
  assert.deepEqual(f.woken.map(({ id }) => id), ['first'])
  f.mail('second')
  await f.advance(2_000)
  // The inbox still includes the first message. It must not wake again.
  assert.deepEqual(f.woken.map(({ id }) => id), ['first', 'second'])
  handler.resolve()
})

test('records seen before the wake and acted only on handler completion', async (t) => {
  const handler = Promise.withResolvers<'acted'>()
  const f = fixture(t, { wake: () => handler.promise })
  const mail = f.mail('review')
  f.pulse()
  await f.advance(0)
  assert.equal(f.woken.length, 1)
  assert.deepEqual(f.woken[0], { ...mail, seenAt: f.messages.get(mail.id)!.seenAt })
  assert.notEqual(f.woken[0]!.seenAt, null)
  assert.deepEqual(f.receipts, [[mail.id, 'seen']])
  assert.equal(f.messages.get(mail.id)!.actedAt, null)
  handler.resolve('acted')
  await f.advance(0)
  assert.deepEqual(f.receipts, [[mail.id, 'seen'], [mail.id, 'acted']])
  assert.notEqual(f.messages.get(mail.id)!.actedAt, null)
})

test('escalates an unacted message once, at its deadline, only to the immediate parent', async (t) => {
  const f = fixture(t)
  const mail = f.mail('review', direct, { text: 'Forward me to the coordinator.' })
  f.pulse()
  await f.advance(1_199)
  assert.equal(f.sent.length, 0)
  await f.advance(1)
  assert.deepEqual(f.sent.map(({ to }) => to), [{ agent: parent }])
  assert.ok(f.sent[0]!.text.includes(mail.id))
  assert.ok(!f.sent[0]!.text.includes(mail.text))
  assert.deepEqual(f.lookups, [agent])
  await f.advance(5_000)
  assert.equal(f.sent.length, 1)
})

test('an acted receipt from the handler cancels escalation', async (t) => {
  const handler = Promise.withResolvers<'acted'>()
  const f = fixture(t, { wake: () => handler.promise })
  f.mail('review')
  f.pulse()
  await f.advance(1_199)
  handler.resolve('acted')
  await f.advance(2_000)
  assert.notEqual(f.messages.get('review')!.actedAt, null)
  assert.deepEqual(f.lookups, [], 'no escalation lookup after acknowledged completion')
  assert.deepEqual(f.sent, [])
})

test('an acted receipt written elsewhere suppresses escalation without a new feed page', async (t) => {
  const parentLookup = Promise.withResolvers<string>()
  const f = fixture(t, { parentOf: () => parentLookup.promise })
  f.mail('review')
  f.pulse()
  await f.advance(1_200)
  await f.board.operationalInbox.ack('review', 'acted')
  parentLookup.resolve(parent)
  await f.advance(0)
  assert.deepEqual(f.sent, [])
})

test('matches exact configured roles and direct addresses, not message text', async (t) => {
  const f = fixture(t)
  f.mail('for-reviewers', { role: 'reviewer' })
  f.mail('for-qa', { role: 'qa' }, { text: 'reviewer worker' })
  f.mail('another-agent', { agent: 'reviewer' })
  f.mail('direct')
  f.pulse()
  await f.advance(0)
  assert.deepEqual(f.woken.map(({ id }) => id).sort(), ['direct', 'for-reviewers'])
  assert.deepEqual(f.receipts.map(([id]) => id).sort(), ['direct', 'for-reviewers'])
})

test('long-polls serially with the feed cursor and paces even pages that answer immediately', async (t) => {
  const f = fixture(t)
  f.eagerPages()
  await f.advance(3_200)
  assert.deepEqual(f.polls, [
    { at: 0, wait: 1, after: undefined },
    { at: 1_000, wait: 1, after: 'page-1' },
    { at: 2_000, wait: 1, after: 'page-2' },
    { at: 3_000, wait: 1, after: 'page-3' },
  ])
})

test('stopping the loop cancels pending escalation and ignores late handler completions', async (t) => {
  const handler = Promise.withResolvers<'acted'>()
  const f = fixture(t, { wake: () => handler.promise })
  f.mail('review')
  f.pulse()
  await f.advance(1_000)
  assert.equal(f.woken.length, 1)
  await f.close()
  handler.resolve('acted')
  await f.advance(2_000)
  assert.deepEqual(f.receipts, [['review', 'seen']])
  assert.deepEqual(f.lookups, [])
  assert.deepEqual(f.sent, [])
})
