// The board's views as A2 reducers: the folds in `folds.ts`, named and seeded for the engine.
// Only the local board's engine loads this module; anything else folds with `folds.ts` directly.
import { reducer } from 'experimental-a2'
import type { InviteView } from '../api/routes.ts'
import type { WrittenCan } from '../server/access.ts'
import type { GrantPrincipal } from '../server/auth.ts'
import { accessContract, boardContract, type AccessEvent } from './contract.ts'
import type { BoardEvent } from './events.ts'
import type { OperationalRecipient, OperationalStatus } from './operational-inbox.ts'
import { foldActors, foldMessages, type ActorsState, type ChannelsState, type MessagesState } from './folds.ts'
import { own, setOwn } from './own.ts'
import type { AgentIntent, Author } from './schemas.ts'

export type GrantRow = {
  id: number
  /** The event that created it, null for a default grant. */
  event: number | null
  /** The last content write's index, or zero for an unchanged default. */
  version: number
  principals: GrantPrincipal[]
  can: WrittenCan
  by: string | null
  at: number | null
  needsOidcSubjectReview?: true
}
export type InviteRow = Omit<InviteView, 'expiresAt' | 'state'> & {
  expiresAt: number
  state: Exclude<InviteView['state'], 'expired'>
  digest: string
  by: string
}

export type AccessState = {
  grants: Record<string, GrantRow>
  nextGrant: number
  invites: Record<string, InviteRow>
  pending: Record<string, string>
  joined: Record<string, { id: string; name: string; audience: string }>
  /** Null before the baseline, otherwise the number of grants still under review. */
  oidcStarPending: number | null
}

const defaultGrant = (id: number, principals: GrantPrincipal[], can: WrittenCan): GrantRow => ({
  id, principals, can, event: null, version: 0, by: null, at: null,
})

// The same defaults as Vercel's board. A local board has neither team roles nor app callers.
export const startingAccess = (): AccessState => ({
  grants: {
    1: defaultGrant(1, [{ kind: 'all-users' }], { '*': 'all' }),
    2: defaultGrant(2, [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], { '*': ['read', 'post', 'react', 'label', 'sync'] }),
    3: defaultGrant(3, [{ kind: 'all-apps' }], { '*': ['read', 'post', 'react', 'label'] }),
  },
  nextGrant: 4, invites: {}, pending: {}, joined: {}, oidcStarPending: null,
})

/** Every trailing star is reviewed, even a literal that upstream's subPrefix does not accept. */
export function hasTrailingOidcStar(principals: readonly GrantPrincipal[]): boolean {
  return principals.some((principal) => {
    if (principal.kind !== 'oidc') return false
    const sub = principal.claims.sub
    return typeof sub === 'string' ? sub.endsWith('*') : sub?.some((value) => value.endsWith('*')) === true
  })
}

function clearOidcSubjectReview(state: AccessState, row: GrantRow | undefined) {
  if (row?.needsOidcSubjectReview && state.oidcStarPending !== null) {
    delete row.needsOidcSubjectReview
    state.oidcStarPending--
  }
}

export function foldAccess(state: AccessState, event: AccessEvent): AccessState {
  const at = new Date(event.createdAt).getTime()
  switch (event.type) {
    // From before grants named principals, and from when boards issued tokens: they let no one in now.
    case 'grant.set':
    case 'grant.revoked':
    case 'token.minted':
    case 'token.revoked':
      break
    case 'grant.created': {
      const { principals, can, by } = event.payload
      const id = state.nextGrant++
      state.grants[id] = { id, event: event.index, version: event.index, principals: principals as GrantPrincipal[], can: can as WrittenCan, by, at }
      break
    }
    case 'grant.updated': {
      const { id, principals, can, by } = event.payload
      const row = state.grants[id]
      if (row) {
        Object.assign(row, { version: event.index, principals, can, by, at })
        // An ordinary edit is not consent to prefix matching, even for a different star value.
        if (row.needsOidcSubjectReview && !hasTrailingOidcStar(row.principals)) clearOidcSubjectReview(state, row)
      }
      break
    }
    case 'grant.deleted':
      clearOidcSubjectReview(state, state.grants[event.payload.id])
      delete state.grants[event.payload.id]
      break
    case 'grant.oidc_star_baseline': {
      if (state.oidcStarPending !== null) break
      state.oidcStarPending = 0
      for (const { id, version } of event.payload.grants) {
        const row = state.grants[id]
        if (!row || row.version !== version || row.needsOidcSubjectReview) throw new Error('invalid OIDC subject review baseline')
        row.needsOidcSubjectReview = true
        state.oidcStarPending++
      }
      break
    }
    case 'grant.oidc_star_acknowledged': {
      const { id, version, by } = event.payload
      const row = state.grants[id]
      if (row?.needsOidcSubjectReview && row.version === version) {
        clearOidcSubjectReview(state, row)
        Object.assign(row, { by, at })
      }
      break
    }
    case 'invite.created': {
      const { id, digest, can } = event.payload
      state.invites[id] = { ...event.payload, can: can as InviteView['can'], state: 'pending' }
      state.pending[digest] = id
      break
    }
    case 'invite.revoked': {
      const row = state.invites[event.payload.id]!
      row.state = 'revoked'
      delete state.pending[row.digest]
      break
    }
    case 'invite.redeemed': {
      const { id, principal, digest, audience } = event.payload
      const row = state.invites[id]!
      row.state = 'redeemed'
      delete state.pending[row.digest]
      state.joined[digest] = { id: principal, name: row.name, audience }
      const grant = state.nextGrant++
      state.grants[grant] = { id: grant, event: event.index, version: event.index, principals: [{ kind: 'invitee', id: principal }], can: row.can, by: row.by, at }
      break
    }
  }
  return state
}

export const accessReducer = reducer({
  contract: accessContract,
  // v6 replays older grants to recover their last content versions and the upgrade review.
  name: 'board.access.v6',
  initialState: startingAccess(),
}).fold(foldAccess)

export const messagesReducer = reducer({
  contract: boardContract,
  name: 'board.messages.v5',
  initialState: { byId: {}, replies: {} } as MessagesState,
}).fold(foldMessages)

/**
 * Each post's event ID → its message: a retried write with the same ID is already on
 * the board, and doesn't go through the middleware again.
 */
export const postedReducer = reducer({
  contract: boardContract,
  name: 'board.posted.v1',
  initialState: {} as Record<string, number>,
}).fold((state, event) => {
  if (event.type === 'message.posted') setOwn(state, event.id, event.index)
  return state
})

const emptyChannel = (path: string) => ({ path, lastIndex: 0, messages: 0, threads: 0 })

export const channelsReducer = reducer({
  contract: boardContract,
  // v2 folds `channel.created`: a v1 snapshot an older deployment made may have passed one by.
  name: 'board.channels.v2',
  initialState: {} as ChannelsState,
}).fold((state, event) => {
  if (event.type === 'channel.created') {
    if (!own(state, event.payload.channel)) setOwn(state, event.payload.channel, emptyChannel(event.payload.channel))
    return state
  }
  if (event.type !== 'message.posted') return state
  const { channel, re } = event.payload
  const entry = own(state, channel) ?? setOwn(state, channel, emptyChannel(channel))
  entry.lastIndex = event.index
  entry.messages += 1
  if (re === null) entry.threads += 1
  return state
})

export type WorkState = { paused: boolean; pauseEpoch: number; resumedAt: number | null }

export const workReducer = reducer({
  contract: boardContract,
  name: 'board.work.control.v1',
  initialState: { paused: false, pauseEpoch: 0, resumedAt: null } as WorkState,
}).fold((state, event) => {
  if (event.type === 'work.control') {
    state.paused = event.payload.paused
    state.pauseEpoch = event.payload.pauseEpoch
    state.resumedAt = state.paused ? null : new Date(event.createdAt).getTime()
  }
  return state
})

type Receipt = { seenAt: string | null; actedAt: string | null; archivedAt: string | null }

export const emptyOperationalReceipt = (): Receipt => ({ seenAt: null, actedAt: null, archivedAt: null })
export const operationalRecipientKey = (to: OperationalRecipient) => JSON.stringify('agent' in to ? ['agent', to.agent] : ['role', to.role])

export type OperationalEntry = Omit<BoardEvent<'operational.sent'>['payload'], 'message'> & {
  id: string
  index: number
  receipts: Record<string, Receipt>
}

type OperationalState = {
  byId: Record<string, OperationalEntry>
  topics: Record<string, Record<string, string>>
}

/** The current message for each address and topic, and that message's per-principal receipts. */
export const operationalInboxReducer = reducer({
  contract: boardContract,
  name: 'board.operational-inbox.v1',
  initialState: { byId: {}, topics: {} } as OperationalState,
}).fold((state, event) => {
  if (event.type === 'operational.sent') {
    const { message: id, ...payload } = event.payload
    const key = operationalRecipientKey(payload.to)
    const topics = own(state.topics, key) ?? setOwn(state.topics, key, {})
    const replaced = own(topics, payload.topic)
    if (replaced !== undefined) delete state.byId[replaced]
    setOwn(topics, payload.topic, id)
    setOwn(state.byId, id, { ...payload, id, index: event.index, receipts: {} })
  } else if (event.type === 'operational.acked' || event.type === 'operational.archived') {
    const { message, by, at } = event.payload
    const found = own(state.byId, message)
    if (found) {
      const receipt = own(found.receipts, by.principal) ?? emptyOperationalReceipt()
      const status = event.type === 'operational.acked' ? event.payload.status : 'archive'
      setOwn(found.receipts, by.principal, operationalReceiptAfter(found, receipt, status, at))
    }
  }
  return state
})

/** Receipt times never move backward, even if the wall clock does. */
export function operationalReceiptAfter(message: OperationalEntry, receipt: Receipt, status: OperationalStatus | 'archive', at: string): Receipt {
  if (receipt.archivedAt !== null) return receipt
  const time = new Date(Math.max(Date.parse(at), Date.parse(receipt.actedAt ?? receipt.seenAt ?? message.sentAt))).toISOString()
  if (status === 'archive') return { ...receipt, archivedAt: time }
  return { ...receipt, seenAt: receipt.seenAt ?? time, actedAt: receipt.actedAt ?? (status === 'acted' ? time : null) }
}

export const actorsReducer = reducer({
  contract: boardContract,
  name: 'board.actors.v2',
  initialState: { byId: {}, byHandle: {} } as ActorsState,
}).fold(foldActors)

export const agentsReducer = reducer({
  contract: boardContract,
  name: 'board.agents.v1',
  initialState: {} as Record<string, BoardEvent<'ops.agent_changed'>['payload']['agent']>,
}).fold((state, event) => {
  if (event.type === 'ops.agent_changed') setOwn(state, event.payload.agent.id, event.payload.agent)
  return state
})

type Issue = BoardEvent<'ops.intents_issued'>['payload']
export const runKey = (task: number, epoch: number) => `${task}:${epoch}`

export type AgentIntentsState = {
  agents: Record<string, BoardEvent<'ops.agent_changed'>['payload']['agent']>
  intents: Record<string, { intent: AgentIntent; requestKey: string; order: number; offset: number }>
  issues: Record<string, { ids: string[]; hash: string; issuer: Issue['issuer'] }>
  byAgent: Record<string, string[]>
  claims: Record<string, Author>
  /** The newest reported probe per run, ordered by issue, never by receipt. */
  probes: Record<string, string>
}

export const agentIntentsReducer = reducer({
  contract: boardContract,
  name: 'board.agent-intents.v1',
  initialState: { agents: {}, intents: {}, issues: {}, byAgent: {}, claims: {}, probes: {} } as AgentIntentsState,
}).fold((state, event) => {
  switch (event.type) {
    case 'ops.agent_changed':
      setOwn(state.agents, event.payload.agent.id, event.payload.agent)
      break
    case 'task.claimed': {
      const { id, epoch, by } = event.payload
      const key = runKey(id, epoch)
      if (!own(state.claims, key)) setOwn(state.claims, key, by)
      break
    }
    case 'ops.intents_issued': {
      const { intents, requestKey, requestHash, issuer } = event.payload
      const ids: string[] = []
      for (const intent of intents) {
        const byAgent = own(state.byAgent, intent.agent) ?? setOwn(state.byAgent, intent.agent, [])
        setOwn(state.intents, intent.id, { intent, requestKey, order: event.index, offset: byAgent.length })
        byAgent.push(intent.id)
        ids.push(intent.id)
      }
      setOwn(state.issues, requestKey, { ids, hash: requestHash, issuer })
      break
    }
    case 'ops.intent_taken': {
      const row = own(state.intents, event.payload.intentId)
      if (row?.intent.state === 'pending') {
        row.intent.taken = event.payload.receipt
        row.intent.state = 'taken'
      }
      break
    }
    case 'ops.intent_reported': {
      const row = own(state.intents, event.payload.intentId)
      if (row?.intent.state !== 'taken') break
      row.intent.report = event.payload.receipt
      row.intent.state = 'reported'
      const run = row.intent.run
      if (run) {
        // Run refs on issue are canonical local task IDs, as returned by the task routes.
        const key = runKey(Number(run.task), run.epoch)
        const previous = own(state.probes, key)
        if (previous === undefined || state.intents[previous]!.order < row.order) setOwn(state.probes, key, row.intent.id)
      }
      break
    }
  }
  return state
})
