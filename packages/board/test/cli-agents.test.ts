import { expect, it } from 'vitest'
import type { AgentView } from '../src/api/routes.ts'
import { tmp, vb } from './cli-harness.ts'
import { localBoard, personToken } from './harness.ts'
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
