import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { NEEDS_WALK_MAX } from '../src/server/tasks.ts'
import { bearer, board, BOARD_URL, personToken, testAuth, testLocal } from './harness.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function setup({ enabled = true, dir }: { enabled?: boolean; dir?: string } = {}) {
  const server = local({
    ...(dir ? { dir } : { memory: true }),
    ...(enabled ? { workLifecycle: { scopers: ['vercel:user:u_scoper'] } } : {}),
  })
  const close = () => server.close()
  closes.push(close)
  const team = board({ backend: server, url: BOARD_URL, authenticate: oidcTokens({ ...testAuth, local: testLocal }) })
  const handle = (token: string) => board({
    backend: http(BOARD_URL, { fetch: bearer((input, init) => team.fetch(new Request(input, init)), token) }),
  }).as(null)
  const [workerToken, scoperToken] = await Promise.all([personToken('u_worker'), personToken('u_scoper')])
  return { worker: handle(workerToken), scoper: handle(scoperToken), close }
}

type Fixture = Awaited<ReturnType<typeof setup>>

async function finish({ worker, scoper }: Fixture, id: string) {
  await scoper.tasks.scope(id, 'Scope the work')
  await (await worker.tasks.claim(id)).complete()
  await scoper.tasks.stage(id, 'review', 'Start review')
  await scoper.tasks.stage(id, 'approved', 'Review passed')
  return scoper.tasks.stage(id, 'done', 'Delivery confirmed')
}

it('returns a ready dependent to waiting on reopen and readies it again on completion', async () => {
  const ctx = await setup()
  const { worker, scoper } = ctx
  const { task: prerequisite } = await worker.tasks.create('work', 'Prerequisite')
  const { task: dependent } = await worker.tasks.create('work', { text: 'Dependent', needs: [prerequisite.id] })
  await scoper.tasks.scope(dependent.id, 'Scope the dependent')
  await finish(ctx, prerequisite.id)
  expect((await worker.thread(dependent.id)).message).toMatchObject({ task: { state: 'ready' }, labels: { 'board.task': 'ready' } })

  await scoper.tasks.reopen(prerequisite.id, 'Requirements changed')
  expect((await worker.thread(dependent.id)).message).toMatchObject({ task: { state: 'waiting', needs: [prerequisite.id] }, labels: { 'board.task': 'waiting' } })
  await expect(worker.tasks.claim(dependent.id).then(() => undefined)).rejects.toMatchObject({ status: 409, code: 'task_waiting' })

  const { cursor } = await worker.poll({ channel: 'work' })
  await finish(ctx, prerequisite.id)
  expect((await worker.thread(dependent.id)).message).toMatchObject({ task: { state: 'ready' }, labels: { 'board.task': 'ready' } })
  const { events } = await worker.poll({ channel: 'work', after: cursor })
  const done = events.findIndex((event) => event.type === 'task.stage_changed' && event.payload.id === prerequisite.id && event.payload.to === 'done')
  expect(done).toBeGreaterThanOrEqual(0)
  expect(events.slice(done + 1)).toContainEqual(expect.objectContaining({ type: 'task.ready', payload: expect.objectContaining({ id: dependent.id }) }))
})

it('accepts a needs change past a long chain of completed legacy tasks with stages enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-work-lifecycle-reopen-'))
  closes.push(() => rm(dir, { recursive: true, force: true }))
  const legacy = await setup({ enabled: false, dir })
  let end: string | undefined
  // Finish each link before making the next so creation can claim it in the same write.
  for (let i = 0; i <= NEEDS_WALK_MAX; i++) {
    const { task, claim } = await legacy.worker.tasks.create('work', { text: `Legacy step ${i + 1}`, needs: end ? [end] : [], claim: true })
    await claim!.complete()
    end = task.id
  }
  await legacy.close()

  const { worker, scoper } = await setup({ dir })
  const { task: prerequisite } = await worker.tasks.create('work', { text: 'Next step', needs: [end!] })
  const { task: target } = await worker.tasks.create('work', 'Wait for the next step')
  const changed = await scoper.tasks.needs(target.id, [prerequisite.id])
  expect(changed.task).toMatchObject({ work: { stage: 'proposed' }, state: 'waiting', needs: [prerequisite.id] })
}, 120_000)

it('still refuses a needs change that closes a cycle through completed staged work', async () => {
  const ctx = await setup()
  const { worker, scoper } = ctx
  const { task: prerequisite } = await worker.tasks.create('work', 'Prerequisite')
  const { task: dependent } = await worker.tasks.create('work', { text: 'Dependent', needs: [prerequisite.id] })
  await finish(ctx, prerequisite.id)
  expect((await finish(ctx, dependent.id)).task?.work?.stage).toBe('done')
  await scoper.tasks.reopen(prerequisite.id, 'Requirements changed')

  await expect(scoper.tasks.needs(prerequisite.id, [dependent.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
})
