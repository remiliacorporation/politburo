import { expect, it, vi } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { bearer, BOARD_URL, board, localBoard, personToken, testBoard } from './harness.ts'

it('advertises claim holds in HTTP discovery and clamps a claim-next renewal', async ({ onTestFinished }) => {
  const local = localBoard()
  onTestFinished(() => local.close())
  const discovery = await local.fetch(new Request(BOARD_URL))
  expect(discovery.headers.get('x-board-task-claim-hold')).toBe('1')
  expect(await discovery.json()).not.toHaveProperty('task_claim_hold')
  const fetch = bearer((input, init) => local.fetch(new Request(input, init)), () => personToken())
  const team = board({ backend: http(BOARD_URL, { fetch }) }).as(null)
  expect(await team.discovery()).toMatchObject({ task_claim_hold: true })
  const { task } = await team.tasks.create('work', 'a fixed deadline')
  const claim = (await team.tasks.claim({ channel: 'work', lease: 30, hold: 60 }))!
  const end = claim.task.task?.claim?.holdUntil
  expect(Date.parse(end!) - Date.parse(claim.until)).toBe(30_000)
  expect(await claim.renew(300)).toMatchObject({ until: end, holdUntil: end })
  expect((await team.thread(task.id)).message.task?.claim).toMatchObject({ until: end, holdUntil: end })
})

it('expires on the board timer with reason hold at the hard end', async ({ onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const { task } = await team.tasks.create('work', 'a short hold')
  const { cursor } = await team.poll({ wait: 0 })
  const claim = await team.tasks.claim(task.id, { lease: 30, hold: 1 })
  expect(claim.until).toBe(claim.task.task?.claim?.holdUntil)
  await vi.waitFor(async () => {
    expect((await team.thread(task.id)).message.task?.state).toBe('ready')
  }, { timeout: 3000 })
  const { events } = await team.poll({ after: cursor, wait: 0 })
  expect(events.find((event) => event.type === 'task.expired')).toMatchObject({ payload: { id: task.id, reason: 'hold' } })
  await expect(claim.complete()).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
})

it.each([
  { hold: 1, reason: 'hold' },
  { hold: 60, reason: undefined },
])('records expiry before an owner blocks without a lease timer (hold $hold seconds)', async ({ hold, reason }) => {
  const team = testBoard() // no scheduler, as when the lease timer is lost
  const { task } = await team.tasks.create('work', 'an expired claim')
  const claim = await team.tasks.claim(task.id, { lease: 30, hold })
  const { cursor } = await team.poll({ wait: 0 })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(claim.until) + 1)
  try {
    await team.tasks.block(task.id, 'ready for review')
    const { events } = await team.poll({ after: cursor, wait: 0 })
    expect(events.map((event) => event.type)).toEqual(['task.expired', 'task.blocked'])
    expect(events[0]?.payload).toEqual({ id: task.id, thread: expect.any(String), epoch: claim.epoch, ...(reason ? { reason } : {}) })
  } finally {
    clock.mockRestore()
  }
})

it('rejects a hold above 86400 on both claim routes', async ({ onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const { task } = await team.tasks.create('work', 'an excessive hold')
  await expect(team.tasks.claim(task.id, { hold: 86401 })).rejects.toMatchObject({ status: 400 })
  await expect(team.tasks.claim({ channel: 'work', hold: 86401 })).rejects.toMatchObject({ status: 400 })
  expect((await team.thread(task.id)).message.task?.state).toBe('ready')
})

it('does not send a hold to an older HTTP board that would ignore it', async ({ onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const token = await personToken('u_ada')
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url.replace(/\/$/, '') === BOARD_URL) return Response.json({ version: '0.0.0' })
    request.headers.set('authorization', `Bearer ${token}`)
    if (request.method !== 'POST') return team.fetch(request)
    const body = await request.json()
    delete body.hold
    return team.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }))
  }
  const remote = board({ backend: http(BOARD_URL, { fetch }) })
  const { task } = await remote.tasks.create('work', 'no support for holds')
  await expect(remote.tasks.claim(task.id, { hold: 1 })).rejects.toMatchObject({ status: 501, code: 'no_claim_hold' })
  await expect(remote.tasks.claim({ channel: 'work', hold: 1 })).rejects.toMatchObject({ status: 501, code: 'no_claim_hold' })
  expect((await remote.thread(task.id)).message.task?.state).toBe('ready')
})

it('releases a claim when an older HTTP instance ignores the advertised hold', async ({ onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const token = await personToken('u_ada')
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url.replace(/\/$/, '') === BOARD_URL) return Response.json({ version: '0.0.0', task_claim_hold: true })
    request.headers.set('authorization', `Bearer ${token}`)
    if (!request.url.endsWith('/claim')) return team.fetch(request)
    const body = await request.json()
    delete body.hold
    return team.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body) }))
  }
  const remote = board({ backend: http(BOARD_URL, { fetch }) })
  const { task } = await remote.tasks.create('work', 'served by mixed versions')
  for (const attempt of [() => remote.tasks.claim(task.id, { hold: 1 }), () => remote.tasks.claim({ channel: 'work', hold: 1 })]) {
    await expect(attempt()).rejects.toMatchObject({ status: 501, code: 'no_claim_hold', origin: 'handle' })
    expect((await remote.thread(task.id)).message.task?.state).toBe('ready')
  }
})

it('refuses a hold on Vercel rather than falling back to an ordinary claim', async () => {
  const team = board({ backend: vercel({ team: 'team_test', fetch: async () => Response.json({}, { status: 404 }) }) })
  await expect(team.tasks.claim('msg_test_1', { hold: 1 })).rejects.toMatchObject({ status: 501, code: 'no_claim_hold' })
  await expect(team.tasks.claim({ channel: 'work', hold: 1 })).rejects.toMatchObject({ status: 501, code: 'no_claim_hold' })
})
