import { afterEach, describe, expect, it } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { vercel } from '../src/backend-vercel/index.ts'
import { bearer, board, BOARD_URL, caller, localBoard, personToken } from './harness.ts'

const config = { channel: 'work', role: 'implementation-worker', harness: 'shell' } as const
const noOps = { status: 501, code: 'no_agent_ops' }
const notFound = { status: 404 }
const forbidden = { status: 403, code: 'forbidden' }
const conflict = { status: 409 }
const discoveryPath = new URL(BOARD_URL).pathname
const to = (id: string, operation: 'heartbeat' | 'retire') => `/ops/agents/${encodeURIComponent(id)}/${operation}`
const running: ReturnType<typeof localBoard>[] = []
afterEach(async () => {
  for (const local of running.splice(0)) await local.close()
})

function local(agentOps?: true) {
  const team = localBoard({ agentOps })
  running.push(team)
  return team
}

function via(fetch: (request: Request) => Promise<Response>, token: string) {
  return board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)
}

async function fixture() {
  const team = local(true)
  const token = await personToken()
  return { team, client: via(team.fetch, token), send: caller(team.fetch, token, { 'x-board-profile': 'worker' }) }
}

async function expectUnsupported(agents: ReturnType<typeof board>['agents']) {
  await expect(agents.list(config.channel)).rejects.toMatchObject(noOps)
  await expect(agents.register(config)).rejects.toMatchObject(noOps)
  await expect(agents.heartbeat('unknown', 1)).rejects.toMatchObject(noOps)
  await expect(agents.retire('unknown', 1)).rejects.toMatchObject(noOps)
}

describe('agent operations capability', () => {
  it('omits discovery and answers 501 on every agent route by default', async () => {
    const team = local()
    expect(await team.discovery()).not.toHaveProperty('agent_ops')
    await expectUnsupported(team.agents)
    const send = caller(team.fetch, await personToken())
    for (const reply of [
      await send('GET', '/ops/agents?channel=work'),
      await send('POST', '/ops/agents', config),
      await send('POST', to('unknown', 'heartbeat'), { generation: 1 }),
      await send('POST', to('unknown', 'retire'), { generation: 1 }),
    ]) expect(reply).toMatchObject({ status: 501, body: { error: { code: 'no_agent_ops' } } })
  })

  it('forwards no agent requests when discovery omits support, even if the server keeps agents', async () => {
    const { team } = await fixture()
    expect(await team.discovery()).toMatchObject({ agent_ops: true })
    const attempted: string[] = []
    // An older discovery document, backed by the real server for every other route.
    const client = via(async (request) => {
      const path = new URL(request.url).pathname.replace(/\/$/, '')
      if (path.startsWith(`${discoveryPath}/ops/agents`)) attempted.push(`${request.method} ${path}`)
      const reply = await team.fetch(request)
      if (path === discoveryPath) {
        const discovery = await reply.json()
        delete discovery.agent_ops
        return Response.json(discovery, { status: reply.status })
      }
      return reply
    }, await personToken())
    await expectUnsupported(client.agents)
    expect(attempted).toEqual([])
  })

  it('does not try the Vercel API for unsupported agent operations', async () => {
    const client = board({ backend: vercel({ team: 'team_test', fetch: async () => {
      throw new Error('agent operations should not reach Vercel')
    } }) })
    await expectUnsupported(client.agents)
  })
})

describe('agent registry over HTTP', () => {
  it('rejects forged identity, non-single roles, and extra mutation fields before writing', async () => {
    const { client, send } = await fixture()
    for (const extras of [
      { binding: { principal: 'vercel:user:u_someone', profile: 'other' } },
      { id: 'chosen-id' },
      { role: ['implementation-worker', 'reviewer'] },
      { role: 'implementation-worker,reviewer' },
      { role: 'QA runner' },
      { roles: ['reviewer'] },
    ]) {
      expect(await send('POST', '/ops/agents', { ...config, ...extras }), JSON.stringify(extras)).toMatchObject({
        status: 400, body: { error: { code: 'invalid_request' } },
      })
    }
    expect(await send('GET', '/ops/agents?channel=work')).toMatchObject({ status: 200, body: { agents: [] } })

    const agent = await client.as('worker').agents.register(config)
    for (const operation of ['heartbeat', 'retire'] as const) {
      expect(await send('POST', to(agent.id, operation), { generation: agent.generation, heartbeatAt: '2000-01-01T00:00:00Z' }), operation)
        .toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
    }
    expect(await client.agents.list(config.channel)).toEqual({ agents: [agent] })
  })

  it('round-trips each of the eight role slugs', async () => {
    const { client } = await fixture()
    const roles = ['coordinator', 'issues', 'controller', 'implementation-worker', 'reviewer', 'qa-owner', 'qa-runner', 'user-watcher'] as const
    for (const role of roles) await client.as(role).agents.register({ ...config, role })
    const { agents } = await client.agents.list(config.channel)
    expect(agents.map(({ role }) => role).sort()).toEqual([...roles].sort())
  })

  it('keeps a stable binding and fences config changes, retirement, and re-enabling', async () => {
    const { client } = await fixture()
    const worker = client.as('worker').agents
    const sameProfile = client.as('WORKER').agents
    const agent = await worker.register(config)
    expect(agent).toEqual({
      ...config, id: expect.any(String), parent: null,
      binding: { principal: 'vercel:user:u_julian', profile: 'worker' },
      generation: 1, status: 'enabled', heartbeatAt: null,
    })
    const before = Date.now()
    const beat = await sameProfile.heartbeat(agent.id, 1)
    const after = Date.now()
    expect(beat).toMatchObject({ ...agent, heartbeatAt: expect.any(String) })
    expect(Date.parse(beat.heartbeatAt!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(beat.heartbeatAt!)).toBeLessThanOrEqual(after)
    expect(beat.heartbeatAt).toMatch(/Z$/)
    expect(await worker.register(config)).toEqual(beat)
    expect(await sameProfile.register(config)).toMatchObject({ id: agent.id, generation: 1, heartbeatAt: beat.heartbeatAt })
    const changed = { ...config, harness: 'container' }
    await expect(worker.register(changed)).rejects.toMatchObject(conflict)
    const updated = await worker.register({ ...changed, ifGeneration: 1 })
    expect(updated).toEqual({ ...agent, harness: changed.harness, generation: 2 })
    await expect(worker.register({ ...changed, ifGeneration: 1 })).rejects.toMatchObject(conflict)
    await expect(worker.heartbeat(agent.id, 1)).rejects.toMatchObject(conflict)
    await expect(worker.retire(agent.id, 1)).rejects.toMatchObject(conflict)

    expect(await worker.heartbeat(agent.id, 2)).toMatchObject({ heartbeatAt: expect.any(String) })
    const retired = await worker.retire(agent.id, 2)
    expect(retired).toEqual({ ...updated, generation: 3, status: 'disabled', heartbeatAt: null })
    await expect(worker.retire(agent.id, 2)).rejects.toMatchObject(conflict)
    expect(await worker.retire(agent.id, 3)).toEqual(retired)
    await expect(worker.heartbeat(agent.id, 3)).rejects.toMatchObject(conflict)
    await expect(worker.register(changed)).rejects.toMatchObject(conflict)
    const revived = await worker.register({ ...changed, ifGeneration: 3 })
    expect(revived).toEqual({ ...updated, generation: 4 })
    expect(await client.agents.list(config.channel)).toEqual({ agents: [revived] })
  })

  it('refuses a self-parent, an ancestor cycle, and parents outside the exact channel', async () => {
    const { client } = await fixture()
    const lead = client.as('lead').agents
    const controller = client.as('controller').agents
    const worker = client.as('worker').agents
    const a = await lead.register({ ...config, role: 'coordinator' })
    const b = await controller.register({ ...config, role: 'controller', parent: a.id })
    const c = await worker.register({ ...config, parent: b.id })
    await expect(lead.register({ ...config, role: a.role, parent: a.id, ifGeneration: a.generation })).rejects.toMatchObject(conflict)
    await expect(lead.register({ ...config, role: a.role, parent: c.id, ifGeneration: a.generation })).rejects.toMatchObject(conflict)
    await expect(worker.register({ ...config, channel: 'work/sub', parent: b.id })).rejects.toMatchObject(notFound)
    const sub = await worker.register({ ...config, channel: 'work/sub' })
    expect(sub.id).not.toBe(c.id)
    const { agents } = await client.agents.list('work')
    expect(agents).toHaveLength(3)
    expect(agents).toEqual(expect.arrayContaining([a, b, c]))
    expect(await client.agents.list('work/sub')).toEqual({ agents: [sub] })
  })

  it('requires manage for config and retirement, read plus post for heartbeat, and the target binding and channel', async () => {
    const { team, client } = await fixture()
    const owner = client.as('worker').agents
    const agent = await owner.register(config)
    const read = client.as('worker', { can: 'work=read' }).agents
    const post = client.as('worker', { can: 'work=post' }).agents
    const member = client.as('worker', { can: 'work=read,post' }).agents
    const elsewhere = client.as('worker', { can: 'elsewhere=all' }).agents
    expect(await read.list('work')).toEqual({ agents: [agent] })
    await expect(member.register({ ...config, harness: 'changed', ifGeneration: 1 })).rejects.toMatchObject(forbidden)
    await expect(member.retire(agent.id, 1)).rejects.toMatchObject(forbidden)
    await expect(read.heartbeat(agent.id, 1)).rejects.toMatchObject(forbidden)
    await expect(post.heartbeat(agent.id, 1)).rejects.toMatchObject(notFound)
    await expect(elsewhere.list('work')).rejects.toMatchObject(forbidden)
    await expect(elsewhere.heartbeat(agent.id, 1)).rejects.toMatchObject(notFound)
    await expect(elsewhere.retire(agent.id, 1)).rejects.toMatchObject(notFound)

    const wrongProfile = client.as('reviewer').agents
    const wrongPrincipal = via(team.fetch, await personToken('u_second')).as('worker').agents
    for (const other of [wrongProfile, wrongPrincipal]) {
      // A stale fence must not hint that a mismatched target exists.
      await expect(other.heartbeat(agent.id, 2)).rejects.toMatchObject(notFound)
      await expect(other.retire(agent.id, 2)).rejects.toMatchObject(notFound)
    }
    expect(await member.heartbeat(agent.id, 1)).toMatchObject({ id: agent.id, generation: 1, heartbeatAt: expect.any(String) })
    expect(await owner.retire(agent.id, 1)).toMatchObject({ id: agent.id, status: 'disabled' })
  })

  it('keeps registry changes out of the public event feed, including all-events reads', async () => {
    const { client } = await fixture()
    const marker = await client.post('work', 'before agent operations')
    const agent = await client.agents.register(config)
    await client.agents.heartbeat(agent.id, 1)
    await client.agents.retire(agent.id, 1)
    const next = await client.post('work', 'after agent operations')
    const { events } = await client.poll({ after: marker.id, all: true, wait: 0 })
    expect(events.map((event) => [event.type, event.message?.id])).toEqual([['message.posted', next.id]])
  })
})
