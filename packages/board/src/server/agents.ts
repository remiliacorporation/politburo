import type { AgentView, RegisterOpsAgentInput } from '../api/routes.ts'
import { own } from '../contract/own.ts'
import { agentsReducer } from '../contract/reducers.ts'
import { authorize } from './access.ts'
import type { Identity } from './backend.ts'
import { HttpError, notFound } from './errors.ts'
import { appendFrom, untilApplied, type WriteContext } from './writes.ts'

const missing = () => notFound('agent not found', 'agent_not_found')
const conflict = (code: string, message: string) => new HttpError(409, code, message)
const checkGeneration = (current: AgentView | undefined, generation: number) => {
  if (current?.generation !== generation) throw conflict('agent_generation_conflict', 'the agent is not at that generation')
}
const nextGeneration = ({ generation }: AgentView) => {
  if (generation === Number.MAX_SAFE_INTEGER) throw conflict('agent_generation_conflict', 'the agent has no next generation')
  return generation + 1
}
const sameBinding = (a: AgentView['binding'], b: AgentView['binding']) => a.principal === b.principal && a.profile === b.profile

/** A private projection of the board log, not an actor record or a source of permissions. */
export function createAgents(ctx: WriteContext) {
  const snapshot = () => ctx.session.state(agentsReducer, { through: 'latest' })
  type Agents = Awaited<ReturnType<typeof snapshot>>['state']

  async function change(decide: (agents: Agents) => { agent: AgentView; write: boolean }): Promise<AgentView> {
    let result!: AgentView
    const rows = await appendFrom(ctx, async () => {
      // The reducer's state and position are one read. Never fence it with the tables' position:
      // the tables advance independently and may already have passed a competing registry write.
      const { state, index } = await snapshot()
      const { agent, write } = decide(state)
      result = agent
      return { position: index, events: write ? [{ type: 'ops.agent_changed', payload: { agent } }] : [] }
    })
    await untilApplied(ctx, rows)
    return result
  }

  function owned(agents: Agents, id: string, { author, principal: { access } }: Identity, permission: 'post' | 'manage') {
    const agent = own(agents, id)
    if (!agent || !sameBinding(agent.binding, author)) throw missing()
    authorize(access, permission, agent.channel, missing)
    return agent
  }

  return {
    async list({ principal: { access } }: Identity, channel: string) {
      // Refuse the channel the caller named before looking up any entries, whether it has any or not.
      authorize(access, 'read', channel)
      const { state } = await snapshot()
      return { agents: Object.values(state).filter((agent) => agent.channel === channel) }
    },
    register({ author: { principal, profile }, principal: { access } }: Identity, input: RegisterOpsAgentInput) {
      const { channel, role, parent = null, harness, ifGeneration } = input
      const binding = { principal, profile }
      authorize(access, 'manage', channel)
      return change((agents) => {
        const current = Object.values(agents).find((agent) => agent.channel === channel && sameBinding(agent.binding, binding))
        if (ifGeneration !== undefined) checkGeneration(current, ifGeneration)
        if (current?.status === 'enabled' && current.role === role && current.parent === parent && current.harness === harness)
          return { agent: current, write: false }

        const seen = new Set(current ? [current.id] : [])
        for (let id = parent; id !== null; ) {
          const ancestor = own(agents, id)
          if (!ancestor || ancestor.channel !== channel || !access.readable(ancestor.channel)) throw missing()
          if (seen.has(id)) throw conflict('agent_parent_cycle', 'the agent cannot be its own ancestor')
          seen.add(id)
          id = ancestor.parent
        }
        if (current && ifGeneration === undefined) throw conflict('agent_generation_conflict', 'changing an agent requires ifGeneration')
        const agent: AgentView = {
          id: current?.id ?? crypto.randomUUID(),
          channel,
          role,
          parent,
          harness,
          binding,
          generation: current ? nextGeneration(current) : 1,
          status: 'enabled',
          heartbeatAt: null,
        }
        return { agent, write: true }
      })
    },
    heartbeat(identity: Identity, id: string, generation: number) {
      return change((agents) => {
        const agent = owned(agents, id, identity, 'post')
        checkGeneration(agent, generation)
        if (agent.status === 'disabled') throw conflict('agent_disabled', 'the agent is disabled')
        return { agent: { ...agent, heartbeatAt: new Date(Date.now()).toISOString() }, write: true }
      })
    },
    retire(identity: Identity, id: string, generation: number) {
      return change((agents) => {
        const agent = owned(agents, id, identity, 'manage')
        checkGeneration(agent, generation)
        if (agent.status === 'disabled') return { agent, write: false }
        return { agent: { ...agent, generation: nextGeneration(agent), status: 'disabled', heartbeatAt: null }, write: true }
      })
    },
  }
}
