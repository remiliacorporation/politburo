import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { board, HttpError, type Middleware } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createClaims, type ClaimsConfig, type Validate } from '../src/claims/service.ts'
import { defaultConfig } from '../src/config/load.ts'

const channel = 'work/acme-web'
const hour = 3_600_000
const idle = { renewed: 0, satisfied: 0, docked: 0, released: 0 }

function setup(t: TestContext, validate: Validate = async () => ({ result: 'invalid' }), middleware: Middleware[] = []) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, middleware })
  const config: ClaimsConfig = defaultConfig().claims
  let now = Date.now()
  let nextTime: number | undefined
  const clock = () => {
    if (nextTime !== undefined) {
      const time = nextTime
      nextTime = undefined
      queueMicrotask(() => { now = time })
    }
    return now
  }
  const service = (party = 'red') => createClaims({
    board: party === 'red' ? team : team.as(party, { can: ['read', 'post', 'label'] }),
    channel, party, config, validate, now: clock, leaseSeconds: 60,
  })
  return {
    team, config, service, at: (time: number, afterRead?: number) => { now = time; nextTime = afterRead },
    ticket: async (text = 'Work item') => (await team.tasks.create(channel, text)).task.id,
    state: async (id: string) => (await team.thread(id)).message.task!,
    docks: async (id: string) => (await team.thread(id)).replies.filter((reply) => reply.labels['swarm.kind'] === 'dock').length,
  }
}

test('a four-hour miss must release immediately and never double-dock on tick or restart', async (t) => {
  const { service, ticket, at, state, docks } = setup(t)
  const red = service()
  const id = await ticket()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  at(claim.hardEnd)
  assert.deepEqual(await red.tick(), { ...idle, docked: 1 })
  assert.equal((await state(id)).state, 'ready')
  assert.ok((await service('blue').claim(id)).ok)
  assert.equal(await docks(id), 1)
  assert.deepEqual(await red.tick(), idle)
  await service().recover()
  assert.equal(await docks(id), 1)
})

test('reclaim cooldown must refuse until exactly fifteen minutes after hard end', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { service, ticket, at } = setup(t)
  const red = service()
  const id = await ticket()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  // Recent-dock status compares board reply timestamps with the service clock.
  t.mock.timers.tick(claim.hardEnd - Date.now())
  at(claim.hardEnd)
  await red.tick()
  const retryAt = claim.hardEnd + 15 * 60_000
  const refused = { ok: false, code: 'reclaim_cooldown', retryAt }
  assert.deepEqual(await red.claim(id), refused)
  assert.deepEqual(await red.status(), [{ task: id, party: 'red', state: 'cooling', cooldownUntil: retryAt }])
  at(retryAt - 1)
  assert.deepEqual(await red.claim(id), refused)
  at(retryAt)
  assert.ok((await red.claim(id)).ok)
})

test('even a valid outcome must not save a check starting at hard end', async (t) => {
  const { service, ticket, at, state, docks } = setup(t, async () => ({ result: 'valid' }))
  const red = service()
  const id = await ticket()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  // Start the tick before the cutoff, then cross it while the board renews the lease.
  at(claim.hardEnd - 1, claim.hardEnd)
  assert.equal((await red.tick()).docked, 1)
  assert.equal((await state(id)).state, 'ready')
  assert.equal(await docks(id), 1)
})

test('a valid answer arriving at hard end must release and dock, not satisfy', async (t) => {
  let deadline = 0
  const { service, ticket, at, state, docks } = setup(t, async () => {
    at(deadline)
    return { result: 'valid' }
  })
  const red = service()
  const id = await ticket()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  deadline = claim.hardEnd
  at(deadline - 1)
  assert.deepEqual(await red.tick(), { ...idle, renewed: 1, docked: 1 })
  assert.equal((await state(id)).state, 'ready')
  assert.equal(await docks(id), 1)
})

test('neither the service clock nor repeated renewals may set or move the board-derived hard end', async (t) => {
  const { service, ticket, at, state } = setup(t)
  at(Date.now() - hour)
  const red = service()
  const id = await ticket()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  const boardStart = Date.parse((await state(id)).claim!.until) - 60_000
  assert.equal(claim.claimedAt, boardStart)
  assert.equal(claim.hardEnd, boardStart + 4 * hour)
  for (const elapsed of [hour, 2 * hour, 3 * hour, 4 * hour - 1000]) {
    at(boardStart + elapsed)
    assert.deepEqual(await red.tick(), { ...idle, renewed: 1 })
    assert.equal((await state(id)).state, 'claimed')
  }
  at(claim.hardEnd)
  assert.deepEqual(await red.tick(), { ...idle, docked: 1 })
  assert.equal((await state(id)).state, 'ready')
})

test('a validated outcome must hold for review and stop renewal, release and docking', async (t) => {
  const { service, ticket, at, state, docks } = setup(t, async () => ({ result: 'valid' }))
  const red = service()
  const id = await ticket()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  at(claim.claimedAt + hour)
  assert.equal((await red.tick()).satisfied, 1)
  assert.equal((await state(id)).blocked?.kind, 'review')
  assert.deepEqual(await service('blue').claim(id), { ok: false, code: 'task_blocked' })
  at(claim.claimedAt + 5 * hour)
  assert.deepEqual(await red.tick(), idle)
  assert.equal((await state(id)).blocked?.kind, 'review')
  assert.equal(await docks(id), 0)
})

test('losing a short lease before hard end must not dock or delay reclaim', async (t) => {
  const { team, service, ticket, at, state, docks } = setup(t)
  const red = service()
  const id = await ticket()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  const expired = Date.parse((await state(id)).claim!.until) + 1
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  try {
    Date.now = () => expired
    at(expired)
    const ready = await team.tasks.list({ channel, state: 'ready' })
    assert.ok(ready.tasks.some(({ message }) => message.id === id))
    assert.deepEqual(await red.tick(), { ...idle, released: 1 })
    assert.equal(await docks(id), 0)
    assert.ok((await red.claim(id)).ok)
  } finally {
    Date.now = realNow
  }
})

test('a validator failure must not prevent a later claim from missing in the same tick', async (t) => {
  let deadline = 0
  const failure = new Error('validator unavailable')
  const { config, service, ticket, at, state, docks } = setup(t, async () => {
    at(deadline)
    throw failure
  })
  config.uncommitted_claims_per_repo = 2
  const red = service()
  const broken = await red.claim(await ticket('Validator fails here'))
  const missed = await ticket('Must still miss')
  const claim = await red.claim(missed)
  assert.ok(broken.ok && claim.ok)
  deadline = claim.hardEnd
  at(broken.hardEnd - 1000)
  await assert.rejects(red.tick(), (error) => error instanceof AggregateError && error.errors.includes(failure))
  assert.equal((await state(missed)).state, 'ready')
  assert.equal(await docks(missed), 1)
})

test('construction must reject pausing the clock on downtime', (t) => {
  const { service, config } = setup(t)
  config.pause_on_downtime = true
  assert.throws(() => service(), /pause_on_downtime/)
})

test('recovery must dock an overdue claim abandoned by a crashed service exactly once', async (t) => {
  let interrupt = true
  const { team, service, ticket, at, docks } = setup(t, undefined, [async ({ write, next }) => {
    await next()
    if (interrupt && write.kind === 'post' && write.labels['swarm.kind'] === 'dock') {
      interrupt = false
      throw new HttpError(503, 'interrupted', 'interrupted after posting dock')
    }
  }])
  const id = await ticket()
  const claim = await service().claim(id)
  assert.ok(claim.ok)
  t.mock.method(Date, 'now', () => claim.hardEnd + 1)
  at(Date.now())
  const { tasks } = await team.tasks.list({ channel, state: 'ready' })
  assert.ok(tasks.some(({ message }) => message.id === id))
  await assert.rejects(service().recover(), /interrupted after posting dock/)
  assert.equal(await docks(id), 1)
  await service().recover()
  assert.equal(await docks(id), 1)
})

test('first claim after restart must recover the miss before allowing reclaim', async (t) => {
  const { service, ticket, at, docks } = setup(t)
  const id = await ticket()
  const claim = await service().claim(id)
  assert.ok(claim.ok)
  const afterEnd = claim.hardEnd + 60_000
  t.mock.method(Date, 'now', () => afterEnd)
  at(afterEnd)
  assert.equal(await docks(id), 0)
  assert.deepEqual(await service().claim(id), {
    ok: false, code: 'reclaim_cooldown', retryAt: claim.hardEnd + 15 * 60_000,
  })
  assert.equal(await docks(id), 1)
})

async function interruptedSatisfaction(t: TestContext) {
  const fixture = setup(t, async () => ({ result: 'valid' }), [async ({ write, next }) => {
    await next()
    if (write.kind === 'post' && write.labels['swarm.kind'] === 'satisfied') {
      throw new HttpError(503, 'interrupted', 'interrupted after recording satisfaction')
    }
  }])
  const { ticket, service, state, at } = fixture
  // The red service actor also creates the task; recovery has no claim proof for an owner-only block.
  const id = await ticket()
  const red = service()
  const claim = await red.claim(id)
  assert.ok(claim.ok)
  at(claim.claimedAt + 1)
  await assert.rejects(red.tick(), (error) => error instanceof AggregateError && error.errors[0]?.code === 'interrupted')
  const expired = Date.parse((await state(id)).claim!.until) + 1
  return { ...fixture, id, expire: () => {
    t.mock.method(Date, 'now', () => expired)
    at(expired)
  } }
}

test('recovery must restore the review hold after satisfaction was recorded and the lease elapsed', async (t) => {
  const { team, service, id, expire, state } = await interruptedSatisfaction(t)
  expire()
  const { tasks } = await team.tasks.list({ channel, state: 'ready' })
  assert.ok(tasks.some(({ message }) => message.id === id))
  const red = service()
  await red.recover()
  assert.equal((await state(id)).blocked?.kind, 'review')
  assert.deepEqual(await service('blue').claim(id), { ok: false, code: 'task_blocked' })
  await team.tasks.unblock(id)
  await red.recover()
  assert.ok((await service('blue').claim(id)).ok)
})

test('a live lease must leave a recorded satisfaction pending for a later tick', async (t) => {
  const { service, id, expire } = await interruptedSatisfaction(t)
  const red = service()
  await red.recover()
  assert.deepEqual(await service('blue').claim(id), { ok: false, code: 'task_claimed' })
  expire()
  await red.tick()
  assert.deepEqual(await service('blue').claim(id), { ok: false, code: 'task_blocked' })
})
