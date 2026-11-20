// The board's views as A2 reducers: the folds in `folds.ts`, named and seeded for the engine.
// Only the local board's engine loads this module; anything else folds with `folds.ts` directly.
import { reducer } from 'experimental-a2'
import { boardContract } from './contract.ts'
import type { BoardEvent } from './events.ts'
import type { OperationalRecipient, OperationalStatus } from './operational-inbox.ts'
import { foldActors, foldMessages, type ActorsState, type ChannelsState, type MessagesState } from './folds.ts'
import { own, setOwn } from './own.ts'

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
