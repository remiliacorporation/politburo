import { expect, it } from 'vitest'
import type { AgentIntent, AgentView, Discovery } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { board, BOARD_URL } from './harness.ts'

type Agents = ReturnType<typeof board>['agents']
const mount = new URL(BOARD_URL).pathname
const discovery: Discovery = {
  version: '0.53.0', url: BOARD_URL, audience: BOARD_URL, team_id: null, project_id: null,
  sync: [], agent_ops: true, agent_intents: true,
}
const remoteError = { status: 502, code: 'remote_error' }

function remoteAgents(route: string, body: unknown): Agents {
  const [method, path] = route.split(' ')
  return board({ backend: http(BOARD_URL, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (request.method === 'GET' && pathname === mount) return Response.json(discovery)
      if (request.method === method && pathname === `${mount}${path}`) return Response.json(body, { status: 200 })
      return Response.json({ error: { code: 'not_found', message: 'no such route' } }, { status: 404 })
    },
  }) }).as(null).agents
}

const config = { channel: 'work', role: 'reviewer', harness: 'shell' } as const
const binding = { principal: 'vercel:user:u_julian', profile: 'worker' }
const agent = {
  ...config, id: 'agent-1', parent: null, binding, generation: 1, status: 'enabled', heartbeatAt: null,
} satisfies AgentView
const at = '2026-01-01T00:00:00Z'
const deadline = '2026-01-01T00:00:30Z'
const command = { verb: 'pause', generation: agent.generation, ttlSeconds: 30, requestId: 'pause-1' } as const
const run = { task: 'task-1', epoch: 1 }
const probeCommand = { ...command, verb: 'status', requestId: 'check-1', run } as const
const by = { ...binding, actor: `${binding.principal}+${binding.profile}` }
const pending = {
  id: 'intent-1', agent: agent.id, generation: agent.generation, verb: command.verb, by,
  createdAt: at, expiresAt: deadline, state: 'pending', taken: null, report: null,
} satisfies AgentIntent
const probe = { ...pending, id: 'probe-1', verb: probeCommand.verb, run } satisfies AgentIntent
const receipt = { by, generation: agent.generation, at }
const taken = (intent: AgentIntent): AgentIntent => ({ ...intent, state: 'taken', taken: receipt })
const reported = (intent: AgentIntent): AgentIntent => ({
  ...taken(intent), state: 'reported', report: { ...receipt, outcome: intent.run ? 'running' : 'ok' },
})
const agentIntents = `/ops/agents/${agent.id}/intents`
const healthRoute = `GET /ops/health/${run.task}`

const withExtra = <T extends object>(body: T) => ({ ...body, remoteNote: 'an unknown response field' })
const replies = (clean: object, malformed: object, extended: object = withExtra(clean)) => ({ clean, malformed, extended })
type Replies = ReturnType<typeof replies>

function agentReplies(entry: AgentView): Replies {
  return replies(entry, { ...entry, generation: '1' }, withExtra({ ...entry, binding: withExtra(entry.binding) }))
}

function intentReplies(intent: AgentIntent): Replies {
  const { run, taken, report } = intent
  return replies(
    intent,
    run ? { ...intent, run: { ...run, epoch: '1' } } : { ...intent, expiresAt: 'not a timestamp' },
    withExtra({
      ...intent, by: withExtra(intent.by), ...(run && { run: withExtra(run) }),
      taken: taken && withExtra(taken), report: report && withExtra(report),
    }),
  )
}

function listReplies(key: 'agents' | 'intents', { clean, malformed, extended }: Replies, page?: { next: string | null }): Replies {
  const wrap = (entry: object) => ({ [key]: [entry], ...page })
  return replies(wrap(clean), wrap(malformed), withExtra(wrap(extended)))
}

type Case = Replies & { name: string; route: string; call: (agents: Agents) => Promise<unknown> }
const cases: Case[] = [
  { name: 'agents.list', route: 'GET /ops/agents', call: (ops) => ops.list(config.channel),
    ...listReplies('agents', agentReplies(agent)) },
  { name: 'agents.register', route: 'POST /ops/agents', call: (ops) => ops.register(config),
    ...agentReplies(agent) },
  { name: 'agents.heartbeat', route: `POST /ops/agents/${agent.id}/heartbeat`, call: (ops) => ops.heartbeat(agent.id, 1),
    ...agentReplies({ ...agent, heartbeatAt: at }) },
  { name: 'agents.retire', route: `POST /ops/agents/${agent.id}/retire`, call: (ops) => ops.retire(agent.id, 1),
    ...agentReplies({ ...agent, generation: 2, status: 'disabled' }) },
  { name: 'agents.issueIntent', route: `POST ${agentIntents}`, call: (ops) => ops.issueIntent(agent.id, command),
    ...listReplies('intents', intentReplies(pending)) },
  { name: 'agents.issueRoleIntent', route: 'POST /ops/intents', call: (ops) => ops.issueRoleIntent({ ...command, channel: config.channel, role: config.role }),
    ...listReplies('intents', intentReplies(pending)) },
  { name: 'agents.intents', route: `GET ${agentIntents}`, call: (ops) => ops.intents(agent.id),
    ...listReplies('intents', intentReplies(pending), { next: null }) },
  { name: 'agents.takeIntent', route: `POST /ops/intents/${pending.id}/take`, call: (ops) => ops.takeIntent(pending.id, 1),
    ...intentReplies(taken(pending)) },
  { name: 'agents.reportIntent', route: `POST /ops/intents/${pending.id}/report`, call: (ops) => ops.reportIntent(pending.id, 1, 'ok'),
    ...intentReplies(reported(pending)) },
  { name: 'agents.issueIntent (run probe)', route: `POST ${agentIntents}`, call: (ops) => ops.issueIntent(agent.id, probeCommand),
    ...listReplies('intents', intentReplies(probe)) },
  { name: 'agents.intents (run probe)', route: `GET ${agentIntents}`, call: (ops) => ops.intents(agent.id),
    ...listReplies('intents', intentReplies(probe), { next: null }) },
  { name: 'agents.takeIntent (run probe)', route: `POST /ops/intents/${probe.id}/take`, call: (ops) => ops.takeIntent(probe.id, 1),
    ...intentReplies(taken(probe)) },
  { name: 'agents.reportIntent (run probe)', route: `POST /ops/intents/${probe.id}/report`, call: (ops) => ops.reportIntent(probe.id, 1, 'running'),
    ...intentReplies(reported(probe)) },
  { name: 'agents.health (working)', route: healthRoute, call: (ops) => ops.health(run.task),
    ...replies({ state: 'working', validUntil: deadline }, { state: 'working', validUntil: 'not a timestamp' }) },
  { name: 'agents.health (not_confirmed)', route: healthRoute, call: (ops) => ops.health(run.task),
    ...replies({ state: 'not_confirmed' }, { state: 'pending' }) },
]

it.for(cases)('$name strips extra fields and rejects malformed HTTP 200 replies', async ({ route, call, clean, malformed, extended }) => {
  await expect(call(remoteAgents(route, malformed))).rejects.toMatchObject(remoteError)
  await expect(call(remoteAgents(route, extended))).resolves.toEqual(clean)
})

it('rejects a not_confirmed health reply with an invalid validUntil', async () => {
  const ops = remoteAgents(healthRoute, { state: 'not_confirmed', validUntil: 'not a timestamp' })
  await expect(ops.health(run.task)).rejects.toMatchObject(remoteError)
})
