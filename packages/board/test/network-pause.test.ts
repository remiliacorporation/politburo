import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { local } from '../src/backend-local/index.ts'
import { boardContract, schemasContract, SCHEMAS_SESSION, workSettingsContract } from '../src/contract/contract.ts'
import { BOARD_SESSION } from '../src/contract/events.ts'
import { memory } from '../src/store/memory.ts'
import { ddl } from '../src/store/sql.ts'
import { sqlite } from '../src/store/sqlite.ts'
import type { BoardStore } from '../src/store/types.ts'
import { board, BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, testAuth, testBoard } from './harness.ts'
import { backgroundWork, fakeQueue } from './queue.ts'

type Call = ReturnType<typeof caller>
type AuditEvent = { type: string; payload: { id?: string } }
const pausedError = { status: 409, body: { error: { code: 'board_paused' } } }
const lostClaim = { status: 409, body: { error: { code: 'claim_lost' } } }
const control = (paused: boolean, pauseEpoch: number) => ({ status: 200, body: { paused, pauseEpoch } })
const events = async (call: Call) => (await call('GET', '/events?after=0&all=1')).body.events as AuditEvent[]
const makeTask = async (call: Call, text: string) => {
  const { status, body } = await call('POST', '/tasks', { channel: 'work', text })
  expect(status).toBe(201)
  return body.task.id as string
}

/** Delay one database operation to choose the interleaving without changing any board decisions. */
function hold() {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let arrived = false
  return {
    arrived: () => arrived,
    release: () => released.resolve(),
    async stop() {
      arrived = true
      reached.resolve()
      await released.promise
    },
    reached: reached.promise,
  }
}

function expectConflict(result: Awaited<ReturnType<Call>>, error: typeof pausedError) {
  // A bad board may grant a claim; don't print its response (it contains the claim credential).
  expect({ status: result.status, code: result.body.error?.code }).toEqual({ status: error.status, code: error.body.error.code })
}

const boardLog = `${boardContract.name}\u001f${BOARD_SESSION}`
const schemasLog = `${schemasContract.name}\u001f${SCHEMAS_SESSION}`
const settingsLog = `${workSettingsContract.name}\u001fwork-settings`

async function replaySession(from: BoardStore, to: BoardStore, session: string) {
  const events = await from.log.read(session)
  await to.log.append(session, events.map(({ id, type, payload }) => ({ id, type, payload })))
}

describe('network pause', () => {
  it('defaults to running, honors the fresh-board option, and audits only actual transitions as their author', async () => {
    const defaultBoard = testBoard()
    expect(await defaultBoard.status()).toEqual({ paused: false, pauseEpoch: 0 })
    const team = testBoard({ initiallyPaused: true })
    const token = await personToken('u_ada')
    const ada = caller(team.fetch, token)
    expect(await ada('GET', '/control')).toEqual(control(true, 0))
    expect(await ada('POST', '/control/pause', { reason: 'already paused' })).toEqual(control(true, 0))
    expect(await ada('POST', '/control/resume', { reason: 'ready to work' })).toEqual(control(false, 0))
    const change = await ada('POST', '/control/pause', { reason: 'check prod' })
    expect(change).toEqual(control(true, 1))
    expect(await ada('POST', '/control/pause', { reason: 'still paused' })).toEqual(control(true, 1))
    expect(await ada('POST', '/control/resume', { reason: 'all clear' })).toEqual(control(false, 1))
    expect(await ada('POST', '/control/resume', { reason: 'still running' })).toEqual(control(false, 1))
    expect(await ada('GET', '/control')).toEqual(control(false, 1))
    const by = { actor: 'vercel:user:u_ada', principal: 'vercel:user:u_ada', profile: null }
    expect((await events(ada)).filter((event) => event.type === 'work.control')).toMatchObject([
      { payload: { paused: true, pauseEpoch: 0, by: { actor: 'board:control', profile: null } } },
      { payload: { paused: false, pauseEpoch: 0, reason: 'ready to work', by } },
      { payload: { paused: true, pauseEpoch: 1, reason: 'check prod', by } },
      { payload: { paused: false, pauseEpoch: 1, reason: 'all clear', by } },
    ])
  })

  it('lets only a verified person with global manage pause or resume, never that person’s agent profile', async () => {
    const team = testBoard()
    const token = await personToken('u_ada')
    const ada = caller(team.fetch, token)
    const denied = [
      caller(team.fetch, token, { 'x-board-profile': 'agent' }),
      caller(team.fetch, token, { 'x-board-can': 'work=all' }),
      caller(team.fetch, await deploymentToken('board', PROJECT_ID)),
    ]
    for (const actor of denied) {
      expect(await actor('GET', '/control')).toEqual(control(false, 0))
      expect((await actor('POST', '/control/pause', { reason: 'not an operator' })).status).toBe(403)
    }
    // Profile and author come from the verified caller, not from a body supplied by the caller.
    expect((await ada('POST', '/control/pause', { reason: 'forged author', by: { actor: 'other' } })).status).toBe(400)
    expect((await ada('POST', '/control/pause', { reason: '   ' })).status).toBe(400)
    expect((await caller(team.fetch, 'invalid-fixture-jwt')('POST', '/control/pause', { reason: 'not verified' })).status).toBe(401)
    expect((await caller(team.fetch, 'invalid-fixture-jwt')('GET', '/control')).status).toBe(401)
    await expect(team.pause('board code is not a person')).rejects.toMatchObject({ status: 403 })
    expect(await ada('POST', '/control/pause', { reason: 'operator pauses' })).toEqual(control(true, 1))
    for (const actor of denied) expect((await actor('POST', '/control/resume', { reason: 'not an operator' })).status).toBe(403)
    expect(await ada('GET', '/control')).toEqual(control(true, 1))
    expect((await events(ada)).filter((event) => event.type === 'work.control')).toMatchObject([{ payload: { reason: 'operator pauses' } }])
  })

  it('keeps an explicit pause and resume across SQLite reopen, regardless of the option on the new handle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'board-pause-'))
    const token = await personToken()
    const open = async (initiallyPaused: boolean, fn: (call: Call) => Promise<void>) => {
      const work = backgroundWork()
      const backend = local({ dir })
      try {
        const team = board({ backend, url: BOARD_URL, initiallyPaused, authenticate: oidcTokens(testAuth) })
        await fn(caller(team.fetch, token))
      } finally {
        await work.settled()
        work.stop()
        await backend.close()
      }
    }
    try {
      await open(false, async (call) => {
        await makeTask(call, 'persisted work')
      })
      await open(true, async (call) => {
        expect(await call('GET', '/control')).toEqual(control(false, 0))
        expect(await call('POST', '/control/pause', { reason: 'maintenance' })).toEqual(control(true, 1))
      })
      await open(false, async (call) => {
        expect(await call('GET', '/control')).toEqual(control(true, 1))
        expectConflict(await call('POST', '/tasks/claim', { channel: 'work' }), pausedError)
        expect(await call('POST', '/control/resume', { reason: 'maintenance finished' })).toEqual(control(false, 1))
      })
      await open(true, async (call) => {
        expect(await call('GET', '/control')).toEqual(control(false, 1))
        expect((await call('POST', '/tasks/claim', { channel: 'work' })).body.task?.text).toBe('persisted work')
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each(['messages', 'schemas'] as const)('starts running on a replay of legacy %s despite the paused boot option', async (history) => {
    const source = testBoard()
    if (history === 'messages') {
      await source.post('work', 'written before network pause')
    } else {
      const call = caller(source.fetch, await personToken())
      expect((await call('POST', '/schemas', { name: 'work-item', version: 1, schema: { type: 'object' } })).status).toBe(200)
    }
    // Copy the legacy history without initialization or any SQLite metadata.
    const store = memory()
    await replaySession(source.store, store, history === 'messages' ? boardLog : schemasLog)
    expect(await testBoard({ store, initiallyPaused: true }).status()).toEqual({ paused: false, pauseEpoch: 0 })
  })

  it('starts paused with an empty log and restores that decision from the log alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'board-pause-replay-'))
    try {
      // The read tables exist, but the board has never written a log event.
      const path = join(dir, 'local.db')
      const db = new DatabaseSync(path)
      try {
        db.exec(ddl().join(';\n'))
      } finally {
        db.close()
      }
      const store = sqlite({ path })
      try {
        const paused = { paused: true, pauseEpoch: 0 }
        expect(await testBoard({ store, initiallyPaused: true }).status()).toEqual(paused)

        const replay = memory()
        await replaySession(store, replay, settingsLog)
        await replaySession(store, replay, boardLog)
        expect(await testBoard({ store: replay, initiallyPaused: false }).status()).toEqual(paused)

        // A restart can happen after recording the decision but before the first control event.
        const interrupted = memory()
        await replaySession(store, interrupted, settingsLog)
        expect(await testBoard({ store: interrupted, initiallyPaused: false }).status()).toEqual(paused)
      } finally {
        await store.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops every new claim, fences old leases, and leaves reads and human writes open', async () => {
    const team = testBoard()
    const ada = caller(team.fetch, await personToken('u_ada'))
    const agent = caller(team.fetch, await personToken('u_ada'), { 'x-board-profile': 'worker' })
    const already = await makeTask(ada, 'claimed before the pause')
    const claimToken = 'a'.repeat(43)
    const old = await agent('POST', `/tasks/${already}/claim`, { token: claimToken })
    expect(old.status).toBe(200)
    const proof = { epoch: old.body.claim.epoch, token: old.body.claim.token }
    const createWithClaim = { channel: 'work', text: 'created and claimed before pause', id: 'start-once', claim: true }
    const created = await agent('POST', '/tasks', createWithClaim)
    expect(created.status).toBe(201)
    const createdId = created.body.task.id
    await ada('POST', '/control/pause', { reason: 'hold new work' })
    const ready = await makeTask(ada, 'queued during pause')
    const note = await ada('POST', '/messages', { re: ready, text: 'the operator is still here' })
    expect(note.status).toBe(201)
    const read = await ada('GET', `/messages/${ready}`)
    expect(read).toMatchObject({ status: 200, body: { message: { id: ready, task: { state: 'ready' } }, replies: [{ text: 'the operator is still here' }] } })
    expectConflict(await agent('POST', `/tasks/${ready}/claim`, {}), pausedError)
    expectConflict(await agent('POST', '/tasks/claim', { channel: 'work' }), pausedError)
    expectConflict(await agent('POST', '/tasks', { channel: 'work', text: 'must not land', claim: true }), pausedError)
    const plain = (await ada('POST', '/messages', { channel: 'work', text: 'not yet a task' })).body.message.id
    expectConflict(await agent('POST', '/tasks', { re: plain, claim: true }), pausedError)
    expectConflict(await agent('POST', `/tasks/${already}/claim`, { token: claimToken }), pausedError)
    expectConflict(await agent('POST', `/tasks/${already}/complete`, proof), lostClaim)
    const listed = await ada('GET', '/tasks?channel=work&state=all')
    expect(listed.body.tasks.map((entry: { message: { id: string } }) => entry.message.id)).toEqual([already, createdId, ready])
    await ada('POST', '/control/resume', { reason: 'hold lifted' })
    expectConflict(await agent('POST', `/tasks/${already}/renew`, proof), lostClaim)
    expectConflict(await agent('POST', `/tasks/${already}/claim`, { token: claimToken }), lostClaim)
    const retry = await agent('POST', '/tasks', createWithClaim)
    expect({ status: retry.status, id: retry.body.task?.id, hasClaim: Boolean(retry.body.claim) }).toEqual({ status: 201, id: createdId, hasClaim: false })
    const fresh = await agent('POST', `/tasks/${already}/claim`, {})
    expect(fresh.status).toBe(200)
    expect(fresh.body.claim.epoch).toBeGreaterThan(proof.epoch)
    expect(fresh.body.claim.pauseEpoch).toBe(1)
    expectConflict(await agent('POST', `/tasks/${already}/complete`, proof), lostClaim)
  })

  it('does not grant a create-and-claim request held by middleware across a fast pause and resume', async () => {
    const gate = hold()
    const text = 'screen this task before it can be claimed'
    const team = testBoard({ middleware: [async ({ write, next }) => {
      if (write.text === text) await gate.stop()
      await next()
    }] })
    const ada = caller(team.fetch, await personToken('u_ada'))
    const pending = ada('POST', '/tasks', { channel: 'work', text, claim: true })
    try {
      await gate.reached
      expect(await ada('POST', '/control/pause', { reason: 'interrupt queue admission' })).toEqual(control(true, 1))
      expect(await ada('POST', '/control/resume', { reason: 'new admissions only' })).toEqual(control(false, 1))
    } finally {
      gate.release()
    }
    expectConflict(await pending, pausedError)
    expect((await ada('GET', '/messages?channel=work')).body.messages).toEqual([])
  })

  it('fences create-and-claim held on schema resolution without middleware', async () => {
    const team = testBoard()
    const ada = caller(team.fetch, await personToken('u_ada'))
    expect((await ada('POST', '/schemas', { name: 'work-item', version: 1, schema: { type: 'object' } })).status).toBe(200)
    const gate = hold()
    const schema = team.backend.schema.bind(team.backend)
    team.backend.schema = async (who, input, signal) => {
      if (input.id === 'work-item@1' && !gate.arrived()) await gate.stop()
      return schema(who, input, signal)
    }
    const text = '```json#work-item@1\n{}\n```'
    const pending = ada('POST', '/tasks', { channel: 'work', text, claim: true })
    try {
      await Promise.race([gate.reached, pending.then(() => { throw new Error('task request finished before the schema read') })])
      expect(await ada('POST', '/control/pause', { reason: 'interrupt validation' })).toEqual(control(true, 1))
      expect(await ada('POST', '/control/resume', { reason: 'new admissions only' })).toEqual(control(false, 1))
    } finally {
      gate.release()
    }
    expectConflict(await pending, pausedError)
    expect((await ada('GET', '/messages?channel=work')).body.messages).toHaveLength(0)
    expect((await events(ada)).map((event) => event.type)).not.toContain('task.claimed')
  })

  it.each(['pause', 'claim'] as const)('orders concurrent pause and claim by the log (%s lands first)', async (first) => {
    const store = memory()
    const team = testBoard({ store })
    const ada = caller(team.fetch, await personToken('u_ada'))
    const agent = caller(team.fetch, await personToken('u_ada'), { 'x-board-profile': 'worker' })
    const id = await makeTask(ada, 'only claim on the running side of the pause')
    const gate = hold()
    const append = store.log.append.bind(store.log)
    const delayed = first === 'pause' ? 'task.claimed' : 'work.control'
    store.log.append = async (session, rows, options) => {
      if (!gate.arrived() && rows.some((row) => row.type === delayed)) await gate.stop()
      return append(session, rows, options)
    }
    const pause = () => ada('POST', '/control/pause', { reason: 'operator stops starts' })
    const claim = () => agent('POST', `/tasks/${id}/claim`, {})
    const late = first === 'pause' ? claim() : pause()
    try {
      await gate.reached
      const early = await (first === 'pause' ? pause() : claim())
      expect(early.status).toBe(200)
    } finally {
      gate.release()
    }
    const result = await late
    if (first === 'pause') expectConflict(result, pausedError)
    else expect(result).toEqual(control(true, 1))
    const order = (await events(ada)).filter((event) => event.type === 'work.control' || event.type === 'task.claimed').map((event) => event.type)
    expect(order).toEqual(first === 'pause' ? ['work.control'] : ['task.claimed', 'work.control'])
  })

  it.each([false, true])('ends a pending claim-next with board_paused (resumed before the wait can retry: %s)', async (resume) => {
    const store = memory()
    const team = testBoard({ store })
    const ada = caller(team.fetch, await personToken('u_ada'))
    const gate = hold()
    const roots = store.tables.roots.bind(store.tables)
    store.tables.roots = async (filter, page) => {
      const result = await roots(filter, page)
      // Pause the database response to the wait's first empty selection, not its clock.
      if (!gate.arrived() && filter.channel?.path === 'work') await gate.stop()
      return result
    }
    const pending = ada('POST', '/tasks/claim', { channel: 'work', wait: 3 })
    try {
      await gate.reached
      expect(await ada('POST', '/control/pause', { reason: 'interrupt old waits' })).toEqual(control(true, 1))
      if (resume) expect(await ada('POST', '/control/resume', { reason: 'only new requests may claim' })).toEqual(control(false, 1))
      await makeTask(ada, 'ready before the old wait tries again')
    } finally {
      gate.release()
    }
    expectConflict(await pending, pausedError)
    if (!resume) await ada('POST', '/control/resume', { reason: 'restart the queue' })
    const next = await ada('POST', '/tasks/claim', { channel: 'work' })
    expect(next.status).toBe(200)
    expect(next.body.task?.text).toBe('ready before the old wait tries again')
  })

  it('skips scheduled sends during a pause and late delivery of a paused slot, without losing future slots', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const work = backgroundWork()
    try {
      const queue = fakeQueue()
      const team = testBoard({ scheduler: queue.scheduler })
      const ada = caller(team.fetch, await personToken('u_ada'))
      const root = (await ada('POST', '/messages', { channel: 'work', text: 'schedule fixture' })).body.message.id
      for (const plan of [{ text: 'during pause', in: '1m' }, { text: 'delivered late', in: '2m' }, { text: 'repeated check-in', in: '1m', every: '3m' }])
        expect((await ada('POST', '/schedules', { re: root, ...plan })).status).toBe(201)
      const replies = async () => (await ada('GET', `/messages/${root}`)).body.replies.map((m: { text: string }) => m.text)
      await work.settled()
      await ada('POST', '/control/pause', { reason: 'hold scheduled sends' })
      vi.setSystemTime(Date.now() + 60_000)
      await queue.fire()
      await work.settled()
      expect(await replies()).toEqual([])
      // The old timer's slot is exactly the resume tick; it is still stale.
      vi.setSystemTime(Date.now() + 60_000)
      await ada('POST', '/control/resume', { reason: 'skip missed slots' })
      await queue.fire()
      await work.settled()
      expect(await replies()).toEqual([])
      vi.setSystemTime(Date.now() + 2 * 60_000)
      await queue.fire()
      await work.settled()
      expect(await replies()).toEqual(['repeated check-in'])
    } finally {
      work.stop()
      vi.useRealTimers()
    }
  })

  it('skips a scheduled send that loses to pause in middleware and arms its next slot immediately', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const work = backgroundWork()
    const gate = hold()
    try {
      const queue = fakeQueue()
      const team = testBoard({ scheduler: queue.scheduler, middleware: [async ({ source, next }) => {
        if (source.kind === 'schedule' && !gate.arrived()) await gate.stop()
        await next()
      }] })
      const ada = caller(team.fetch, await personToken('u_ada'))
      const root = (await ada('POST', '/messages', { channel: 'work', text: 'scheduled check-ins' })).body.message.id
      expect((await ada('POST', '/schedules', { re: root, text: 'check in', in: '1m', every: '2m', times: 1 })).status).toBe(201)
      const replies = async () => (await ada('GET', `/messages/${root}`)).body.replies.map((m: { text: string }) => m.text)
      await work.settled()
      vi.setSystemTime(Date.now() + 60_000)
      const next = new Date(Date.now() + 120_000).toISOString()
      const delivery = queue.fire()
      try {
        await gate.reached
        // The send entered while the board was running, and finishes while it's running again.
        await ada('POST', '/control/pause', { reason: 'fence the in-flight occurrence' })
        await ada('POST', '/control/resume', { reason: 'allow the next occurrence' })
      } finally {
        gate.release()
      }
      await delivery
      await work.settled()
      expect(await replies()).toEqual([])
      expect((await ada('GET', '/schedules')).body.schedules).toMatchObject([{ next, sent: 0 }])
      vi.setSystemTime(Date.parse(next))
      await queue.fire()
      await work.settled()
      expect(await replies()).toEqual(['check in'])
    } finally {
      work.stop()
      vi.useRealTimers()
    }
  })
})
