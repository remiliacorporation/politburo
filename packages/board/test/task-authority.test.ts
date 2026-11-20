import { createHash, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardEventView, MessageView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, board, caller, deploymentToken, localBoard, personToken } from './harness.ts'
import { serve } from './http.ts'

const ADA = 'vercel:user:u_ada'
const BO = 'vercel:user:u_bo'
const WEB = 'vercel:project:prj_web:production'
const WORKER = `${ADA}+worker`
const CLAIM_LOST = [409, 'claim_lost']
const FORBIDDEN = [403, 'forbidden']
const INVALID = [400, 'invalid_request']
const BLOCKED = [409, 'task_blocked']
const packet = { commit: 'c'.repeat(40), packetPath: 'handoffs/review.md', sha256: 'd'.repeat(64) }
const bindingFor = (principal = ADA, actor = WORKER) => ({
  controller: { principal: BO, actor: BO },
  owner: { principal, actor },
  provider: 'fixture-provider',
  model: 'fixture-model',
  session: 'session-1',
  branch: 'topic/review',
  worktree: '/fixture/worktrees/review',
  baseCommit: 'a'.repeat(40),
})

function doesNotExpose(view: unknown, ...secrets: string[]) {
  const serialized = JSON.stringify(view)
  for (const secret of secrets) {
    expect(serialized.includes(secret), 'the public view exposes a secret').toBe(false)
    expect(serialized.includes(createHash('sha256').update(secret).digest('hex')), 'the public view exposes a secret hash').toBe(false)
  }
}

type Call = ReturnType<typeof caller>
type Answer = Awaited<ReturnType<Call>>
type Proof = { epoch: number; token: string }
const outcome = ({ status, body }: Answer) => [status, body.error?.code]
const proofOf = ({ epoch, token }: Proof) => ({ epoch, token })
const write = (call: Call, id: string, action: string, body?: unknown) => call('POST', `/tasks/${id}/${action}`, body)
const read = async (call: Call, id: string): Promise<MessageView> => {
  const response = await call('GET', `/messages/${id}`)
  expect(response.status).toBe(200)
  return response.body.message
}
const make = async (call: Call, text: string, extra = {}) => {
  const response = await call('POST', '/tasks', { channel: 'work', text, ...extra })
  expect(outcome(response)).toEqual([201, undefined])
  return response.body.task.id as string
}
const take = async (call: Call, id: string, input = {}) => {
  const response = await write(call, id, 'claim', input)
  expect(outcome(response)).toEqual([200, undefined])
  return response.body.claim as Proof
}
const events = async (call: Call, id: string): Promise<BoardEventView[]> => {
  const page = await call('GET', '/events?after=0&channel=work&all=1')
  expect(page.status).toBe(200)
  return (page.body.events as BoardEventView[]).filter((event) => event.message?.id === id)
}

let team: ReturnType<typeof localBoard>
let ada: Call, bo: Call, worker: Call, web: Call
let adaToken: string
beforeEach(async () => {
  team = localBoard()
  const [adaJwt, boJwt, webJwt] = await Promise.all([personToken('u_ada'), personToken('u_bo'), deploymentToken('web', 'prj_web')])
  adaToken = adaJwt
  ada = caller(team.fetch, adaJwt)
  bo = caller(team.fetch, boJwt)
  worker = caller(team.fetch, adaJwt, { 'x-board-profile': 'worker' })
  web = caller(team.fetch, webJwt)
  await team.createGrant({ principals: [{ kind: 'project', project: 'prj_web' }], can: { work: 'all' } })
})
afterEach(() => team.close())

it('claims the highest priority unparked work after a network pause, and fences an older bound handoff', async () => {
  const low = await make(ada, 'lower priority', { priority: 'low' })
  const high = await make(ada, 'higher priority', { priority: 'high' })
  const urgent = await make(ada, 'parked urgent task', { priority: 'urgent' })
  expect(outcome(await write(bo, urgent, 'park', { reason: 'hold this task only' }))).toEqual([200, undefined])
  const before = await take(worker, high, { binding: bindingFor() })
  const nextBinding = { ...bindingFor(), session: 'after-resume' }
  const claimNext = () => worker('POST', '/tasks/claim-bound', { channel: 'work', binding: nextBinding })

  expect(outcome(await bo('POST', '/control/pause', { reason: 'stop admitting work' }))).toEqual([200, undefined])
  expect(outcome(await claimNext())).toEqual([409, 'board_paused'])
  expect(outcome(await bo('POST', '/control/resume', { reason: 'admit new claims' }))).toEqual([200, undefined])
  expect(outcome(await write(worker, high, 'handoff', { ...proofOf(before), ...packet }))).toEqual(CLAIM_LOST)

  const taken = await claimNext()
  expect(outcome(taken)).toEqual([200, undefined])
  expect(taken.body.task.id).toBe(high)
  expect(taken.body.claim.binding).toEqual(nextBinding)
  const proof = proofOf(taken.body.claim)
  expect(proof.epoch).toBe(before.epoch + 1)
  const handoff = await write(worker, high, 'handoff', { ...proof, ...packet })
  expect(outcome(handoff)).toEqual([200, undefined])
  expect(handoff.body.task.task.handoff).toMatchObject({ ...packet, generation: proof.epoch })
  expect((await read(ada, low)).task?.state).toBe('ready')
  expect((await read(ada, urgent)).task?.state).toBe('blocked')
})

describe('operator parking', () => {
  it('takes a verified bare person with manage in that channel, and records each operator and reason', async () => {
    const id = await make(ada, 'review the release')
    const narrow = caller(team.fetch, adaToken, { 'x-board-can': 'work=read,label;elsewhere=manage' })
    const hidden = caller(team.fetch, adaToken, { 'x-board-can': 'elsewhere=all' })
    const scoped = caller(team.fetch, adaToken, { 'x-board-can': 'work=all' })
    const impostor = caller(team.fetch, 'not-a-valid-jwt')
    const reason = 'need a quiet deployment window'
    for (const [kind, call] of [['profile', worker], ['deployment with manage', web], ['person without manage here', narrow]] as const) {
      expect(outcome(await write(call, id, 'park', { reason })), kind).toEqual(FORBIDDEN)
    }
    expect((await write(hidden, id, 'park', { reason })).status).toBe(404)
    expect((await write(impostor, id, 'park', { reason })).status).toBe(401)
    await expect(team.tasks.park(id, reason)).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(outcome(await write(bo, id, 'park', { reason, by: { actor: ADA, principal: ADA } }))).toEqual(INVALID)
    expect(outcome(await write(bo, id, 'park', { reason: '' }))).toEqual(INVALID)
    expect((await read(ada, id)).task?.state).toBe('ready')

    const park = await write(bo, id, 'park', { reason })
    const parkedBy = { principal: BO, actor: BO, profile: null }
    expect(park.status).toBe(200)
    expect(park.body.task).toMatchObject({ labels: { 'board.task': 'blocked' }, task: { state: 'blocked', parked: { reason, by: parkedBy, previous: 'ready' } } })
    expect((await write(bo, id, 'park', { reason: 'cannot overwrite the first reason' })).status).toBe(200)
    expect((await read(ada, id)).task?.parked?.reason).toBe(reason)
    for (const call of [worker, web, narrow]) expect(outcome(await write(call, id, 'unpark', { reason: 'not allowed' }))).toEqual(FORBIDDEN)
    await expect(team.tasks.unpark(id, 'not allowed')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(outcome(await write(ada, id, 'unblock'))).toEqual(BLOCKED)
    expect(outcome(await write(ada, id, 'block', { reason: 'cannot replace a park' }))).toEqual(BLOCKED)
    expect(outcome(await write(worker, id, 'claim', {}))).toEqual(BLOCKED)
    expect((await worker('POST', '/tasks/claim', { channel: 'work' })).body.task).toBeNull()
    const resumedFor = 'deployment window is open'
    const resumed = await write(scoped, id, 'unpark', { reason: resumedFor })
    expect(resumed.status).toBe(200)
    expect(resumed.body.task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', claim: null } })
    expect((await read(ada, id)).task?.parked ?? null).toBeNull()
    expect((await write(scoped, id, 'unpark', { reason: 'redundant' })).status).toBe(200)
    expect((await events(ada, id)).filter(({ type }) => type === 'task.parked' || type === 'task.unparked')).toMatchObject([
      { type: 'task.parked', actor: { id: BO }, payload: { id, reason, by: parkedBy, previous: 'ready' } },
      { type: 'task.unparked', actor: { id: ADA }, payload: { id, reason: resumedFor, by: { principal: ADA, actor: ADA, profile: null } } },
    ])

    const legacy = await make(ada, 'ask for approval')
    expect((await write(ada, legacy, 'block', { reason: 'still needs approval' })).status).toBe(200)
    expect(outcome(await write(bo, legacy, 'park', { reason }))).toEqual(BLOCKED)
    expect((await write(bo, legacy, 'unpark', { reason: resumedFor })).body.task.task.state).toBe('blocked')
    expect((await write(ada, legacy, 'unblock')).body.task.task.state).toBe('ready')
  })

  it('rechecks prerequisites at unpark and never readies a task while parked', async () => {
    const prereq = await make(ada, 'build')
    const id = await make(ada, 'package', { needs: [prereq] })
    expect((await write(bo, id, 'park', { reason: 'wait for review' })).body.task.task.parked.previous).toBe('waiting')
    expect((await write(bo, id, 'unpark', { reason: 'reviewed' })).body.task.task.state).toBe('waiting')
    expect(outcome(await write(worker, id, 'claim', {}))).toEqual([409, 'task_waiting'])
    expect((await write(bo, id, 'park', { reason: 'hold for logistics' })).status).toBe(200)
    expect((await write(worker, prereq, 'complete', proofOf(await take(worker, prereq)))).status).toBe(200)
    expect((await read(ada, id)).task?.state).toBe('blocked')
    expect((await worker('POST', '/tasks/claim', { channel: 'work' })).body.task).toBeNull()
    expect((await write(bo, id, 'unpark', { reason: 'go ahead' })).body.task.task.state).toBe('ready')
    expect((await take(worker, id)).epoch).toBe(1)
  })

  it('does not acknowledge a non-owner edit when an operator unparks', async () => {
    const root = await bo('POST', '/messages', { channel: 'work', text: 'review the release' })
    expect(root.status).toBe(201)
    const id = root.body.message.id as string
    expect((await ada('POST', '/tasks', { re: id })).status).toBe(201)
    expect((await write(ada, id, 'park', { reason: 'hold the launch' })).status).toBe(200)
    expect((await bo('POST', `/messages/${id}/edit`, { text: 'review the revised release' })).status).toBe(200)
    const resumed = await write(ada, id, 'unpark', { reason: 'launch window open' })
    expect(resumed.status).toBe(200)
    expect(resumed.body.task.task).toMatchObject({ state: 'blocked', blocked: { kind: 'edited' } })
    expect(resumed.body.task.task.parked ?? null).toBeNull()
    expect(outcome(await write(worker, id, 'claim', {}))).toEqual(BLOCKED)
    expect((await write(ada, id, 'unblock')).body.task.task.state).toBe('ready')
  })

  it('serializes a park racing a claim, and a park racing settlement', async () => {
    const id = await make(ada, 'claim race')
    const [park, claim] = await Promise.all([write(bo, id, 'park', { reason: 'hold before shipping' }), write(worker, id, 'claim', { binding: bindingFor() })])
    expect(park.status).toBe(200)
    expect((await read(ada, id)).task).toMatchObject({ state: 'blocked', claim: null })
    if (claim.status === 200) {
      expect(park.body.task.task.parked.previous).toBe('claimed')
      expect(outcome(await write(worker, id, 'complete', proofOf(claim.body.claim)))).toEqual(CLAIM_LOST)
    } else {
      expect(outcome(claim)).toEqual(BLOCKED)
      expect(park.body.task.task.parked.previous).toBe('ready')
    }
    expect((await events(ada, id)).filter(({ type }) => type === 'task.claimed' || type === 'task.parked').map(({ type }) => type)).toEqual(
      claim.status === 200 ? ['task.claimed', 'task.parked'] : ['task.parked'],
    )

    const second = await make(ada, 'settlement race')
    const held = await take(worker, second)
    const [p, complete] = await Promise.all([write(bo, second, 'park', { reason: 'check the release' }), write(worker, second, 'complete', proofOf(held))])
    if (p.status === 200) expect(outcome(complete)).toEqual(CLAIM_LOST)
    else {
      expect(outcome(p)).toEqual([409, 'task_finished'])
      expect(complete.status).toBe(200)
    }
    expect((await read(ada, second)).task?.state).toBe(p.status === 200 ? 'blocked' : 'completed')
    expect((await events(ada, second)).filter(({ type }) => type === 'task.completed' || type === 'task.parked').map(({ type }) => type)).toEqual([
      p.status === 200 ? 'task.parked' : 'task.completed',
    ])
  })
})

it('checks binding shape and owner against the claimant on all claim entry points', async () => {
  const id = await make(ada, 'validate the assignment')
  const binding = bindingFor()
  for (const invalid of [
    { ...binding, provider: '' },
    { ...binding, session: undefined },
    { ...binding, branch: 'topic\nreview' },
    { ...binding, baseCommit: 'a1b2c3' },
    { ...binding, baseCommit: 'A'.repeat(40) },
    { ...binding, owner: { ...binding.owner, by: BO } },
    { ...binding, controller: { principal: BO, actor: WORKER } },
    { ...binding, generation: 40 },
  ]) expect(outcome(await write(worker, id, 'claim', { binding: invalid }))).toEqual(INVALID)
  const forged = bindingFor(BO, BO)
  for (const attempt of [
    () => write(worker, id, 'claim', { binding: forged }),
    () => worker('POST', '/tasks/claim', { channel: 'work', binding: forged }),
    () => worker('POST', '/tasks', { channel: 'work', text: 'do not create me', claim: true, binding: forged }),
  ]) expect((await attempt()).status).toBe(403)
  expect(outcome(await worker('POST', '/tasks', { channel: 'work', text: 'do not create me without a claim', binding }))).toEqual(INVALID)
  expect((await read(ada, id)).task).toMatchObject({ state: 'ready', epoch: 0, claim: null })
  const taken = await worker('POST', '/tasks/claim', { channel: 'work', binding })
  expect(outcome(taken)).toEqual([200, undefined])
  expect(taken.body.task.id).toBe(id)
  expect(taken.body.claim.binding).toEqual(binding)
  expect(taken.body.task.task.claim.binding).toEqual(binding)
  const made = await web('POST', '/tasks', { channel: 'work', text: 'deployment claim', claim: true, binding: bindingFor(WEB, WEB) })
  expect(outcome(made)).toEqual([201, undefined])
  expect(made.body.claim.binding.owner).toEqual({ principal: WEB, actor: WEB })
  const thread = await bo('POST', '/messages', { channel: 'work', text: 'adopt this thread' })
  expect(thread.status).toBe(201)
  const adopted = await bo('POST', '/tasks', { re: thread.body.message.id, claim: true, binding: forged })
  expect(adopted.status).toBe(201)
  expect(adopted.body.claim.binding).toEqual(forged)
})

it.each(['unbound', 'bound'])('recovers a live %s create-and-claim with the same client id and token', async (kind) => {
  expect((await bo('POST', '/control/pause', { reason: 'stop admitting work' })).status).toBe(200)
  const resumed = await bo('POST', '/control/resume', { reason: 'admit new claims' })
  expect(resumed).toEqual({ status: 200, body: { paused: false, pauseEpoch: 1 } })
  const binding = kind === 'bound' ? bindingFor() : undefined
  const path = binding ? '/tasks/create-bound' : '/tasks'
  const token = randomBytes(32).toString('base64url')
  const input = { channel: 'work', text: 'review the release', id: 'review-release', claim: true, token, binding }
  const made = await worker('POST', path, input)
  expect(made.status).toBe(201)
  const id = made.body.task.id
  expect(made.body.claim).toMatchObject({ token, pauseEpoch: resumed.body.pauseEpoch, until: expect.any(String), epoch: expect.any(Number) })
  expect(made.body.claim.binding).toEqual(binding)

  const replay = await worker('POST', path, input)
  expect([200, 201]).toContain(replay.status)
  expect(replay.body.task.id).toBe(id)
  expect(replay.body.claim).toEqual(made.body.claim)
  // The stored claim is visible in the feed, without the proof token.
  expect((await events(ada, id)).filter(({ type }) => type === 'task.claimed')).toMatchObject([
    { payload: { epoch: made.body.claim.epoch, pauseEpoch: made.body.claim.pauseEpoch } },
  ])

  const renewed = await write(worker, id, 'renew', { ...proofOf(replay.body.claim), lease: 60 })
  expect(renewed.status).toBe(200)
  expect(renewed.body.until).not.toBe(made.body.claim.until)
  const again = await worker('POST', path, input)
  expect(again.body.claim).toEqual({ ...made.body.claim, until: renewed.body.until })
  const wrongToken = await worker('POST', path, { ...input, token: randomBytes(32).toString('base64url') })
  expect([200, 201]).toContain(wrongToken.status)
  expect(wrongToken.body.claim).toBeUndefined()
  if (binding) {
    const different = await worker('POST', path, { ...input, binding: { ...binding, session: 'different' } })
    expect(outcome(different)).toEqual([409, 'binding_mismatch'])
  }
  expect((await write(worker, id, 'complete', proofOf(again.body.claim))).body.task.task.state).toBe('completed')
  const completed = await worker('POST', path, input)
  expect([200, 201]).toContain(completed.status)
  expect(completed.body.claim).toBeUndefined()
})

it.each(['release', 'pause and resume', 'lease expiry'])('does not recover a create-and-claim after %s', async (end) => {
  const token = randomBytes(32).toString('base64url')
  const input = { channel: 'work', text: 'review the release', id: 'review-release', claim: true, token }
  const create = () => worker('POST', '/tasks', input)
  const made = await create()
  expect(made.status).toBe(201)
  const id = made.body.task.id
  const expectNoClaim = async () => {
    const replay = await create()
    expect([200, 201]).toContain(replay.status)
    expect(replay.body.task.id).toBe(id)
    expect(replay.body.claim).toBeUndefined()
  }
  if (end === 'release') {
    expect((await write(worker, id, 'release', proofOf(made.body.claim))).status).toBe(200)
    await expectNoClaim()
    const replacement = await take(worker, id, { token })
    expect(replacement.epoch).toBeGreaterThan(made.body.claim.epoch)
  } else if (end === 'pause and resume') {
    expect((await bo('POST', '/control/pause', { reason: 'stop admitting work' })).status).toBe(200)
    expect((await bo('POST', '/control/resume', { reason: 'admit new claims' })).status).toBe(200)
  } else {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(made.body.claim.until) + 1)
  }
  try {
    await expectNoClaim()
  } finally {
    if (end === 'lease expiry') vi.useRealTimers()
  }
})

it('fences all proof writes by generation even with the same actor and token after a park', async () => {
  const id = await make(ada, 'resume work with a new generation')
  const token = randomBytes(32).toString('base64url')
  const binding = bindingFor()
  expect((await bo('POST', '/control/pause', { reason: 'halt new work' })).status).toBe(200)
  const resumed = await bo('POST', '/control/resume', { reason: 'admit new claims' })
  expect(resumed).toEqual({ status: 200, body: { paused: false, pauseEpoch: 1 } })
  const claimed = await write(worker, id, 'claim-bound', { token, binding })
  expect(claimed.status).toBe(200)
  const first = claimed.body.claim
  expect(first).toMatchObject({ token, binding, pauseEpoch: resumed.body.pauseEpoch })
  for (const retry of [{ token }, { token, binding }]) {
    const repeated = await write(worker, id, 'claim', retry)
    expect(repeated.status).toBe(200)
    expect(repeated.body.claim).toEqual(first)
  }
  expect(outcome(await write(worker, id, 'claim', { token, binding: { ...binding, session: 'different' } }))).toEqual([409, 'binding_mismatch'])
  // The verified principal can differ even when the actor ID is indistinguishable in text.
  const lookalike = caller(team.fetch, await personToken('u_ada+worker'))
  expect((await lookalike('GET', '/me')).body).toMatchObject({ actor: WORKER, principal: WORKER, profile: null })
  for (const call of [bo, ada, lookalike]) {
    expect(outcome(await write(call, id, 'claim', { token }))).toEqual([409, 'task_claimed'])
    expect(outcome(await write(call, id, 'handoff', { ...proofOf(first), ...packet }))).toEqual(CLAIM_LOST)
    expect(outcome(await write(call, id, 'complete', proofOf(first)))).toEqual(CLAIM_LOST)
  }
  const parked = await write(bo, id, 'park', { reason: 'stop this worker' })
  expect(parked.body.task.task).toMatchObject({ state: 'blocked', claim: null, parked: { previous: 'claimed' } })
  expect(outcome(await write(worker, id, 'renew', proofOf(first)))).toEqual(CLAIM_LOST)
  expect((await write(bo, id, 'unpark', { reason: 'new worker can proceed' })).body.task.task).toMatchObject({ state: 'ready', claim: null })
  expect(outcome(await write(worker, id, 'complete', proofOf(first)))).toEqual(CLAIM_LOST)
  const secondBinding = { ...binding, session: 'session-2' }
  const second = await take(worker, id, { token, binding: secondBinding })
  expect(second.epoch).toBe(first.epoch + 1)
  expect(second.token === first.token, 'both generations must use the same proof token').toBe(true)
  for (const [action, extra] of [
    ['renew', { lease: 60 }], ['release', {}], ['complete', {}], ['fail', { reason: 'stale' }],
    ['block', { reason: 'stale' }], ['handoff', packet],
  ] as const) expect(outcome(await write(worker, id, action, { ...proofOf(first), ...extra })), action).toEqual(CLAIM_LOST)
  const readOnlyWorker = caller(team.fetch, adaToken, { 'x-board-profile': 'worker', 'x-board-can': 'work=read' })
  expect(outcome(await write(readOnlyWorker, id, 'handoff', { ...proofOf(second), ...packet }))).toEqual(FORBIDDEN)
  expect(outcome(await write(readOnlyWorker, id, 'complete', proofOf(second)))).toEqual(FORBIDDEN)
  expect(outcome(await write(worker, id, 'handoff', { epoch: second.epoch, token: 'wrong-proof', ...packet }))).toEqual(CLAIM_LOST)
  const view = await read(bo, id)
  expect(view.task).toMatchObject({ state: 'claimed', epoch: second.epoch, claim: { actor: WORKER, binding: secondBinding } })
  const feed = await events(bo, id)
  expect(feed.filter(({ type }) => type === 'task.claimed')).toMatchObject([
    { payload: { epoch: first.epoch, pauseEpoch: first.pauseEpoch, binding, by: { principal: ADA, actor: WORKER, profile: 'worker' } } },
    { payload: { epoch: second.epoch, pauseEpoch: first.pauseEpoch, binding: secondBinding, by: { principal: ADA, actor: WORKER, profile: 'worker' } } },
  ])
  doesNotExpose([view, feed], token)
  expect((await write(worker, id, 'handoff', { ...proofOf(second), ...packet })).status).toBe(200)
  expect((await write(worker, id, 'complete', proofOf(second))).body.task.task.state).toBe('completed')
})

it('checks handoff metadata at the HTTP route before writing a packet', async () => {
  const id = await make(ada, 'validate a handoff')
  const proof = proofOf(await take(worker, id))
  for (const invalid of [
    { commit: 'abc123' }, { sha256: 'D'.repeat(64) }, { sha256: 'd'.repeat(63) },
    { packetPath: '/outside.md' }, { packetPath: '../outside.md' }, { packetPath: 'docs/../outside.md' },
    { packetPath: 'docs\\review.md' }, { packetPath: '' }, { by: BO }, { at: '2000-01-01T00:00:00Z' }, { generation: 42 },
  ]) expect(outcome(await write(worker, id, 'handoff', { ...proof, ...packet, ...invalid }))).toEqual(INVALID)
  expect(outcome(await write(worker, id, 'handoff', { ...proof, ...packet, supersedes: 'not-a-handoff' }))).toEqual([409, 'handoff_conflict'])
  expect((await read(ada, id)).task?.handoff ?? null).toBeNull()
  expect((await events(ada, id)).some(({ type }) => type === 'task.handoff')).toBe(false)
  expect((await write(worker, id, 'handoff', { ...proof, ...packet, commit: 'e'.repeat(64) })).status).toBe(200)
})

it('publishes one immutable supersession over HTTP, even when two replacements race', async () => {
  // Bring both real HTTP submissions to the board together, independent of socket arrival order.
  const pair = Promise.withResolvers<void>()
  let arrivals = 0
  const server = await serve(async (request) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/handoff') && (await request.clone().json()).supersedes !== undefined) {
      if (++arrivals === 2) pair.resolve()
      await pair.promise
    }
    return team.fetch(request)
  })
  try {
    // team uses a fixed audience; the remote client connects to loopback but requests that same board.
    const url = `${server.origin}/api/board`
    const operator = board({ backend: http(url, { fetch: bearer(fetch, adaToken) }) }).as(null)
    const agent = operator.as('worker')
    const { task } = await operator.tasks.create('work', { text: 'review these changes' })
    const id = task.id
    const parked = await operator.tasks.park(id, 'check the change first')
    expect(parked.task?.state).toBe('blocked')
    expect((await operator.tasks.unpark(id, 'review complete')).task?.state).toBe('ready')
    const claim = await agent.tasks.claim(id, { binding: bindingFor() })
    expect(claim.binding).toEqual(bindingFor())
    const first = (await claim.handoff(packet)).task?.handoff
    expect(first).toMatchObject({ ...packet, generation: claim.epoch, by: { principal: ADA, actor: WORKER, profile: 'worker' } })
    expect(Number.isFinite(Date.parse(first!.at))).toBe(true)
    await expect(claim.handoff({ ...packet, commit: 'e'.repeat(40) })).rejects.toMatchObject({ status: 409, code: 'handoff_conflict' })
    const inputs = ['e', 'f'].map((digit) => ({ ...packet, commit: digit.repeat(40), supersedes: first!.id }))
    const racing = await Promise.allSettled(inputs.map((next) => agent.tasks.handoff(id, { ...proofOf(claim), ...next })))
    expect(racing.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const loser = racing.find((result) => result.status === 'rejected')!
    expect(loser.reason).toMatchObject({ status: 409, code: 'handoff_conflict' })
    const latest = (await operator.thread(id)).message.task?.handoff
    expect(latest).toMatchObject({ ...inputs[racing.findIndex((result) => result.status === 'fulfilled')], generation: claim.epoch })
    expect(latest!.id).not.toBe(first!.id)
    const history = (await events(ada, id)).filter(({ type }) => type === 'task.handoff')
    expect(history).toMatchObject([
      { actor: { id: WORKER }, payload: { id, handoff: first } },
      { actor: { id: WORKER }, payload: { id, handoff: latest } },
    ])
    doesNotExpose(history, claim.token)
    expect((await claim.complete()).task?.handoff).toEqual(latest)
  } finally {
    await server.close()
  }
})
