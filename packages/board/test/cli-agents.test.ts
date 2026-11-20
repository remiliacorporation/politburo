import { expect, it } from 'vitest'
import type { AgentHealth, AgentIntent, AgentView } from '../src/api/routes.ts'
import { tmp, vb } from './cli-harness.ts'
import { localBoard, localUserToken, personToken } from './harness.ts'
import { serve } from './http.ts'

it('vb agents reports disabled boards and runs the registry lifecycle with JSON on opt-in boards', async ({ onTestFinished }) => {
  const home = await tmp('agents-home-')
  const client = async (agentOps?: true) => {
    const team = localBoard({ url: undefined, agentOps })
    const server = await serve(team.fetch)
    onTestFinished(async () => {
      await server.close()
      await team.close()
    })
    const url = `${server.origin}/api/board`
    const env = { HOME: home, XDG_CONFIG_HOME: home, BOARD_URL: url, BOARD_TOKEN: await personToken('u_julian', url) }
    return (...args: string[]) => vb(['agents', ...args, '--json'], env, undefined, home)
  }
  const disabled = await client()
  const unavailable = await disabled('list', 'work')
  expect(unavailable).toMatchObject({ code: 1, stdout: '' })
  expect(JSON.parse(unavailable.stderr)).toMatchObject({ reason: 'no_agent_ops' })

  const run = await client(true)
  const json = async <T>(...args: string[]): Promise<T> => {
    const result = await run(...args)
    expect(result, args.join(' ')).toMatchObject({ code: 0, stderr: '' })
    return JSON.parse(result.stdout)
  }
  const write = async (...args: string[]) => (await json<{ agent: AgentView }>(...args)).agent
  const list = () => json<{ agents: AgentView[] }>('list', 'work')
  expect(await list()).toEqual({ agents: [] })
  const lead = await write('register', 'work', '--role', 'coordinator', '--harness', 'shell', '--as', 'lead')
  const register = ['register', 'work', '--role', 'qa-runner', '--parent', lead.id, '--as', 'worker']
  const worker = await write(...register, '--harness', 'shell')
  expect(worker).toMatchObject({
    channel: 'work', role: 'qa-runner', parent: lead.id, harness: 'shell',
    binding: { principal: 'vercel:user:u_julian', profile: 'worker' }, generation: 1, status: 'enabled', heartbeatAt: null,
  })
  const beat = await write('heartbeat', worker.id, '--generation', '1', '--as', 'worker')
  expect(beat).toEqual({ ...worker, heartbeatAt: expect.any(String) })
  const updated = await write(...register, '--harness', 'container', '--generation', '1')
  expect(updated).toEqual({ ...worker, harness: 'container', generation: 2 })

  const stale = await run('retire', worker.id, '--generation', '1', '--as', 'worker')
  expect(stale).toMatchObject({ code: 1, stdout: '' })
  expect(JSON.parse(stale.stderr)).toMatchObject({ status: 'error', reason: 'agent_generation_conflict' })
  const retired = await write('retire', worker.id, '--generation', '2', '--as', 'worker')
  expect(retired).toEqual({ ...updated, generation: 3, status: 'disabled' })
  const { agents } = await list()
  expect(agents).toHaveLength(2)
  expect(agents).toEqual(expect.arrayContaining([lead, retired]))
}, 30_000)

it('vb agents reports missing run health without denying the registry on a registry-only board', async ({ onTestFinished }) => {
  const home = await tmp('agents-registry-home-')
  const team = localBoard({ url: undefined, agentOps: true })
  const server = await serve(async (request) => {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/board' || pathname.startsWith('/api/board/ops/health/')) {
      // Older mounts answer discovery on an unknown GET.
      const { agent_intents: _, ...info } = await (await team.fetch(new Request(new URL('/api/board', request.url)))).json()
      return Response.json(info)
    }
    return team.fetch(request)
  })
  onTestFinished(async () => {
    await server.close()
    await team.close()
  })
  const url = `${server.origin}/api/board`
  const env = { HOME: home, XDG_CONFIG_HOME: home, BOARD_URL: url, BOARD_TOKEN: await personToken('u_julian', url) }
  const run = (...args: string[]) => vb(['agents', ...args, '--json'], env, undefined, home)
  const roster = await run('list', 'work')
  expect(roster).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(roster.stdout)).toEqual({ agents: [] })

  const unavailable = await run('health', '812')
  expect(unavailable).toMatchObject({ code: 1, stdout: '' })
  expect(JSON.parse(unavailable.stderr)).toMatchObject({
    reason: 'no_agent_ops',
    message: 'this board does not advertise agent intents or run health',
    hint: expect.stringContaining('supports intents'),
  })
})

it('vb agents takes and reports a run probe as the verified local user', async ({ onTestFinished }) => {
  const home = await tmp('agents-probe-home-')
  const team = localBoard({ url: undefined, agentOps: true })
  const server = await serve(team.fetch)
  onTestFinished(async () => {
    await server.close()
    await team.close()
  })
  const url = `${server.origin}/api/board`
  const env = { HOME: home, XDG_CONFIG_HOME: home, BOARD_URL: url, BOARD_TOKEN: await localUserToken('local-worker', url) }
  const run = (...args: string[]) => vb(args, env, undefined, home)
  const json = async <T>(...args: string[]): Promise<T> => {
    const result = await run(...args, '--json')
    expect(result, args.join(' ')).toMatchObject({ code: 0, stderr: '' })
    return JSON.parse(result.stdout)
  }
  const { agent } = await json<{ agent: AgentView }>('agents', 'register', 'work', '--role', 'reviewer', '--harness', 'shell')
  const { task, claim } = await json<{ task: { id: string }; claim: { epoch: number } }>('tasks', 'create', 'work', 'a run', '--claim')
  expect(await run('agents', 'health', task.id)).toMatchObject({ code: 0, stdout: `${task.id}  stale\n`, stderr: '' })
  const flags = ['--generation', String(agent.generation), '--ttl', '30s']
  const { intents: [poke] } = await json<{ intents: AgentIntent[] }>('agents', 'issue-role-intent', 'work', 'reviewer', 'poke', ...flags)
  expect(poke).toMatchObject({ agent: agent.id, verb: 'poke', state: 'pending' })
  const { intents: [probe] } = await json<{ intents: AgentIntent[] }>('agents', 'issue-intent', agent.id, 'status', ...flags, '--task', task.id, '--epoch', String(claim.epoch), '--idempotency-key', 'run-probe')
  expect(probe).toMatchObject({ agent: agent.id, verb: 'status', run: { task: task.id, epoch: claim.epoch } })
  expect(await json('agents', 'intents', agent.id)).toEqual({ intents: [poke, probe], next: null })
  const generation = ['--generation', String(agent.generation)]
  expect(await json('agents', 'take-intent', probe!.id, ...generation)).toMatchObject({ intent: { state: 'taken' } })
  expect(await json('agents', 'report-intent', probe!.id, 'running', ...generation)).toMatchObject({
    intent: { state: 'reported', report: { by: { principal: 'local:user:local-worker' }, outcome: 'running' } },
  })
  const { health } = await json<{ health: AgentHealth }>('agents', 'health', task.id)
  expect(health).toMatchObject({ state: 'working', validUntil: expect.any(String) })
}, 30_000)
