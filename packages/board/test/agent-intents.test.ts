import { expect, it, vi } from 'vitest'
import type { AgentIntent, AgentRun } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { bearer, board, BOARD_URL, caller, localBoard, personToken, testBoard, workflowToken } from './harness.ts'

const config = { channel: 'work', role: 'reviewer', harness: 'shell' } as const
const stale = { state: 'not_confirmed' }
const conflict = { status: 409 }
const hidden = { status: 404 }
const noOps = { status: 501, code: 'no_agent_ops' }
const command = { verb: 'pause', generation: 1, ttlSeconds: 60, requestId: 'pause' } as const
const intentPath = (id: string) => `/ops/agents/${encodeURIComponent(id)}/intents`
const receiptPath = (id: string, action: 'take' | 'report') => `/ops/intents/${encodeURIComponent(id)}/${action}`

function via(fetch: (request: Request) => Promise<Response>, token: string) {
  return board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)
}

/** An older mount backed by a real board for the registry and the rest of the protocol. */
function registryOnlyMount(boardFetch: (request: Request) => Promise<Response>) {
  const attempted: string[] = []
  const mount = new URL(BOARD_URL).pathname
  const discovery = async () => {
    const { agent_intents: _, ...info } = await (await boardFetch(new Request(BOARD_URL))).json()
    return Response.json(info)
  }
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname.slice(mount.length).replace(/\/$/, '')
    if (path === '') return discovery()
    if (/^\/ops\/(?:agents\/[^/]+\/intents$|intents(?:\/|$)|health\/)/.test(path)) {
      attempted.push(`${request.method} ${path}`)
      // Old mounts return discovery with 200 for an unknown GET.
      if (request.method === 'GET') return discovery()
      return Response.json({ error: { code: 'not_found', message: 'no such route' } }, { status: 404 })
    }
    return boardFetch(request)
  }
  return { fetch, attempted }
}

async function registryOnly(onTestFinished: (cleanup: () => Promise<void>) => void) {
  const team = localBoard({ agentOps: true })
  onTestFinished(() => team.close())
  const { fetch, attempted } = registryOnlyMount(team.fetch)
  return { client: via(fetch, await personToken()), attempted }
}

// Only replace Date; HTTP, store concurrency and scheduler timers still run normally.
function clock(onTestFinished: (cleanup: () => void) => void) {
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => { vi.useRealTimers() })
  return (ms: number) => vi.setSystemTime(Date.now() + ms)
}

async function fixture(freshness = 5) {
  const team = testBoard({ agentOps: true, agentHealthFreshnessSeconds: freshness })
  const token = await personToken()
  const client = via(team.fetch, token)
  const worker = client.as('worker')
  const agent = await worker.agents.register(config)
  return { team, token, client, worker, agent }
}

async function runFixture(freshness?: number, synced = false) {
  const configured = await fixture(freshness)
  const { client, worker, agent } = configured
  if (synced) await client.register({ watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
  const { task } = synced
    ? await client.tasks.create({ re: (await client.syncImport({
        op: 'post', from: 'slack', channel: config.channel, text: 'a synced run to probe', noSync: true,
        author: { id: 'slack:user:U1', handle: 'worker', name: 'Worker', avatar: null, isBot: false },
      })).message! })
    : await client.tasks.create(config.channel, 'a run to probe')
  const claim = await worker.tasks.claim(task.id, { lease: 30 })
  const run: AgentRun = { task: task.id, epoch: claim.epoch }
  const issue = async (requestId: string, ttlSeconds = 30) => (await client.agents.issueIntent(agent.id, {
    verb: 'status', run, generation: agent.generation, requestId, ttlSeconds,
  })).intents[0]!
  const take = (intent: AgentIntent) => worker.agents.takeIntent(intent.id, agent.generation)
  const report = (intent: AgentIntent, outcome: 'running' | 'not_running' | 'unknown' = 'running') => worker.agents.reportIntent(intent.id, agent.generation, outcome)
  return { ...configured, task, claim, run, issue, take, report, health: () => client.agents.health(task.id) }
}

it('hides intents and health from unauthorized callers and authors receipts from verified identity', async () => {
  const { team, client, token, worker, agent, task, issue } = await runFixture()
  const intent = await issue('bound-probe')
  const otherPrincipal = via(team.fetch, await personToken('u_other')).as('worker')
  const hiddenChannel = worker.as('worker', { can: 'elsewhere=all' })
  const reader = worker.as('worker', { can: 'work=read' })
  const recipient = worker.as('worker', { can: 'work=read,post' })
  const send = caller(team.fetch, token, { 'x-board-profile': 'worker' })

  expect(intent.by).toMatchObject({ principal: 'vercel:user:u_julian', profile: null })
  expect(intent).toMatchObject({ state: 'pending', taken: null, report: null })
  expect(await send('POST', intentPath(agent.id), { ...command, by: { principal: 'forged' } })).toMatchObject({ status: 400 })
  await expect(hiddenChannel.agents.intents(agent.id)).rejects.toMatchObject(hidden)
  await expect(hiddenChannel.agents.health(task.id)).rejects.toMatchObject(hidden)
  await expect(hiddenChannel.agents.issueIntent(agent.id, { ...command, generation: 99 })).rejects.toMatchObject(hidden)
  await expect(client.as('other', { can: 'work=read' }).agents.intents(agent.id)).rejects.toMatchObject(hidden)
  expect((await reader.agents.intents(agent.id)).intents.map(({ id }) => id)).toEqual([intent.id])
  for (const mismatched of [otherPrincipal, client.as('other'), hiddenChannel]) {
    // Even stale generation must not hint at an intent the caller cannot take or report.
    await expect(mismatched.agents.takeIntent(intent.id, 99)).rejects.toMatchObject(hidden)
    await expect(mismatched.agents.reportIntent(intent.id, 99, 'running')).rejects.toMatchObject(hidden)
  }
  await expect(reader.agents.takeIntent(intent.id, 1)).rejects.toMatchObject({ status: 403 })
  await expect(recipient.agents.takeIntent(intent.id, 99)).rejects.toMatchObject(conflict)
  await expect(recipient.agents.reportIntent(intent.id, 1, 'running')).rejects.toMatchObject(conflict)
  expect(await send('POST', receiptPath(intent.id, 'take'), { generation: 1, at: '2000-01-01T00:00:00Z' })).toMatchObject({ status: 400 })
  const from = Date.now()
  const taken = await recipient.agents.takeIntent(intent.id, 1)
  expect(taken.taken).toMatchObject({ generation: 1, by: { principal: 'vercel:user:u_julian', profile: 'worker' } })
  expect(Date.parse(taken.taken!.at)).toBeGreaterThanOrEqual(from)
  expect((await recipient.agents.intents(agent.id)).intents).toEqual([])
  expect(await send('POST', receiptPath(intent.id, 'report'), { generation: 1, outcome: 'running', by: intent.by })).toMatchObject({ status: 400 })
  const reported = await recipient.agents.reportIntent(intent.id, 1, 'running')
  expect(reported.report).toMatchObject({ generation: 1, by: taken.taken!.by, outcome: 'running' })
  expect(Date.parse(reported.report!.at)).toBeGreaterThanOrEqual(Date.parse(taken.taken!.at))
  expect(Date.parse(reported.report!.at)).toBeLessThanOrEqual(Date.now())
  expect(await recipient.agents.reportIntent(intent.id, 1, 'running')).toEqual(reported)
  await expect(recipient.agents.reportIntent(intent.id, 1, 'not_running')).rejects.toMatchObject(conflict)
})

it('requires a positive status report on the exact current claim binding and epoch', async () => {
  const { client, worker, agent, task, run, issue, take, report, claim, health } = await runFixture(undefined, true)
  const other = await client.as('other').agents.register(config)
  const check = { ...command, verb: 'status', ttlSeconds: 30, requestId: 'wrong-binding', run } as const
  await expect(client.agents.issueIntent(other.id, check)).rejects.toMatchObject(hidden)
  await expect(client.agents.issueIntent(agent.id, { ...check, run: { ...run, epoch: run.epoch + 1 } })).rejects.toMatchObject(conflict)
  await expect(client.agents.issueIntent(agent.id, { ...check, verb: 'pause' })).rejects.toMatchObject({ status: 400 })
  await expect(client.agents.issueIntent(agent.id, { ...check, ttlSeconds: 31 })).rejects.toMatchObject({ status: 400 })
  expect(await health()).toEqual(stale)
  await worker.agents.heartbeat(agent.id, 1)
  expect(await health()).toEqual(stale)
  const ordinary = (await client.agents.issueIntent(agent.id, { ...command, verb: 'status' })).intents[0]!
  await take(ordinary)
  await worker.agents.reportIntent(ordinary.id, 1, 'ok')
  expect(await health()).toEqual(stale)

  const first = await issue('first-run')
  const late = await issue('after-first-claim')
  await take(first)
  await take(late)
  await expect(worker.agents.reportIntent(first.id, 1, 'ok')).rejects.toMatchObject({ status: 400 })
  expect(await health()).toEqual(stale)
  await report(first)
  expect(await health()).toMatchObject({ state: 'working' })
  await claim.release()
  expect(await health()).toEqual(stale)
  const next = await worker.tasks.claim(task.id)
  expect(next.epoch).toBeGreaterThan(run.epoch)
  await expect(report(late)).rejects.toMatchObject(conflict)
  expect(await health()).toEqual(stale)
})

it.for(['issue', 'take', 'report'] as const)('rejects run probe %s after a pause and resume', async (action, { onTestFinished }) => {
  clock(onTestFinished)
  const { client, issue, take, report } = await runFixture()
  const probe = action === 'issue' ? null : await issue(`before-pause-${action}`)
  if (action === 'report') await take(probe!)
  await client.pause('fence active runs')
  await client.resume('allow new runs')

  const attempt = action === 'issue' ? issue('after-resume') : action === 'take' ? take(probe!) : report(probe!)
  await expect(attempt).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
})

it('omits a pending run probe fenced by a board pause, even after resume', async ({ onTestFinished }) => {
  clock(onTestFinished)
  const { client, worker, agent, task, issue, take } = await runFixture()
  const probe = await issue('before-pause')
  const { intents: [ordinary] } = await client.agents.issueIntent(agent.id, command)
  const listed = async () => (await worker.agents.intents(agent.id)).intents.map(({ id }) => id)
  expect(await listed()).toEqual([probe.id, ordinary!.id])

  await client.pause('fence active runs')
  await expect(take(probe)).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  expect(await listed()).toEqual([ordinary!.id])

  await client.resume('allow new runs')
  expect(await listed()).toEqual([ordinary!.id])

  const claim = await worker.tasks.claim(task.id)
  await expect(take(probe)).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  expect(await listed()).toEqual([ordinary!.id])
  const { intents: [fresh] } = await client.agents.issueIntent(agent.id, {
    verb: 'status', run: { task: task.id, epoch: claim.epoch }, generation: agent.generation, requestId: 'new-claim', ttlSeconds: 30,
  })
  expect(await listed()).toEqual([ordinary!.id, fresh!.id])
})

it('omits a pending run probe after its claim is released', async () => {
  const { worker, agent, claim, issue, take } = await runFixture()
  const probe = await issue('before-release')
  expect((await worker.agents.intents(agent.id)).intents.map(({ id }) => id)).toEqual([probe.id])

  await claim.release()
  await expect(take(probe)).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  expect((await worker.agents.intents(agent.id)).intents).toEqual([])
})

it('omits a pending run probe after its lease expires', async ({ onTestFinished }) => {
  const advance = clock(onTestFinished)
  const { worker, agent, issue, take } = await runFixture()
  advance(5_000)
  const probe = await issue('before-lease-expiry')
  expect((await worker.agents.intents(agent.id)).intents.map(({ id }) => id)).toEqual([probe.id])

  advance(26_000)
  await expect(take(probe)).rejects.toMatchObject({ status: 409, code: 'claim_lost' })
  expect((await worker.agents.intents(agent.id)).intents).toEqual([])
})

it('omits a pending run probe after its task is deleted', async () => {
  const { client, worker, agent, task, issue, take } = await runFixture()
  const probe = await issue('before-delete')
  expect((await worker.agents.intents(agent.id)).intents.map(({ id }) => id)).toEqual([probe.id])

  await client.delete(task.id)
  await expect(take(probe)).rejects.toMatchObject({ status: 404, code: 'not_a_task' })
  expect((await worker.agents.intents(agent.id)).intents).toEqual([])
})

it.for(['paused', 'resumed'] as const)('does not confirm run health when the board has %s until a new claim is probed', async (phase, { onTestFinished }) => {
  clock(onTestFinished)
  const { client, worker, agent, task, health, issue, take, report } = await runFixture()
  const probe = await issue('before-pause')
  await take(probe)
  await report(probe)
  expect(await health()).toMatchObject({ state: 'working' })

  await client.pause('fence active runs')
  if (phase === 'resumed') await client.resume('allow new runs')
  expect(await health()).toEqual(stale)

  if (phase === 'paused') await client.resume('allow new runs')
  const claim = await worker.tasks.claim(task.id, { lease: 30 })
  expect(await health()).toEqual(stale)
  const { intents: [fresh] } = await client.agents.issueIntent(agent.id, {
    verb: 'status', run: { task: task.id, epoch: claim.epoch }, generation: agent.generation, requestId: 'new-claim', ttlSeconds: 30,
  })
  await take(fresh!)
  await report(fresh!)
  expect(await health()).toMatchObject({ state: 'working' })
})

it('uses probe issue order, not report order, and does not fall back when the newest expires', async ({ onTestFinished }) => {
  const advance = clock(onTestFinished)
  const { health, issue, take, report } = await runFixture(30)
  const first = await issue('older')
  const second = await issue('newer', 10)
  await take(first)
  await take(second)
  await report(second, 'not_running')
  await report(first)
  expect(await health()).toEqual(stale)
  const third = await issue('positive', 8)
  await take(third)
  await report(third)
  expect(await health()).toEqual({ state: 'working', validUntil: third.expiresAt })
  advance(11_000)
  expect(await health()).toEqual(stale)
})

it('caps Working by receipt freshness and by the original claim lease', async ({ onTestFinished }) => {
  const advance = clock(onTestFinished)
  const { health, issue, take, report, claim } = await runFixture()
  const first = await issue('freshness')
  await take(first)
  const reported = await report(first)
  expect(await health()).toEqual({ state: 'working', validUntil: new Date(Date.parse(reported.report!.at) + 5_000).toISOString() })
  advance(5_500)
  expect(await health()).toEqual(stale)
  advance(21_000)
  const second = await issue('lease-deadline')
  await take(second)
  await report(second)
  expect(await health()).toEqual({ state: 'working', validUntil: claim.until })
  advance(4_000)
  expect(await health()).toEqual(stale)
})

it('only gives one take to racing recipients and refuses late or generation-fenced writes', async ({ onTestFinished }) => {
  const advance = clock(onTestFinished)
  const { client, worker, agent } = await fixture()
  const issue = async (requestId: string, ttlSeconds = 60) => (await client.agents.issueIntent(agent.id, { ...command, requestId, ttlSeconds })).intents[0]!
  const raced = await issue('raced')
  const racing = await Promise.allSettled(Array.from({ length: 4 }, () => worker.agents.takeIntent(raced.id, 1)))
  expect(racing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  for (const result of racing) {
    if (result.status === 'rejected') expect(result.reason).toMatchObject(conflict)
  }
  const expires = await issue('expires', 1)
  const taken = await issue('taken-before-expiry', 10)
  await worker.agents.takeIntent(taken.id, 1)
  advance(11_000)
  expect((await worker.agents.intents(agent.id)).intents).toEqual([])
  await expect(worker.agents.takeIntent(expires.id, 1)).rejects.toMatchObject(conflict)
  await expect(worker.agents.reportIntent(taken.id, 1, 'ok')).rejects.toMatchObject(conflict)

  const fenced = await issue('fenced')
  await worker.agents.register({ ...config, harness: 'container', ifGeneration: 1 })
  expect((await worker.agents.intents(agent.id)).intents).toEqual([])
  await expect(worker.agents.takeIntent(fenced.id, 1)).rejects.toMatchObject(conflict)
  await expect(worker.agents.takeIntent(fenced.id, 2)).rejects.toMatchObject(conflict)
  await expect(worker.agents.reportIntent(raced.id, 1, 'ok')).rejects.toMatchObject(conflict)
  await expect(issue('after-config')).rejects.toMatchObject(conflict)
})

it('snapshots enabled exact-channel role recipients atomically, with stable request replay', async () => {
  const { client, worker, agent } = await fixture()
  const other = client.as('other')
  const second = await other.agents.register(config)
  const retired = client.as('gone')
  const gone = await retired.agents.register(config)
  await retired.agents.retire(gone.id, 1)
  await client.as('sub').agents.register({ ...config, channel: 'work/sub' })
  const address = { ...command, channel: config.channel, role: config.role }
  const first = await client.agents.issueRoleIntent(address)
  expect(first.intents.map((intent) => intent.agent).sort()).toEqual([agent.id, second.id].sort())
  await client.as('joined-later').agents.register(config)
  expect(await client.agents.issueRoleIntent(address)).toEqual(first)
  await expect(client.agents.issueRoleIntent({ ...address, verb: 'resume' })).rejects.toMatchObject(conflict)
  const { task } = await client.tasks.create('work', 'one run, many recipients')
  const claim = await worker.tasks.claim(task.id)
  await expect(client.agents.issueRoleIntent({ ...address, requestId: 'probe-role', verb: 'status', ttlSeconds: 30, run: { task: task.id, epoch: claim.epoch } })).rejects.toMatchObject({ status: 400 })
  await other.agents.register({ ...config, harness: 'container', ifGeneration: 1 })
  await expect(client.agents.issueRoleIntent({ ...address, requestId: 'new-wave' })).rejects.toMatchObject(conflict)
  expect((await worker.agents.intents(agent.id)).intents).toEqual(first.intents.filter((intent) => intent.agent === agent.id))
})

it('pages pending intents oldest first, moving past already consumed intents', async () => {
  const { client, worker, agent } = await fixture()
  const ids: string[] = []
  for (let i = 0; i < 17; i++) {
    const { intents: [intent] } = await client.agents.issueIntent(agent.id, { ...command, requestId: `page-${i}` })
    ids.push(intent!.id)
  }
  await worker.agents.takeIntent(ids[1]!, 1)
  const first = await worker.agents.intents(agent.id)
  expect(first.intents.map(({ id }) => id)).toEqual([ids[0], ...ids.slice(2, 16)])
  expect(first.next).toEqual(expect.any(String))
  const second = await worker.agents.intents(agent.id, { after: first.next! })
  expect(second.intents.map(({ id }) => id)).toEqual(ids.slice(16))
  expect(second.next).toBeNull()
})

it('rechecks the issuer grant and the delegated parent binding at take', async () => {
  const { team, client, worker, agent } = await fixture()
  const grantInput = { principals: [{ kind: 'github' as const, repository: 'acme/web' }], can: { work: 'all' as const, elsewhere: ['read' as const] } }
  const { grant } = await team.createGrant(grantInput)
  const manager = via(team.fetch, await workflowToken()).as('controller')
  const controller = await manager.agents.register({ ...config, role: 'controller' })
  const child = await worker.agents.register({ ...config, parent: controller.id, ifGeneration: 1 })
  const delegated = manager.as('controller', { can: 'work=read,post' })
  const outsider = manager.as('outsider', { can: 'work=read,post' })
  const input = { ...command, generation: child.generation }
  await expect(outsider.agents.issueIntent(agent.id, input)).rejects.toMatchObject({ status: 403 })
  const first = (await delegated.agents.issueIntent(agent.id, input)).intents[0]!
  expect((await worker.agents.takeIntent(first.id, child.generation)).state).toBe('taken')
  const revoked = (await manager.agents.issueIntent(agent.id, { ...input, requestId: 'revoke-manager' })).intents[0]!
  await team.revokeGrant(grant.id)
  await expect(worker.agents.takeIntent(revoked.id, child.generation)).rejects.toMatchObject({ status: 403, code: 'issuer_revoked' })

  await team.createGrant(grantInput)
  const parentBound = (await delegated.agents.issueIntent(agent.id, { ...input, requestId: 'retire-parent' })).intents[0]!
  await manager.agents.retire(controller.id, controller.generation)
  await expect(worker.agents.takeIntent(parentBound.id, child.generation)).rejects.toMatchObject({ status: 403, code: 'issuer_revoked' })
  // Retiring the parent doesn't alter the child's generation or bar a manager's fresh intent.
  const fresh = (await client.agents.issueIntent(agent.id, { ...input, requestId: 'direct-manager' })).intents[0]!
  expect((await worker.agents.takeIntent(fresh.id, child.generation)).state).toBe('taken')
})

it('does not take a still-pending intent after its issuer credential expires', async ({ onTestFinished }) => {
  const advance = clock(onTestFinished)
  const token = await personToken('u_issuer')
  advance(3_595_000)
  const { team, worker, agent } = await fixture()
  const issuer = via(team.fetch, token)
  const { intents: [intent] } = await issuer.agents.issueIntent(agent.id, command)
  advance(10_000)
  expect((await worker.agents.intents(agent.id)).intents.map(({ id }) => id)).toEqual([intent!.id])
  await expect(worker.agents.takeIntent(intent!.id, 1)).rejects.toMatchObject({ status: 403, code: 'issuer_revoked' })
})

it('omits a pending run probe after its issuer grant is revoked', async () => {
  const { team, worker, agent, run, take } = await runFixture()
  const { grant } = await team.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { work: 'all' } })
  const issuer = via(team.fetch, await workflowToken())
  const { intents: [probe] } = await issuer.agents.issueIntent(agent.id, {
    verb: 'status', run, generation: agent.generation, requestId: 'before-revoke', ttlSeconds: 30,
  })
  expect((await worker.agents.intents(agent.id)).intents.map(({ id }) => id)).toEqual([probe!.id])

  await team.revokeGrant(grant.id)
  await expect(take(probe!)).rejects.toMatchObject({ status: 403, code: 'issuer_revoked' })
  expect((await worker.agents.intents(agent.id)).intents).toEqual([])
})

it('omits a pending run probe after its issuer credential expires', async ({ onTestFinished }) => {
  const advance = clock(onTestFinished)
  const token = await personToken('u_issuer')
  advance(3_595_000)
  const { team, worker, agent, run, take } = await runFixture()
  const issuer = via(team.fetch, token)
  const { intents: [probe] } = await issuer.agents.issueIntent(agent.id, {
    verb: 'status', run, generation: agent.generation, requestId: 'before-issuer-expiry', ttlSeconds: 30,
  })
  expect((await worker.agents.intents(agent.id)).intents.map(({ id }) => id)).toEqual([probe!.id])

  advance(10_000)
  await expect(take(probe!)).rejects.toMatchObject({ status: 403, code: 'issuer_revoked' })
  expect((await worker.agents.intents(agent.id)).intents).toEqual([])
})

it('omits a delegated pending run probe after its parent is retired', async () => {
  const { client, worker, agent, run } = await runFixture()
  const parent = client.as('controller')
  const controller = await parent.agents.register({ ...config, role: 'controller' })
  const child = await worker.agents.register({ ...config, parent: controller.id, ifGeneration: agent.generation })
  const issuer = parent.as('controller', { can: 'work=read,post' })
  const { intents: [probe] } = await issuer.agents.issueIntent(child.id, {
    verb: 'status', run, generation: child.generation, requestId: 'before-parent-retirement', ttlSeconds: 30,
  })
  expect((await worker.agents.intents(child.id)).intents.map(({ id }) => id)).toEqual([probe!.id])

  await parent.agents.retire(controller.id, controller.generation)
  await expect(worker.agents.takeIntent(probe!.id, child.generation)).rejects.toMatchObject({ status: 403, code: 'issuer_revoked' })
  expect((await worker.agents.intents(child.id)).intents).toEqual([])
})

it('lists a still-authorized run probe when another issuer loses issue authority', async () => {
  const { team, worker, agent, run, issue } = await runFixture()
  const principal = { kind: 'github', repository: 'acme/web' } as const
  const { grant } = await team.createGrant({ principals: [principal], can: { work: 'all' } })
  await team.createGrant({ principals: [principal], can: { work: ['read', 'post'] } })
  const issuer = via(team.fetch, await workflowToken())
  const { intents: [probe] } = await issuer.agents.issueIntent(agent.id, {
    verb: 'status', run, generation: agent.generation, requestId: 'before-losing-manage', ttlSeconds: 30,
  })
  const authorized = await issue('still-authorized')
  const recipient = worker.as('worker', { can: 'work=read,post' })
  const listed = async () => (await recipient.agents.intents(agent.id)).intents.map(({ id }) => id)
  expect(await listed()).toEqual([probe!.id, authorized.id])

  await team.revokeGrant(grant.id)
  expect(await listed()).toEqual([authorized.id])
})

it('keeps intent mutations out of all-events reads and out of ordinary task views', async () => {
  const { team, client, agent, task, issue, take, report, health } = await runFixture()
  const start = await client.post('work', 'before probing')
  await expect(team.agents.issueIntent(agent.id, command)).rejects.toMatchObject({ status: 403 })
  const before = (await client.thread(task.id)).message.task
  const intent = await issue('private-probe')
  await take(intent)
  await report(intent)
  const confirmed = await health()
  expect(confirmed).toMatchObject({ state: 'working' })
  expect(await team.agents.health(task.id)).toEqual(confirmed)
  const after = await client.post('work', 'after probing')
  const { events } = await client.poll({ after: start.id, all: true, wait: 0 })
  expect(events.map(({ type, message }) => [type, message?.id])).toEqual([['message.posted', after.id]])
  expect((await client.thread(task.id)).message.task).toEqual(before)
})

it('answers no_agent_ops locally and does not forward intents or health without advertised support', async ({ onTestFinished }) => {
  const local = localBoard()
  onTestFinished(() => local.close())
  const token = await personToken()
  const attempted: string[] = []
  const remote = via((request) => {
    if (new URL(request.url).pathname.includes('/ops/')) attempted.push(request.url)
    return local.fetch(request)
  }, token)
  expect(await local.discovery()).not.toHaveProperty('agent_ops')
  for (const { agents } of [local, remote]) {
    await expect(agents.issueIntent('missing', command)).rejects.toMatchObject(noOps)
    await expect(agents.issueRoleIntent({ ...command, channel: 'work', role: 'reviewer' })).rejects.toMatchObject(noOps)
    await expect(agents.intents('missing')).rejects.toMatchObject(noOps)
    await expect(agents.takeIntent('missing', 1)).rejects.toMatchObject(noOps)
    await expect(agents.reportIntent('missing', 1, 'ok')).rejects.toMatchObject(noOps)
    await expect(agents.health('missing')).rejects.toMatchObject(noOps)
  }
  expect(attempted).toEqual([])
  const send = caller(local.fetch, token)
  expect(await send('GET', '/ops/health/missing')).toMatchObject({ status: 501, body: { error: { code: 'no_agent_ops' } } })
})

it('advertises agent intents in discovery on an opted-in local board', async ({ onTestFinished }) => {
  const local = localBoard({ agentOps: true })
  onTestFinished(() => local.close())
  const response = await local.fetch(new Request(BOARD_URL))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ agent_ops: true, agent_intents: true })
  expect(await local.discovery()).toMatchObject({ agent_ops: true, agent_intents: true })
})

it('forwards registry calls but no intent requests to a registry-only board', async ({ onTestFinished }) => {
  const { client, attempted } = await registryOnly(onTestFinished)
  const { agents } = client.as('worker')
  const agent = await agents.register(config)
  expect(await agents.list(config.channel)).toEqual({ agents: [agent] })

  await expect(agents.issueIntent(agent.id, command)).rejects.toMatchObject(noOps)
  await expect(agents.issueRoleIntent({ ...command, channel: config.channel, role: config.role })).rejects.toMatchObject(noOps)
  await expect(agents.intents(agent.id)).rejects.toMatchObject(noOps)
  await expect(agents.takeIntent('missing', agent.generation)).rejects.toMatchObject(noOps)
  await expect(agents.reportIntent('missing', agent.generation, 'ok')).rejects.toMatchObject(noOps)
  expect(attempted).toEqual([])
})

it('rechecks agent capabilities on the same HTTP handle when the mount changes', async ({ onTestFinished }) => {
  const full = localBoard({ agentOps: true })
  const disabled = localBoard()
  onTestFinished(() => full.close())
  onTestFinished(() => disabled.close())
  const { fetch: registryFetch, attempted } = registryOnlyMount(full.fetch)
  const cachedDiscovery = await (await full.fetch(new Request(BOARD_URL))).json()
  let mount = full.fetch
  const client = via((request) => {
    if (request.url === BOARD_URL && request.cache !== 'no-store') return Promise.resolve(Response.json(cachedDiscovery))
    return mount(request)
  }, await personToken()).as('worker')
  expect(await client.discovery()).toMatchObject({ agent_ops: true, agent_intents: true })
  const agent = await client.agents.register(config)
  const issued = await client.agents.issueIntent(agent.id, command)
  expect((await client.agents.intents(agent.id)).intents).toEqual(issued.intents)

  mount = registryFetch
  await expect(client.agents.intents(agent.id)).rejects.toMatchObject({
    ...noOps,
    origin: 'handle',
    message: 'this board does not advertise agent intents or run health',
    hint: expect.stringContaining('--agent-ops'),
  })
  expect(attempted).toEqual([])
  expect(await client.agents.list(config.channel)).toEqual({ agents: [agent] })

  mount = disabled.fetch
  await expect(client.agents.list(config.channel)).rejects.toMatchObject({
    ...noOps,
    origin: 'handle',
    message: 'this board does not keep an agent registry',
    hint: expect.stringContaining('--agent-ops'),
  })
})

it("never returns an older mount's discovery document as health", async ({ onTestFinished }) => {
  const { client, attempted } = await registryOnly(onTestFinished)
  await expect(client.agents.health('missing')).rejects.toMatchObject(noOps)
  expect(attempted).toEqual([])
})

it('rejects discovery JSON from the health route even when the mount advertises intents', async ({ onTestFinished }) => {
  const team = localBoard({ agentOps: true })
  onTestFinished(() => team.close())
  const client = via((request) => new URL(request.url).pathname.startsWith(`${new URL(BOARD_URL).pathname}/ops/health/`)
    ? team.fetch(new Request(BOARD_URL))
    : team.fetch(request), await personToken())

  await expect(client.agents.health('missing')).rejects.toMatchObject({ status: 502, code: 'remote_error' })
})

const runHealthCheck = 'confirms a claimed run only through a taken and reported status probe'

it('skips run-health conformance when the mount becomes registry-only during the run', async ({ onTestFinished }) => {
  const team = localBoard({ agentOps: true })
  onTestFinished(() => team.close())
  const { fetch: registryFetch } = registryOnlyMount(team.fetch)
  let mount = team.fetch
  const client = via(async (request) => {
    const response = await mount(request)
    if (response.ok && request.method === 'POST' && /\/ops\/agents\/[^/]+\/retire$/.test(new URL(request.url).pathname)) mount = registryFetch
    return response
  }, await personToken())

  const report = await conformance(client)
  expect(report.checks.find(({ name }) => name === runHealthCheck)).toMatchObject({
    status: 'skipped', detail: 'not kept here: agent intents are not advertised',
  })
}, 30_000)

it('passes registry conformance but skips run health on a registry-only board without leaving a probe', async ({ onTestFinished }) => {
  const { client } = await registryOnly(onTestFinished)
  const channel = 'conformance'
  const { cursor: start } = await client.channel(channel).messages()
  const report = await conformance(client, { channel })
  expect(report.checks.filter(({ group }) => group === 'agents')).toMatchObject([
    { name: 'registers, lists, heartbeats, and retires an agent under its verified binding', status: 'passed' },
    { name: runHealthCheck, status: 'skipped', detail: expect.stringContaining('not kept here') },
  ])
  // Only the registry check leaves an entry.
  expect((await client.agents.list(channel)).agents).toMatchObject([{ status: 'disabled' }])
  // A tombstone no longer has the task's text. Read the channel's posts from before the run.
  for (let after = start; ; ) {
    const { events, cursor } = await client.poll({ channel, after, wait: 0 })
    expect(events.filter(({ type, message }) => type === 'message.posted' && message?.text === 'conformance: run health')).toEqual([])
    if (cursor === after) break
    after = cursor
  }
}, 30_000)

// The third POST is the one that would normally be refused with 409 for changed input.
it.for([1, 3])('skips run-health conformance and cleans up when the mount becomes registry-only on intent POST %i', { timeout: 30_000 }, async (attempt, { onTestFinished }) => {
  const team = localBoard({ agentOps: true })
  onTestFinished(() => team.close())
  const { fetch: registryFetch } = registryOnlyMount(team.fetch)
  const channel = 'conformance'
  let mount = team.fetch
  let issued = 0
  let probe: { agent: string; run: AgentRun } | undefined
  const client = via(async (request) => {
    const issuing = request.method === 'POST' && /\/ops\/agents\/([^/]+)\/intents$/.exec(new URL(request.url).pathname)
    if (issuing && ++issued === attempt) {
      // Discovery still advertised intents when this request was sent.
      mount = registryFetch
      const { run } = await request.json() as { run: AgentRun }
      probe = { agent: decodeURIComponent(issuing[1]!), run }
      return Response.json({ error: { code: noOps.code, message: 'this board does not advertise agent intents or run health' } }, { status: noOps.status })
    }
    return mount(request)
  }, await personToken())

  const report = await conformance(client, { channel })
  expect(report.checks.find(({ name }) => name === runHealthCheck)).toMatchObject({
    status: 'skipped', detail: 'not kept here: agent intents are not advertised',
  })
  expect(probe).toBeDefined()
  const { agent, run } = probe!
  expect((await client.agents.list(channel)).agents.find(({ id }) => id === agent)).toMatchObject({ status: 'disabled' })
  const { events } = await client.poll({ re: run.task, after: run.task, wait: 0 })
  expect(events.map(({ type }) => type)).toContain('task.released')
})

it('skips run-health conformance without registering a probe agent on a board that keeps no tasks', async ({ onTestFinished }) => {
  const team = localBoard({ agentOps: true })
  onTestFinished(() => team.close())
  const channel = 'conformance'
  const client = via(async (request) => {
    if (!/\/tasks(?:\/|$)/.test(new URL(request.url).pathname)) return team.fetch(request)
    return Response.json({ error: { code: 'no_tasks', message: 'this board keeps no tasks' } }, { status: 501 })
  }, await personToken())

  const report = await conformance(client, { channel })
  expect(report.checks.find(({ name }) => name === runHealthCheck)).toMatchObject({
    status: 'skipped', detail: 'not kept here: this board keeps no tasks',
  })
  expect((await client.agents.list(channel)).agents).toMatchObject([{ status: 'disabled' }])
}, 30_000)
