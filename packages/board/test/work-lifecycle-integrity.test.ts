import { afterEach, expect, it } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { bearer, board, BOARD_URL, personToken, testAuth, testLocal } from './harness.ts'

const SCOPER = 'vercel:user:u_scoper'
const WORKER = 'vercel:user:u_worker'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function setup() {
  const server = local({ memory: true, workLifecycle: { scopers: [SCOPER] } })
  closes.push(() => server.close())
  const team = board({ backend: server, url: BOARD_URL, authenticate: oidcTokens({ ...testAuth, local: testLocal }) })
  const [scoperToken, workerToken] = await Promise.all([personToken('u_scoper'), personToken('u_worker')])
  const fetchAs = (token: string, headers: Record<string, string> = {}) => bearer((input, init) => {
    const request = new Request(input, init)
    for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
    return team.fetch(request)
  }, token)
  const handle = (token: string) => board({ backend: http(BOARD_URL, { fetch: fetchAs(token) }) }).as(null)
  return { worker: handle(workerToken), scoper: handle(scoperToken), fetchAs, scoperToken }
}

type Fixture = Awaited<ReturnType<typeof setup>>

async function approve({ worker, scoper }: Fixture, id: string) {
  await (await worker.tasks.claim(id)).complete()
  await scoper.tasks.stage(id, 'review', 'Start review')
  await scoper.tasks.stage(id, 'approved', 'Review passed')
}

it('keeps a deleted done prerequisite satisfied for approved and scoped dependents', async () => {
  const ctx = await setup()
  const { worker, scoper } = ctx
  const { task: prerequisite } = await worker.tasks.create('work', 'Implement the change')
  const { task: dependent } = await worker.tasks.create('work', { text: 'Document the change', needs: [prerequisite.id] })
  const { task: waiting } = await worker.tasks.create('work', { text: 'Announce the change', needs: [prerequisite.id, dependent.id] })
  await scoper.tasks.scope(prerequisite.id, 'Scope implementation')
  await scoper.tasks.scope(dependent.id, 'Scope documentation')
  await scoper.tasks.scope(waiting.id, 'Scope announcement')

  await approve(ctx, prerequisite.id)
  await scoper.tasks.stage(prerequisite.id, 'done', 'Implementation complete')
  expect((await worker.thread(dependent.id)).message.task).toMatchObject({ work: { stage: 'scoped' }, state: 'ready' })
  await approve(ctx, dependent.id)
  await worker.delete(prerequisite.id)

  expect((await worker.thread(waiting.id)).message.task).toMatchObject({ work: { stage: 'scoped' }, state: 'waiting' })
  const done = await scoper.tasks.stage(dependent.id, 'done', 'Documentation complete')
  expect(done.task).toMatchObject({ work: { stage: 'done' }, state: 'completed' })
  expect((await worker.thread(waiting.id)).message.task).toMatchObject({ work: { stage: 'scoped' }, state: 'ready' })
  await expect(worker.tasks.create('work', { text: 'New dependent', needs: [prerequisite.id] }))
    .rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
})

it('keeps a deleted done prerequisite when a scoper replaces other needs', async () => {
  const ctx = await setup()
  const { worker, scoper } = ctx
  const { task: prerequisite } = await worker.tasks.create('work', 'Write the guide')
  const { task: dropped } = await worker.tasks.create('work', 'Draft the release notes')
  const { task: added } = await worker.tasks.create('work', 'Review the guide')
  const { task: dependent } = await worker.tasks.create('work', { text: 'Publish the guide', needs: [prerequisite.id, dropped.id] })
  await scoper.tasks.scope(dependent.id, 'Scope publication')
  await scoper.tasks.scope(prerequisite.id, 'Scope the guide')
  await approve(ctx, prerequisite.id)
  await scoper.tasks.stage(prerequisite.id, 'done', 'Guide written')
  await worker.delete(prerequisite.id)

  const needs = [prerequisite.id, added.id]
  const changed = await scoper.tasks.needs(dependent.id, needs)
  expect(changed.task).toMatchObject({ state: 'waiting', needs })
  expect((await scoper.tasks.needs(dependent.id, needs)).version).toBe(changed.version)

  await scoper.tasks.scope(added.id, 'Scope the review')
  await approve(ctx, added.id)
  await scoper.tasks.stage(added.id, 'done', 'Guide reviewed')
  expect((await worker.thread(dependent.id)).message.task?.state).toBe('ready')

  const { task: other } = await worker.tasks.create('work', { text: 'Publish the release notes', needs: [dropped.id] })
  await expect(scoper.tasks.needs(other.id, [prerequisite.id, dropped.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
  // A rejected prerequisite stays failed on deletion, so the deletion rule alone must refuse it.
  await scoper.tasks.stage(dropped.id, 'rejected', 'Release notes are out of scope')
  await worker.delete(dropped.id)
  await expect(scoper.tasks.needs(other.id, [dropped.id])).rejects.toMatchObject({ status: 400, code: 'invalid_needs' })
})

it('denies read-only staged assignment without naming the owner', async () => {
  const { worker, fetchAs, scoperToken } = await setup()
  const { task: { id } } = await worker.tasks.create('work', 'Assign the work')
  const url = `${BOARD_URL}/tasks/${id}/assign`
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ for: 'vercel:user:someone-else+x' }) }

  const invalid = await fetchAs(scoperToken)(url, request)
  expect(invalid.status).toBe(400)
  expect(await invalid.text()).toContain(`${WORKER}+<profile>`)

  const denied = await fetchAs(scoperToken, { 'x-board-can': 'work=read' })(url, request)
  expect({ status: denied.status, namesOwner: (await denied.text()).includes(WORKER) }).toEqual({ status: 403, namesOwner: false })
})
