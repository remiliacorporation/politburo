import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import type { MessageView } from '../src/api/routes.ts'
import type { AttentionDraft } from '../src/contract/attention.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { bearer, board, BOARD_URL, caller, deploymentToken, personToken, testAuth, testLocal } from './harness.ts'

const SCOPER = 'vercel:user:u_scoper'
const OTHER_SCOPER = 'vercel:user:u_approver'
const WORKER = 'vercel:user:u_worker'
const workLifecycle = { scopers: [SCOPER, OTHER_SCOPER, 'vercel:project:prj_web:production'] }
const PROPOSED = { stage: 'proposed', scopedRevision: null }
const STAGE_ERROR = { status: 409, code: 'invalid_task_stage' }
const VERSION_ERROR = { status: 409, code: 'task_version_conflict' }
const FORBIDDEN = { status: 403, code: 'forbidden' }
const REQUIRED = { status: 409, code: 'work_lifecycle_required' }
const UNSUPPORTED = { status: 501, code: 'no_work_lifecycle' }

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function setup({ enabled = true, dir, parity = false }: { enabled?: boolean; dir?: string; parity?: boolean } = {}) {
  const server = local({
    ...(dir ? { dir } : { memory: true }),
    ...(enabled ? { workLifecycle } : {}),
    ...(parity ? { attentionResponders: { work: [OTHER_SCOPER], conformance: [OTHER_SCOPER] }, agentOps: true } : {}),
  })
  closes.push(() => server.close())
  const team = board({ backend: server, url: BOARD_URL, authenticate: oidcTokens({ ...testAuth, local: testLocal }) })
  const [scoperToken, approverToken, workerToken, webToken] = await Promise.all([
    personToken('u_scoper'), personToken('u_approver'), personToken('u_worker'), deploymentToken('web', 'prj_web'),
  ])
  const handle = (token: string, headers: Record<string, string> = {}) => board({
    backend: http(BOARD_URL, { fetch: bearer((input, init) => {
      const request = new Request(input, init)
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
      return team.fetch(request)
    }, token) }),
  }).as(null)
  return {
    handle, workerToken, scoperToken,
    worker: handle(workerToken), scoper: handle(scoperToken), approver: handle(approverToken), web: handle(webToken),
    request: caller(team.fetch, scoperToken), workerRequest: caller(team.fetch, workerToken), syncRequest: caller(team.fetch, webToken),
    close: async () => { await server.close() },
  }
}

type Fixture = Awaited<ReturnType<typeof setup>>
type Stage = NonNullable<NonNullable<MessageView['task']>['work']>['stage']

async function create({ worker }: Fixture, text = 'Implement the change') {
  return (await worker.tasks.create('work', text)).task
}

async function audit({ worker }: Fixture, id: string) {
  const { events } = await worker.poll({ channel: 'work', last: 100 })
  return events.filter((event) => event.type === 'task.stage_changed').filter((event) => event.payload.id === id)
}

function errorOf(response: { status: number; body: { error?: { code: string } } }) {
  return { status: response.status, code: response.body?.error?.code }
}

it('scopes a revision, hands off twice through repair, and audits the verified actors and reasons', async () => {
  const ctx = await setup()
  const { worker, scoper, approver } = ctx
  const root = await create(ctx)
  const { id, thread } = root
  expect(await worker.discovery()).toMatchObject({ workLifecycle: 1 })
  expect(root.task?.work).toEqual(PROPOSED)
  const created = (await worker.poll({ channel: 'work', last: 10 })).events.find((event) => event.type === 'task.created' && event.payload.id === id)
  expect(created).toMatchObject({ payload: { id, thread, work: 'proposed' } })

  const scoped = await scoper.as('scope-desk').tasks.scope(id, 'Requirements accepted')
  expect(scoped.task?.work).toEqual({ stage: 'scoped', scopedRevision: root.revision })
  const claim = await worker.tasks.claim(id)
  await expect(claim.fail('A worker cannot reject this')).rejects.toMatchObject(REQUIRED)
  expect((await worker.thread(id)).message.task?.claim?.actor).toBe(WORKER)
  const handoff = await claim.complete('First patch')
  expect(handoff.task).toMatchObject({ work: { stage: 'handoff' }, state: 'waiting', claim: null })
  await expect(claim.renew()).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  expect((await approver.tasks.stage(id, 'review', 'Review began')).task?.work?.stage).toBe('review')
  expect((await approver.tasks.stage(id, 'qa', 'Ready for QA')).task?.work?.stage).toBe('qa')
  expect((await approver.tasks.stage(id, 'repair', 'Add a regression test')).task?.work?.stage).toBe('repair')
  const retry = await worker.tasks.claim(id)
  await expect(claim.complete('Stale patch')).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  expect((await retry.complete()).task?.work?.stage).toBe('handoff')
  await approver.tasks.stage(id, 'review', 'Second review began')
  await approver.tasks.stage(id, 'approved', 'Review passed')
  expect((await approver.tasks.stage(id, 'done', 'Published')).task).toMatchObject({ work: { stage: 'done' }, state: 'completed' })
  await expect(scoper.tasks.reopen(id)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  expect(errorOf(await ctx.request('POST', `/tasks/${id}/reopen`, { reason: 'Missing version' }))).toEqual({ status: 400, code: 'invalid_request' })
  await expect(scoper.tasks.reopen(id, 'Stale reopen', { ifVersion: root.version })).rejects.toMatchObject(VERSION_ERROR)
  expect((await scoper.tasks.reopen(id, 'New requirements')).task?.work).toEqual(PROPOSED)
  expect((await worker.thread(id)).message.task?.work).toEqual(PROPOSED)

  expect((await audit(ctx, id)).map(({ payload, actor }) => [payload.id, payload.thread, payload.from, payload.to, payload.reason, actor?.id])).toEqual([
    [id, thread, 'proposed', 'scoped', 'Requirements accepted', `${SCOPER}+scope-desk`],
    [id, thread, 'scoped', 'handoff', 'First patch', WORKER],
    [id, thread, 'handoff', 'review', 'Review began', OTHER_SCOPER],
    [id, thread, 'review', 'qa', 'Ready for QA', OTHER_SCOPER],
    [id, thread, 'qa', 'repair', 'Add a regression test', OTHER_SCOPER],
    [id, thread, 'repair', 'handoff', expect.stringMatching(/\S/), WORKER],
    [id, thread, 'handoff', 'review', 'Second review began', OTHER_SCOPER],
    [id, thread, 'review', 'approved', 'Review passed', OTHER_SCOPER],
    [id, thread, 'approved', 'done', 'Published', OTHER_SCOPER],
    [id, thread, 'done', 'proposed', 'New requirements', SCOPER],
  ])
})

it('requires both an allowlisted principal and manage in the root channel, not owner, label, or a profile name', async () => {
  const ctx = await setup()
  const { worker, scoper, web, handle, workerToken, scoperToken } = ctx
  const narrowed = handle(scoperToken, { 'x-board-can': 'work=read,post,label;elsewhere=all' })
  const lookalike = worker.as('scoper')
  const labelOnly = handle(workerToken, { 'x-board-can': 'work=read,label' })
  const root = await create(ctx)
  const id = root.id
  // The project is on the allowlist and may manage elsewhere, but not this task's channel.
  await scoper.createGrant({ principals: [{ kind: 'project', project: 'prj_web', environments: ['production'] }], can: { elsewhere: 'all' } })
  const unauthorized = [worker, lookalike, labelOnly, narrowed, web]
  for (const client of unauthorized) await expect(client.tasks.scope(id, 'Self-authorize')).rejects.toMatchObject(FORBIDDEN)
  expect((await worker.thread(id)).message.version).toBe(root.version)
  await scoper.tasks.scope(id, 'Approved scope')
  await (await worker.tasks.claim(id)).complete()
  for (const client of unauthorized) {
    await expect(client.tasks.stage(id, 'review', 'Self-review')).rejects.toMatchObject(FORBIDDEN)
    await expect(client.tasks.cancel(id, 'Self-cancel')).rejects.toMatchObject(FORBIDDEN)
  }
  await scoper.tasks.stage(id, 'rejected', 'No longer needed')
  for (const client of unauthorized) await expect(client.tasks.reopen(id, 'Bring it back')).rejects.toMatchObject(FORBIDDEN)
  expect((await scoper.tasks.reopen(id, 'New decision')).task?.work).toEqual(PROPOSED)
  expect((await audit(ctx, id)).map((event) => event.payload.to)).toEqual(['scoped', 'handoff', 'rejected', 'proposed'])
  await scoper.createGrant({ principals: [{ kind: 'project', project: 'prj_web', environments: ['production'] }], can: { work: ['read', 'manage'] } })
  expect((await web.tasks.scope(id, 'Manage in the root channel')).task?.work?.stage).toBe('scoped')
})

it('cannot create and claim or adopt and claim; create, adoption, and batch stay proposed until scoped', async () => {
  const ctx = await setup()
  const { worker, scoper, workerRequest } = ctx
  const plain = await worker.post('work', 'Existing request')
  const marker = (await worker.poll({ channel: 'work' })).cursor
  await expect(worker.tasks.create('work', { text: 'Bypass at create', claim: true })).rejects.toMatchObject(REQUIRED)
  await expect(worker.tasks.create({ re: plain.id }, { claim: true })).rejects.toMatchObject(REQUIRED)
  expect((await worker.poll({ channel: 'work', after: marker })).events).toEqual([])
  expect((await worker.thread(plain.id)).message.task).toBeUndefined()

  const root = await create(ctx)
  const adopted = (await worker.tasks.create({ re: plain.id })).task
  const batch = await worker.tasks.createMany('work', [{ text: 'Batch prerequisite', key: 'first' }, { text: 'Batch dependent', needs: [{ key: 'first' }] }])
  expect(adopted.id).toBe(plain.id)
  expect(batch).toHaveLength(2)
  for (const task of [root, adopted, ...batch]) {
    expect(task.task?.work).toEqual(PROPOSED)
    await worker.label(task.id, { set: { stage: 'scoped' } })
    await expect(worker.tasks.claim(task.id)).rejects.toMatchObject(STAGE_ERROR)
  }
  await expect(worker.label(root.id, { set: { 'board.task': 'ready' } })).rejects.toMatchObject({ status: 400, code: 'reserved_label' })
  expect(await workerRequest('POST', '/tasks/claim', { channel: 'work', label: { stage: 'scoped' } })).toMatchObject({ status: 200, body: { task: null } })
  await scoper.tasks.scope(adopted.id, 'Only the adopted task is ready')
  expect((await worker.tasks.claim({ channel: 'work' }))?.task.id).toBe(adopted.id)
})

it('releases scoped dependents only after done and retests eligibility if a prerequisite reopens', async () => {
  const ctx = await setup()
  const { worker, scoper } = ctx
  const first = await create(ctx)
  const second = (await worker.tasks.create('work', { text: 'Depends on the first', labels: { dependent: 'yes' }, needs: [first.id] })).task
  await scoper.tasks.scope(first.id, 'Scope prerequisite')
  await scoper.tasks.scope(second.id, 'Scope dependent')
  const next = () => worker.tasks.claim({ channel: 'work', label: { dependent: 'yes' } })
  await (await worker.tasks.claim(first.id)).complete()
  expect(await next()).toBeNull()
  await scoper.tasks.stage(first.id, 'review', 'Start review')
  await scoper.tasks.stage(first.id, 'approved', 'Pass review')
  expect(await next()).toBeNull()
  await scoper.tasks.stage(first.id, 'done', 'Delivery confirmed')
  const claim = await next()
  expect(claim?.task.id).toBe(second.id)
  await claim!.release()
  await scoper.tasks.reopen(first.id, 'Requirement changed')
  await expect(worker.tasks.claim(second.id)).rejects.toMatchObject({ status: 409 })
  expect(await next()).toBeNull()
})

it('allows one concurrent claim and one of two conflicting terminal moves over HTTP', async () => {
  const ctx = await setup()
  const { scoper, approver, worker } = ctx
  const { id } = await create(ctx)
  await scoper.tasks.scope(id, 'Start work')
  const claimRace = await Promise.allSettled([worker.as('one'), worker.as('two')].map((actor) => actor.tasks.claim(id)))
  const claims = claimRace.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  expect(claims).toHaveLength(1)
  expect(claimRace).toContainEqual(expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ status: 409, code: 'task_claimed' }) }))
  await claims[0]!.complete()
  await scoper.tasks.stage(id, 'review', 'Review it')
  const { version: ifVersion } = await scoper.tasks.stage(id, 'approved', 'Looks good')
  const stageRace = await Promise.allSettled([
    scoper.tasks.stage(id, 'done', 'Ship it', { ifVersion }),
    approver.tasks.stage(id, 'rejected', 'Stop it', { ifVersion }),
  ])
  const winners = stageRace.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  expect(winners).toHaveLength(1)
  expect(stageRace).toContainEqual(expect.objectContaining({ status: 'rejected', reason: expect.objectContaining(STAGE_ERROR) }))
  const terminal = (await worker.thread(id)).message.task?.work?.stage
  expect(terminal).toBe(winners[0]!.task?.work?.stage)
  expect((await audit(ctx, id)).filter(({ payload }) => payload.from === 'approved').map(({ payload }) => payload.to)).toEqual([terminal])
})

it.each(['rejected', 'canceled'] as const)('ends an active lease on %s and audits who ended it', async (terminal) => {
  const ctx = await setup()
  const { scoper, worker } = ctx
  const { id, thread } = await create(ctx)
  await scoper.tasks.scope(id, 'Start work')
  const claim = await worker.tasks.claim(id)
  const ended = terminal === 'rejected'
    ? await scoper.tasks.stage(id, terminal, 'Stop work')
    : await scoper.tasks.cancel(id, 'Stop work')
  expect(ended.task).toMatchObject({ work: { stage: terminal }, claim: null })
  await expect(claim.complete('Too late')).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  await worker.edit(id, 'Retain terminal state after an edit')
  expect((await worker.thread(id)).message.task?.work?.stage).toBe(terminal)
  expect((await audit(ctx, id)).at(-1)).toMatchObject({
    payload: { id, thread, from: 'scoped', to: terminal, reason: 'Stop work' }, actor: { id: SCOPER },
  })
})

const targets = ['review', 'qa', 'repair', 'approved', 'done', 'rejected'] as const
type Target = typeof targets[number]
const allowed: Record<Stage, readonly Target[]> = {
  proposed: ['rejected'], scoped: ['rejected'], handoff: ['review', 'rejected'],
  review: ['qa', 'approved', 'repair', 'rejected'], qa: ['approved', 'repair', 'rejected'],
  repair: ['rejected'], approved: ['done', 'repair', 'rejected'],
  done: [], rejected: [], canceled: [],
}

async function atStage(ctx: Fixture, stage: Stage) {
  const { scoper, worker } = ctx
  const { id } = await create(ctx)
  if (stage === 'proposed') return id
  if (stage === 'rejected') { await scoper.tasks.stage(id, 'rejected', 'Reject it'); return id }
  if (stage === 'canceled') { await scoper.tasks.cancel(id, 'Cancel it'); return id }
  await scoper.tasks.scope(id, 'Scope it')
  if (stage === 'scoped') return id
  await (await worker.tasks.claim(id)).complete()
  if (stage === 'handoff') return id
  await scoper.tasks.stage(id, 'review', 'Review it')
  if (stage === 'review') return id
  if (stage === 'repair' || stage === 'qa') { await scoper.tasks.stage(id, stage, 'Review decision'); return id }
  await scoper.tasks.stage(id, 'approved', 'Accept it')
  if (stage === 'done') await scoper.tasks.stage(id, 'done', 'Ship it')
  return id
}

describe('illegal lifecycle edges', () => {
  it.each(Object.keys(allowed) as Stage[])('refuses illegal moves from %s without a write', async (stage) => {
    const ctx = await setup()
    const { worker, scoper, request } = ctx
    const id = await atStage(ctx, stage)
    const { message: before } = await worker.thread(id)
    expect(before.task?.work?.stage).toBe(stage)
    const marker = (await worker.poll({ channel: 'work' })).cursor
    for (const target of targets.filter((target) => !allowed[stage].includes(target))) {
      await expect(scoper.tasks.stage(id, target, 'Illegal move'), `${stage} -> ${target}`).rejects.toMatchObject(STAGE_ERROR)
    }
    if (stage !== 'proposed') await expect(scoper.tasks.scope(id, 'Scope again')).rejects.toMatchObject(STAGE_ERROR)
    if (stage !== 'done' && stage !== 'rejected') await expect(scoper.tasks.reopen(id, 'Reopen this')).rejects.toMatchObject(STAGE_ERROR)
    if (stage === 'done' || stage === 'rejected' || stage === 'canceled') await expect(scoper.tasks.cancel(id, 'Cancel again')).rejects.toMatchObject(STAGE_ERROR)
    if (stage !== 'scoped' && stage !== 'repair') await expect(worker.tasks.claim(id)).rejects.toMatchObject(STAGE_ERROR)
    // There is no live lease at any starting stage above, even when a fresh claim is permitted.
    expect(errorOf(await request('POST', `/tasks/${id}/complete`, { epoch: 1, token: 'A'.repeat(43) }))).toEqual({ status: 409, code: 'claim_lost' })
    expect((await worker.thread(id)).message.version).toBe(before.version)
    expect((await worker.poll({ channel: 'work', after: marker })).events).toEqual([])
  })

  it('does not let the stage endpoint scope, hand off, cancel, or reopen', async () => {
    const ctx = await setup()
    const id = await atStage(ctx, 'proposed')
    const { version: ifVersion } = (await ctx.scoper.thread(id)).message
    for (const stage of ['proposed', 'scoped', 'handoff', 'canceled', 'unknown']) {
      expect(errorOf(await ctx.request('POST', `/tasks/${id}/stage`, { stage, ifVersion, reason: 'Try a different route' }))).toEqual({ status: 400, code: 'invalid_request' })
    }
    expect((await ctx.worker.thread(id)).message.task?.work).toEqual(PROPOSED)
  })
})

it('invalidates scope and the lease on an owner edit, and pins the new revision when scoped again', async () => {
  const ctx = await setup()
  const { worker, scoper } = ctx
  const { id, revision, version } = await create(ctx)
  await scoper.tasks.scope(id, 'Initial scope')
  const claim = await worker.tasks.claim(id)
  await worker.edit(id, 'Updated requirements', { revision })
  const { message } = await worker.thread(id)
  expect(message.revision).not.toBe(revision)
  expect(message.task).toMatchObject({ work: PROPOSED, claim: null })
  await expect(claim.complete('Old requirements')).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  await expect(worker.tasks.claim(id)).rejects.toMatchObject(STAGE_ERROR)
  await expect(scoper.tasks.scope(id, 'Stale scope', { ifVersion: version })).rejects.toMatchObject(VERSION_ERROR)
  expect((await scoper.tasks.scope(id, 'Scope the update', { ifVersion: message.version })).task?.work).toEqual({ stage: 'scoped', scopedRevision: message.revision })
})

it('refuses a decision from an earlier review even after work returns to review', async () => {
  const ctx = await setup()
  const { scoper, approver, worker } = ctx
  const id = await atStage(ctx, 'review')
  const oldReview = (await scoper.thread(id)).message
  await approver.tasks.stage(id, 'repair', 'Fix the regression')
  await (await worker.tasks.claim(id)).complete('Repaired patch')
  const newReview = await approver.tasks.stage(id, 'review', 'Review the repaired patch')
  const marker = (await scoper.poll({ channel: 'work' })).cursor
  await expect(scoper.tasks.stage(id, 'approved', 'Approved the old patch', { ifVersion: oldReview.version })).rejects.toMatchObject(VERSION_ERROR)
  expect((await scoper.poll({ channel: 'work', after: marker })).events).toEqual([])
  const approved = await scoper.tasks.stage(id, 'approved', 'Approved the repaired patch', { ifVersion: newReview.version })
  expect(approved.task?.work?.stage).toBe('approved')
})

it('invalidates review and scope when the platform edits an imported root', async () => {
  const ctx = await setup()
  const { syncRequest, scoper, worker } = ctx
  expect((await syncRequest('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
  const author = { id: 'slack:user:U_EVE', handle: 'eve', name: 'Eve', avatar: null, isBot: false }
  const origin = { channel: 'slack:C1', thread: 'slack:C1:100.1', subthread: null, message: '100.1', context: null }
  const imported = await syncRequest('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'work', text: 'Checkout is slow', origin })
  const id = imported.body.message as string
  await worker.tasks.create({ re: id })
  await scoper.tasks.scope(id, 'Scope the fix')
  await (await worker.tasks.claim(id)).complete()
  await scoper.tasks.stage(id, 'review', 'Review the fix')
  expect((await syncRequest('POST', '/sync/imports', { op: 'edit', author, from: 'slack', origin: { thread: origin.thread, message: origin.message }, text: 'Checkout and search are slow' })).status).toBe(200)
  expect((await worker.thread(id)).message).toMatchObject({ text: 'Checkout and search are slow', task: { work: PROPOSED } })
  await expect(scoper.tasks.stage(id, 'approved', 'Approve the old fix')).rejects.toMatchObject(STAGE_ERROR)
  expect((await audit(ctx, id)).at(-1)).toMatchObject({ payload: { from: 'review', to: 'proposed', reason: expect.stringMatching(/\S/) }, actor: { id: expect.stringMatching(/slack:user:U_EVE$/) } })
})

it('leaves an existing task legacy when opening its board with lifecycle enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-work-lifecycle-'))
  closes.push(() => rm(dir, { recursive: true, force: true }))
  const legacy = await setup({ enabled: false, dir })
  expect((await legacy.worker.discovery()).workLifecycle).toBeUndefined()
  const { task: root, claim } = await legacy.worker.tasks.create('work', { text: 'Legacy task', claim: true })
  expect(root.task?.work).toBeUndefined()
  await expect(legacy.scoper.tasks.scope(root.id, 'Not enabled')).rejects.toMatchObject(UNSUPPORTED)
  await expect(legacy.scoper.tasks.stage(root.id, 'review', 'Not enabled')).rejects.toMatchObject(UNSUPPORTED)
  await claim!.fail('Needs a retry')
  await legacy.close()
  const enabled = await setup({ dir })
  const reopened = await enabled.worker.tasks.reopen(root.id)
  expect(reopened.task?.work).toBeUndefined()
  expect(reopened.task?.state).toBe('ready')
  expect((await (await enabled.worker.tasks.claim(root.id)).complete()).task?.state).toBe('completed')
  expect((await create(enabled)).task?.work).toEqual(PROPOSED)
})

it('documents the lifecycle write bodies in OpenAPI', async () => {
  const { request } = await setup()
  const response = await request('GET', '/openapi.json')
  expect(response.status).toBe(200)
  const body = (route: string) => response.body.paths[`/tasks/{id}/${route}`]?.post?.requestBody
  expect.soft(body('scope')?.required).toBe(true)
  expect.soft(body('stage')?.required).toBe(true)
  expect(body('reopen')?.required).not.toBe(true)
  const schema = (route: string) => body(route)?.content['application/json']?.schema
  const move = { reason: { type: 'string' }, ifVersion: { type: 'integer' } }
  expect(schema('scope')).toMatchObject({ required: expect.arrayContaining(['reason', 'ifVersion']), properties: move })
  expect(schema('stage')).toMatchObject({ required: expect.arrayContaining(['stage', 'reason', 'ifVersion']), properties: move })
  expect(new Set(schema('stage').properties.stage.enum)).toEqual(new Set(targets))
  expect(schema('reopen')).toMatchObject({ properties: move })
  expect(schema('reopen').required ?? []).not.toContain('reason')
  expect(schema('reopen').required ?? []).not.toContain('ifVersion')
})

it('documents the optional access fence scope in OpenAPI discovery', async () => {
  const { request } = await setup()
  const response = await request('GET', '/openapi.json')
  expect(response.status).toBe(200)
  const schema = response.body.paths['/']?.get?.responses?.['200']?.content['application/json']?.schema
  expect(schema?.properties?.accessFenceScope).toMatchObject({ const: 'process' })
  expect(schema.required ?? []).not.toContain('accessFenceScope')
})

it('ranks scoped work by priority without admitting proposed work or reviving pre-pause leases', async () => {
  const { worker, scoper } = await setup({ parity: true })
  const [low, proposed, high] = await worker.tasks.createMany('work', [
    { text: 'Low priority', priority: 'low' },
    { text: 'Urgent but not scoped', priority: 'urgent' },
    { text: 'High priority', priority: 'high' },
  ])
  expect(proposed!.task).toMatchObject({ state: 'waiting', priority: 'urgent', work: PROPOSED })
  for (const root of [low!, high!]) await scoper.tasks.scope(root.id, 'Ready for implementation')
  const first = (await worker.tasks.claim({ channel: 'work' }))!
  expect(first.task).toMatchObject({ id: high!.id, task: { priority: 'high', work: { stage: 'scoped' } } })
  await scoper.pause('Wait for coordination')
  await expect(worker.tasks.claim(low!.id)).rejects.toMatchObject({ status: 409, code: 'board_paused' })
  await scoper.resume('Continue the queue')
  await expect(first.complete()).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  const next = (await worker.tasks.claim({ channel: 'work' }))!
  expect(next.task.id).toBe(high!.id)
  const otherProfile = worker.as('other')
  await expect(otherProfile.tasks.held(next.task.id, { epoch: next.epoch, token: next.token }).complete())
    .rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  expect((await next.complete()).task?.work?.stage).toBe('handoff')
})

it('keeps a staged task parked across edits and does not restore scope or its lease on unpark', async () => {
  const { worker, scoper } = await setup()
  const { task: root } = await worker.tasks.create('work', 'Original instructions')
  await scoper.tasks.scope(root.id, 'Ready for implementation')
  const claim = await worker.tasks.claim(root.id)
  await scoper.tasks.park(root.id, 'Wait for the operator')
  await worker.edit(root.id, 'Updated instructions')
  expect((await worker.thread(root.id)).message.task).toMatchObject({
    state: 'blocked', work: PROPOSED, claim: null, parked: { reason: 'Wait for the operator' },
  })
  await expect(worker.tasks.unblock(root.id)).rejects.toMatchObject({ status: 409, code: 'task_blocked' })
  const unparked = await scoper.tasks.unpark(root.id, 'Maintenance finished')
  expect(unparked.task).toMatchObject({ state: 'waiting', work: PROPOSED, claim: null, parked: null })
  expect(unparked.labels['board.task']).toBe('waiting')
  await expect(claim.complete()).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  await expect(worker.tasks.claim(root.id)).rejects.toMatchObject(STAGE_ERROR)
  await scoper.tasks.park(root.id, 'Wait for a decision')
  const rejected = await scoper.tasks.stage(root.id, 'rejected', 'No longer needed')
  expect(rejected.task).toMatchObject({ state: 'failed', work: { stage: 'rejected' }, parked: null })
})

it('answers structured attention without skipping scope and closes it on rejection', async () => {
  const ctx = await setup({ parity: true })
  const { worker, scoper, approver } = ctx
  const root = await create(ctx)
  const draft: AttentionDraft = {
    kind: 'needs_input', question: 'Which route should we use?', context: 'Either route needs scope.',
    options: [
      { id: 'a', label: 'Route A', consequence: 'Use route A', next: 'resume' },
      { id: 'b', label: 'Route B', consequence: 'Use route B', next: 'resume' },
    ],
    revision: root.revision, evidence: [{ message: root.id, revision: root.revision }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), commit: 'a'.repeat(40),
  }
  await expect(worker.tasks.ask(root.id, { ...draft, options: [draft.options[0]!, { ...draft.options[1]!, next: 'fail' }] }))
    .rejects.toMatchObject(REQUIRED)
  const { attention } = await worker.tasks.ask(root.id, draft)
  const answer = await approver.tasks.answer(root.id, attention.id, { option: 'a', commit: draft.commit })
  expect(answer.task.task).toMatchObject({ state: 'waiting', claim: null, blocked: null, work: PROPOSED })
  expect(answer.attention).toMatchObject({ status: 'answered', receipt: { routedTo: 'waiting' } })
  await expect(worker.tasks.claim(root.id)).rejects.toMatchObject(STAGE_ERROR)
  const { attention: pending } = await worker.tasks.ask(root.id, draft)
  await scoper.tasks.stage(root.id, 'rejected', 'Do not proceed')
  expect((await worker.tasks.attention(root.id)).attention).toMatchObject({ id: pending.id, status: 'canceled' })
})

it('passes lifecycle and access-fence conformance instead of legacy queue conformance', async () => {
  const { scoper, scoperToken, handle, web } = await setup()
  expect(await scoper.discovery()).toMatchObject({ workLifecycle: 1, accessFence: 1 })
  const report = await conformance(scoper, {
    withHeaders: (headers) => handle(scoperToken, headers),
    principals: { project: 'prj_web', scoper: web },
  })
  expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
  expect(report.checks.some((check) => check.group === 'tasks')).toBe(false)
  const lifecycle = report.checks.filter((check) => check.group === 'work-lifecycle')
  expect(lifecycle).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "refuses scope and stage after revoking the scoper's grant", status: 'passed' }),
    expect.objectContaining({ name: 'does not land scope after a concurrent grant revocation answers', status: 'passed' }),
  ]))
  expect(lifecycle.every((check) => check.status === 'passed')).toBe(true)
})

it('runs the staged, network pause, registry, and attention conformance checks together', async () => {
  const { scoper, scoperToken, handle, web } = await setup({ parity: true })
  expect(await scoper.discovery()).toMatchObject({ workLifecycle: 1, accessFence: 1, agent_ops: true, task_attention: true })
  const report = await conformance(scoper, {
    networkPause: true,
    withHeaders: (headers) => handle(scoperToken, headers),
    principals: { project: 'prj_web', scoper: web },
  })
  expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
  for (const group of ['work-lifecycle', 'network-pause', 'agents', 'tasks']) {
    const checks = report.checks.filter((check) => check.group === group)
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.every((check) => check.status === 'passed')).toBe(true)
  }
})
