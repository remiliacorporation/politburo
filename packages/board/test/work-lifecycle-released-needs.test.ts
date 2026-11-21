import { afterEach, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { a2, type A2Options } from '../src/server/a2.ts'
import { memory } from '../src/store/memory.ts'
import { bearer, board, BOARD_URL, personToken, testAuth, testLocal } from './harness.ts'
import { backgroundWork, fakeQueue } from './queue.ts'

const WORKER = 'vercel:user:u_worker'
const WAITING = { status: 409, code: 'task_waiting' }
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const close of closes.splice(0).reverse()) await close()
  } finally {
    vi.useRealTimers()
  }
})

function newStore() {
  const store = memory()
  closes.push(() => store.close())
  return store
}

async function setup({ store = newStore(), scheduler, enabled = true }: { store?: A2Options['store']; scheduler?: A2Options['scheduler']; enabled?: boolean } = {}) {
  const server = a2({ store, ...(scheduler ? { scheduler } : {}), ...(enabled ? { workLifecycle: { scopers: ['vercel:user:u_scoper'] } } : {}) })
  const team = board({ backend: server, url: BOARD_URL, authenticate: oidcTokens({ ...testAuth, local: testLocal }) })
  const handle = (token: string) => board({
    backend: http(BOARD_URL, { fetch: bearer((input, init) => team.fetch(new Request(input, init)), token) }),
  }).as(null)
  const [workerToken, scoperToken, otherToken] = await Promise.all([personToken('u_worker'), personToken('u_scoper'), personToken('u_other')])
  return { worker: handle(workerToken), scoper: handle(scoperToken), other: handle(otherToken) }
}

type Fixture = Awaited<ReturnType<typeof setup>>

async function finish({ worker, scoper }: Fixture, id: string) {
  await scoper.tasks.scope(id, 'Scope the work')
  await (await worker.tasks.claim(id)).complete()
  await scoper.tasks.stage(id, 'review', 'Start review')
  await scoper.tasks.stage(id, 'qa', 'Verify the change')
  await scoper.tasks.stage(id, 'approved', 'Review and QA passed')
  await scoper.tasks.stage(id, 'done', 'Delivery confirmed')
}

async function holdDependent({ worker, scoper }: Fixture, need: string, text: string, lease?: number) {
  const { task: { id } } = await worker.tasks.create('work', { text, needs: [need] })
  await scoper.tasks.scope(id, 'Scope the dependent')
  return worker.tasks.claim(id, lease === undefined ? {} : { lease })
}

const lapse = (until: string) => vi.setSystemTime(Date.parse(until) + 1000)

it.each(['task.released', 'task.expired'] as const)('keeps a dependent waiting after %s until its prerequisite is done again', async (type) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const queue = type === 'task.expired' ? fakeQueue() : undefined
  const ctx = await setup({ scheduler: queue?.scheduler })
  const work = backgroundWork()
  closes.push(async () => { await work.settled(); work.stop() })
  const { worker, scoper, other } = ctx
  const { task: prerequisite } = await worker.tasks.create('work', 'Prerequisite')
  await finish(ctx, prerequisite.id)
  const claim = await holdDependent(ctx, prerequisite.id, 'Dependent', 30)
  const live = await holdDependent(ctx, prerequisite.id, 'Dependent that keeps its claim')
  const { id } = claim.task
  await scoper.tasks.reopen(prerequisite.id, 'Requirements changed')
  expect((await worker.thread(id)).message.task?.state).toBe('claimed')
  const { cursor } = await worker.poll({ channel: 'work' })

  if (queue) {
    lapse(claim.until)
    await queue.fire()
    await work.settled()
  } else {
    await claim.release()
  }
  const waiting = { task: { state: 'waiting', needs: [prerequisite.id], claim: null }, labels: { 'board.task': 'waiting' } }
  expect((await worker.thread(id)).message).toMatchObject(waiting)
  const { threads } = await worker.threads({ channel: 'work', label: { 'board.task': 'waiting' } })
  expect(threads.map(({ message }) => message.id)).toContain(id)
  await expect(other.tasks.claim(id)).rejects.toMatchObject(WAITING)
  expect(await worker.tasks.claim({ channel: 'work' })).toBeNull()

  await finish(ctx, prerequisite.id)
  expect((await worker.thread(id)).message).toMatchObject({ task: { state: 'ready', needs: [prerequisite.id] }, labels: { 'board.task': 'ready' } })
  expect((await worker.thread(live.task.id)).message.task).toMatchObject({ state: 'claimed', epoch: live.epoch, claim: { until: live.until } })
  const { events } = await worker.poll({ channel: 'work', after: cursor })
  expect(events.find((event) => event.type === type && event.payload.id === id)).toMatchObject({ payload: { waiting: true }, message: waiting })
  const done = events.findIndex((event) => event.type === 'task.stage_changed' && event.payload.id === prerequisite.id && event.payload.to === 'done')
  expect(done).toBeGreaterThanOrEqual(0)
  const ready = events.filter((event) => event.type === 'task.ready')
  expect(ready.map(({ payload }) => payload.id)).toEqual([id])
  expect(events.indexOf(ready[0]!)).toBeGreaterThan(done)
  expect((await live.release()).task?.state).toBe('ready')
  expect((await other.tasks.claim(id)).task.task?.state).toBe('claimed')
})

it('leaves a lapsed dependent out of the ready list and claims until its prerequisite is done again', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const ctx = await setup()
  const { worker, scoper } = ctx
  const { task: prerequisite } = await worker.tasks.create('work', 'Prerequisite')
  await finish(ctx, prerequisite.id)
  const claim = await holdDependent(ctx, prerequisite.id, 'Dependent', 30)
  const { id } = claim.task
  await scoper.tasks.reopen(prerequisite.id, 'Requirements changed')
  lapse(claim.until)

  const readyIds = async () => (await worker.tasks.list({ channel: 'work', state: 'ready' })).tasks.map(({ message }) => message.id)
  expect((await worker.thread(id)).message.task?.state).toBe('claimed')
  await expect(worker.tasks.claim(id)).rejects.toMatchObject(WAITING)
  expect(await worker.tasks.claim({ channel: 'work' })).toBeNull()
  expect(await readyIds()).toEqual([])
  expect((await worker.thread(id)).message.task?.state).toBe('claimed')

  await finish(ctx, prerequisite.id)
  const listed = await readyIds()
  expect(listed).toEqual([id])
  expect((await worker.tasks.claim({ channel: 'work' }))?.task.id).toBe(listed[0])
})

it('lists ready staged work for non-scoper workers, but not when staged claims are disabled', async () => {
  const store = newStore()
  const { worker, scoper } = await setup({ store })
  const { task: { id } } = await worker.tasks.create('work', 'Scoped work')
  await scoper.tasks.scope(id, 'Scope the work')
  const ready = { channel: 'work', state: 'ready' } as const
  expect((await worker.tasks.list(ready)).tasks.map(({ message }) => message.id)).toEqual([id])
  const claim = await worker.tasks.claim({ channel: 'work' })
  expect(claim?.task.id).toBe(id)
  await claim!.release()

  const { worker: unstaged } = await setup({ store, enabled: false })
  expect((await unstaged.tasks.list({ ...ready, state: 'all' })).tasks.map(({ message }) => message.id)).toEqual([id])
  await expect(unstaged.tasks.claim(id)).rejects.toMatchObject({ status: 501, code: 'no_work_lifecycle' })
  expect(await unstaged.tasks.claim({ channel: 'work' })).toBeNull()
  expect((await unstaged.tasks.list(ready)).tasks).toEqual([])
})

it('refuses a lapsed dependent and records it waiting before replacing its needs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const ctx = await setup() // No scheduler: the lapsed claim still has its stored state.
  const { worker, scoper, other } = ctx
  const { task: prerequisite } = await worker.tasks.create('work', 'Prerequisite')
  await finish(ctx, prerequisite.id)
  const claim = await holdDependent(ctx, prerequisite.id, 'Dependent', 30)
  const { id } = claim.task
  await scoper.tasks.reopen(prerequisite.id, 'Requirements changed')
  lapse(claim.until)
  const { cursor } = await worker.poll({ channel: 'work' })

  await expect(other.tasks.claim(id)).rejects.toMatchObject(WAITING)
  expect(await other.tasks.claim({ channel: 'work', from: [WORKER] })).toBeNull()
  expect((await scoper.tasks.needs(id, [])).task).toMatchObject({ state: 'ready', needs: [] })
  const { events } = await worker.poll({ channel: 'work', after: cursor })
  expect(events.filter((event) => event.message?.id === id)).toMatchObject([
    { type: 'task.expired', payload: { waiting: true }, message: { task: { state: 'waiting', needs: [prerequisite.id] }, labels: { 'board.task': 'waiting' } } },
    { type: 'task.needs_changed', message: { task: { state: 'ready', needs: [] } } },
  ])
})

it.each(['by ID', 'from the ready queue'] as const)('keeps legacy releases unchanged but refuses a lapsed claim %s with stages disabled', async (how) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = newStore()
  const legacy = await setup({ store, enabled: false })
  const { task: prerequisite, claim } = await legacy.worker.tasks.create('work', { text: 'Legacy prerequisite', claim: true })
  const { task: { id, thread } } = await legacy.worker.tasks.create('work', { text: 'Legacy dependent', needs: [prerequisite.id] })
  await claim!.complete()
  const held = await legacy.worker.tasks.claim(id)
  const { cursor } = await legacy.worker.poll({ channel: 'work' })
  expect(await held.release()).toMatchObject({ task: { state: 'ready', needs: [prerequisite.id], claim: null }, labels: { 'board.task': 'ready' } })
  const { events } = await legacy.worker.poll({ channel: 'work', after: cursor })
  expect(events.find((event) => event.type === 'task.released')?.payload).toEqual({ id, thread, epoch: held.epoch, by: { actor: WORKER, principal: WORKER, profile: null } })

  const staged = await setup({ store })
  const { task: nextNeed } = await staged.worker.tasks.create('work', 'Staged prerequisite')
  await finish(staged, nextNeed.id)
  await staged.worker.tasks.needs(id, [nextNeed.id])
  const next = await staged.worker.tasks.claim(id, { lease: 30 })
  await staged.scoper.tasks.reopen(nextNeed.id, 'Requirements changed')
  lapse(next.until)

  // Disabling staged work does not complete an already-reopened prerequisite.
  const reopened = await setup({ store, enabled: false })
  if (how === 'by ID') await expect(reopened.other.tasks.claim(id)).rejects.toMatchObject(WAITING)
  else expect(await reopened.other.tasks.claim({ channel: 'work', from: [WORKER] })).toBeNull()
})
