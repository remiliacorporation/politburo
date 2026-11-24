import { createHash } from 'node:crypto'
import type { Protocol } from '../api/protocol.ts'
import type { Task } from '../contract/folds.ts'
import { own } from '../contract/own.ts'
import { agentIntentsReducer, runKey, type AgentIntentsState, type WorkState } from '../contract/reducers.ts'
import type { AgentHealth, AgentIntent, AgentRun, Author } from '../contract/schemas.ts'
import { authorize, type Access } from './access.ts'
import type { Known } from './auth.ts'
import type { BoardBinding, Caller, Identity } from './backend.ts'
import { badRequest, duplicateId, forbidden, HttpError, notFound } from './errors.ts'
import { indexOf } from './feed.ts'
import { claimFenced } from './tasks.ts'
import { appendFrom, untilApplied, type Events, type WriteContext } from './writes.ts'

type Agent = AgentIntentsState['agents'][string]
type Issue = Protocol['issueOpsIntent']['input'] | Protocol['issueOpsRoleIntent']['input']
const PAGE = 15
const SCAN = 60
const MAX_TARGETS = 64
const missingAgent = () => notFound('agent not found', 'agent_not_found')
const missingIntent = () => notFound('intent not found', 'intent_not_found')
const missingTask = () => notFound('task not found', 'not_a_task')
const conflict = (code: string, message: string) => new HttpError(409, code, message)
const claimLost = () => conflict('claim_lost', 'the run no longer holds the task')
const claimForRun = (task: Task, run: AgentRun) => task.epoch === run.epoch ? task.claim : null
const sameBinding = (a: Agent['binding'], b: Agent['binding']) => a.principal === b.principal && a.profile === b.profile
const mayReceive = (access: Access, channel: string) => access.readable(channel) && access.can('post', channel)
const iso = (at: number) => new Date(at).toISOString()

// Only identities verified through board() can issue or attest. People verified by the built-in
// verifier (including vb serve) have recheckable grant identity but no additional token claims.
function verified(caller: Caller): Identity | null {
  if (!('identity' in caller) || (caller.origin.via?.kind ?? 'api') !== 'api') return null
  const { principal } = caller.identity
  if (principal.id.startsWith('board:') || (principal as Known).token !== undefined) return null
  if (!principal.facts && !(principal.kind === 'person' && /^(local:user:|vercel:user:)/.test(principal.id))) return null
  return caller.identity
}

function mayIssue(state: AgentIntentsState, agent: Agent, access: Access, by: Author) {
  if (access.can('manage', agent.channel)) return true
  const parent = agent.parent === null ? undefined : own(state.agents, agent.parent)
  return parent?.status === 'enabled' && parent.channel === agent.channel &&
    (parent.role === 'coordinator' || parent.role === 'controller') && sameBinding(parent.binding, by) && mayReceive(access, agent.channel)
}

function effective(intent: AgentIntent, agent: Agent, now: number): AgentIntent {
  if (intent.state === 'reported') return intent
  if (agent.status !== 'enabled' || agent.generation !== intent.generation) return { ...intent, state: 'fenced' }
  if (Date.parse(intent.expiresAt) <= now) return { ...intent, state: 'expired' }
  return intent
}

function checkGeneration(agent: Agent, generation: number) {
  if (agent.generation !== generation) throw conflict('agent_generation_conflict', 'the agent is not at that generation')
}

export function createAgentIntents(ctx: WriteContext, { accessNow }: BoardBinding, freshnessSeconds = 30) {
  if (!Number.isSafeInteger(freshnessSeconds) || freshnessSeconds < 1) throw new RangeError('agentHealthFreshnessSeconds must be a positive integer')
  const snapshot = () => ctx.session.state(agentIntentsReducer, { through: 'latest' })
  type Snapshot = Awaited<ReturnType<typeof snapshot>>

  async function change<T>(decide: (snapshot: Snapshot, now: number) => Promise<{ answer: T; events: Events }>): Promise<T> {
    let answer!: T
    const rows = await appendFrom(ctx, async (now) => {
      const view = await snapshot()
      const decision = await decide(view, now)
      answer = decision.answer
      return { position: view.index, events: decision.events }
    })
    await untilApplied(ctx, rows)
    return answer
  }

  async function readTaskAt(task: string, index: number, access: Access) {
    const id = indexOf(task)
    if (!id || !Number.isSafeInteger(id) || id > index) return
    // messagesAt is historical, not merely caught up: the registry and task checks must see the
    // same board index even when the tables have already applied a competing appender's write.
    const root = (await ctx.reads.messagesAt([id], index)).get(id)
    if (!root?.task || root.deleted || !access.readable(root.channel)) return
    return { id, channel: root.channel, task: root.task }
  }

  async function taskAt(task: string, index: number, access: Access) {
    const root = await readTaskAt(task, index, access)
    if (!root) throw missingTask()
    return root
  }

  async function findRun(view: Snapshot, run: AgentRun, agent: Agent, access: Access,
    getStatus = async () => (await ctx.work.at(view.index)).status) {
    const root = await taskAt(run.task, view.index, access)
    if (root.channel !== agent.channel) throw missingTask()
    const { task } = root
    const claim = claimForRun(task, run)
    if (!claim) throw claimLost()
    const by = own(view.state.claims, runKey(root.id, run.epoch))
    if (!by || by.actor !== claim.actor || !sameBinding(agent.binding, by)) throw missingTask()
    if (claimFenced(task, await getStatus())) throw claimLost()
    return Date.parse(claim.until)
  }

  async function issue(caller: Caller, input: Issue) {
    const identity = verified(caller)
    if (!identity) throw forbidden('issuing an intent requires a recheckable credential')
    const { author, principal } = identity
    const { access } = principal
    const { generation, requestId, ttlSeconds, verb, run } = input
    const address = 'agent' in input ? ['agent', input.agent] : ['role', input.channel, input.role]
    const requestKey = JSON.stringify([author.principal, author.profile, address[0], requestId])
    const requestHash = createHash('sha256').update(JSON.stringify([address, generation, ttlSeconds, verb, run ? [run.task, run.epoch] : null])).digest('hex')
    const issuer = {
      id: principal.id,
      kind: principal.kind,
      handle: principal.handle,
      ...(principal.facts ? { facts: principal.facts } : {}),
      ...(principal.scope === undefined ? {} : { scope: principal.scope }),
      expiresAt: principal.expiresAt?.toISOString() ?? null,
    }
    return change(async (view, now) => {
      const { state } = view
      const permitted = (agent: Agent | undefined) => {
        if (!agent || !access.readable(agent.channel)) throw missingAgent()
        if (!mayIssue(state, agent, access, author)) throw forbidden('only a manager or the enabled parent can issue this intent')
        return agent
      }
      const target = 'agent' in input ? permitted(own(state.agents, input.agent)) : null
      if ('channel' in input && !access.readable(input.channel)) throw missingAgent()
      const previous = own(state.issues, requestKey)
      if (previous) {
        if (previous.hash !== requestHash) throw duplicateId()
        const intents = previous.ids.map((id) => {
          const { intent } = state.intents[id]!
          return effective(intent, permitted(own(state.agents, intent.agent)), now)
        })
        return { answer: { intents }, events: [] }
      }
      const agents = target ? [target] : []
      if ('channel' in input) {
        for (const agent of Object.values(state.agents)) {
          if (agent.channel !== input.channel || agent.status !== 'enabled' || agent.role !== input.role) continue
          agents.push(permitted(agent))
          if (agents.length > MAX_TARGETS) throw badRequest('a role intent can address at most 64 agents', 'too_many_agents')
        }
      }
      if (agents.length === 0) throw missingAgent()
      for (const agent of agents) {
        checkGeneration(agent, generation)
        if (agent.status !== 'enabled') throw conflict('agent_disabled', 'the agent is disabled')
      }
      if (run && agents.length !== 1) throw badRequest('a run probe must address exactly one agent', 'invalid_run_probe')
      const leaseUntil = run ? await findRun(view, run, agents[0]!, access) : Infinity
      if (leaseUntil <= now) throw claimLost()
      const intents = agents.map((agent): AgentIntent => ({
        id: crypto.randomUUID(), agent: agent.id, generation, by: author,
        createdAt: iso(now), expiresAt: iso(now + ttlSeconds * 1000), verb,
        ...(run ? { run } : {}), state: 'pending', taken: null, report: null,
      }))
      return { answer: { intents }, events: [{ type: 'ops.intents_issued', payload: { intents, requestKey, requestHash, issuer } }] }
    })
  }

  async function checkIssuer(state: AgentIntentsState, agent: Agent,
    { intent, requestKey }: AgentIntentsState['intents'][string], now: number, cachedAccess?: Map<string, Access | null>) {
    const { issuer } = state.issues[requestKey]!
    let allowed = cachedAccess?.get(requestKey)
    if (allowed === undefined) {
      // Grants live in their own session: ask policy for current access after reading the board snapshot.
      allowed = await accessNow(issuer, undefined, now)
      cachedAccess?.set(requestKey, allowed)
    }
    if (!allowed || !mayIssue(state, agent, allowed, intent.by))
      throw new HttpError(403, 'issuer_revoked', 'the issuer may no longer issue this intent')
    if (issuer.expiresAt !== null && Date.parse(issuer.expiresAt) <= now)
      throw new HttpError(403, 'issuer_revoked', 'the issuer credential has expired')
  }

  async function receive(caller: Caller, id: string, generation: number, outcome?: NonNullable<AgentIntent['report']>['outcome']) {
    const identity = verified(caller)
    if (!identity) throw missingIntent()
    const { author, principal: { access } } = identity
    return change<AgentIntent>(async (view, now) => {
      const { state } = view
      const row = own(state.intents, id)
      const agent = row && own(state.agents, row.intent.agent)
      if (!row || !agent || !sameBinding(agent.binding, author)) throw missingIntent()
      authorize(access, 'post', agent.channel, missingIntent)
      const { intent } = row
      checkGeneration(agent, generation)
      if (agent.status !== 'enabled' || intent.generation !== generation) throw conflict('intent_fenced', 'the intent is fenced')
      if (Date.parse(intent.expiresAt) <= now) throw conflict('intent_expired', 'the intent has expired')
      if (outcome === undefined) {
        if (intent.state !== 'pending') throw conflict('intent_taken', 'the intent has already been taken')
      } else {
        const probeOutcome = outcome === 'running' || outcome === 'not_running' || outcome === 'unknown'
        if (probeOutcome !== (intent.run !== undefined)) throw badRequest('the outcome does not match the intent', 'invalid_intent_outcome')
        if (!intent.taken) throw conflict('intent_not_taken', 'the intent has not been taken')
      }
      const leaseUntil = intent.run ? await findRun(view, intent.run, agent, access) : Infinity
      if (outcome === undefined) await checkIssuer(state, agent, row, now)
      if (leaseUntil <= now) throw claimLost()
      const receipt = { by: author, generation, at: iso(now) }
      if (outcome === undefined)
        return { answer: { ...intent, state: 'taken', taken: receipt }, events: [{ type: 'ops.intent_taken', payload: { intentId: id, receipt } }] }
      if (intent.report) {
        if (intent.report.outcome !== outcome) throw conflict('intent_reported', 'the intent already has a different report')
        return { answer: intent, events: [] }
      }
      const report = { ...receipt, outcome }
      return { answer: { ...intent, state: 'reported', report }, events: [{ type: 'ops.intent_reported', payload: { intentId: id, receipt: report } }] }
    })
  }

  return {
    issue,
    async list({ author, principal: { access } }: Identity, id: string, after: string | undefined) {
      const view = await snapshot()
      const { state, index } = view
      const agent = own(state.agents, id)
      if (!agent || !access.readable(agent.channel) || (!access.can('manage', agent.channel) &&
          !(agent.status === 'enabled' && sameBinding(agent.binding, author)))) throw missingAgent()
      const cursor = after === undefined ? undefined : own(state.intents, after)
      if (after !== undefined && cursor?.intent.agent !== id) throw badRequest('invalid intent cursor', 'invalid_cursor')
      const ids = own(state.byAgent, id) ?? []
      let i = cursor ? cursor.offset + 1 : 0
      const stop = Math.min(ids.length, i + SCAN)
      const now = Date.now()
      const intents: AgentIntent[] = []
      // Different issues from the same principal can carry different credentials or scopes.
      const issuerAccess = new Map<string, Access | null>()
      let status: WorkState | undefined
      const getStatus = async () => (status ??= (await ctx.work.at(index)).status)
      for (; i < stop && intents.length < PAGE; i++) {
        const row = state.intents[ids[i]!]!
        const intent = effective(row.intent, agent, now)
        if (intent.state !== 'pending') continue
        if (intent.run) {
          try {
            if (await findRun(view, intent.run, agent, access, getStatus) <= now) continue
            await checkIssuer(state, agent, row, now, issuerAccess)
          } catch (error) {
            if (error instanceof HttpError && (error.code === 'not_a_task' || error.code === 'claim_lost' || error.code === 'issuer_revoked')) continue
            throw error
          }
        }
        intents.push(intent)
      }
      return { intents, next: i < ids.length ? ids[i - 1]! : null }
    },
    take: (caller: Caller, id: string, generation: number) => receive(caller, id, generation),
    report: (caller: Caller, id: string, generation: number, outcome: NonNullable<AgentIntent['report']>['outcome']) => receive(caller, id, generation, outcome),
    async health({ principal: { access } }: Identity, taskRef: string): Promise<AgentHealth> {
      const { state, index } = await snapshot()
      const { id, channel, task } = await taskAt(taskRef, index, access)
      const notConfirmed = { state: 'not_confirmed' } as const
      if (!task.claim) return notConfirmed
      const key = runKey(id, task.epoch)
      const newest = own(state.probes, key)
      if (!newest) return notConfirmed
      const { intent } = state.intents[newest]!
      if (intent.report?.outcome !== 'running') return notConfirmed
      const agent = own(state.agents, intent.agent)
      const by = own(state.claims, key)
      if (agent?.status !== 'enabled' || agent.channel !== channel || agent.generation !== intent.generation ||
          !by || by.actor !== task.claim.actor || !sameBinding(agent.binding, by)) return notConfirmed
      if (claimFenced(task, (await ctx.work.at(index)).status)) return notConfirmed
      const validUntil = Math.min(Date.parse(intent.expiresAt), Date.parse(intent.report.at) + freshnessSeconds * 1000, Date.parse(task.claim.until))
      return Date.now() < validUntil ? { state: 'working', validUntil: iso(validUntil) } : notConfirmed
    },
  }
}
