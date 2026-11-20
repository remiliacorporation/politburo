import type { OperationalMessage, OperationalRecipient, OperationalStatus, SendOperationalMessageInput } from '../api/routes.ts'
import { own } from '../contract/own.ts'
import { emptyOperationalReceipt, operationalInboxReducer, operationalReceiptAfter, operationalRecipientKey, type OperationalEntry } from '../contract/reducers.ts'
import { authorView, type Author } from '../contract/schemas.ts'
import type { BoardSession } from './a2.ts'
import { badRequest, notFound } from './errors.ts'
import { whileHeadMoves } from './writes.ts'

const absent = () => notFound('operational message not found', 'operational_message_not_found')
const expired = ({ expiresAt }: { expiresAt: string | null }, now: number) => expiresAt !== null && Date.parse(expiresAt) <= now
const receiptOf = (message: OperationalEntry, principal: string) => own(message.receipts, principal) ?? emptyOperationalReceipt()
const visibleTo = (to: OperationalRecipient, principal: string, roles: readonly string[]) =>
  'agent' in to ? to.agent === principal : roles.includes(to.role)

function messageView({ id, to, topic, text, by, sentAt, expiresAt }: Omit<OperationalMessage, 'seenAt' | 'actedAt' | 'archivedAt'>, receipt = emptyOperationalReceipt()): OperationalMessage {
  return { id, to: { ...to }, topic, text, by: authorView(by), sentAt, expiresAt, ...receipt }
}

/** Private inbox facts share the main log, but only these methods project them to a caller. */
export function createOperationalInbox(session: BoardSession, rolesFor: (principal: string) => readonly string[]) {
  const latest = () => session.state(operationalInboxReducer, { through: 'latest' })

  return {
    async send(by: Author, input: SendOperationalMessageInput, signal: AbortSignal) {
      const now = Date.now()
      const expiry = input.expiresAt === undefined ? null : Date.parse(input.expiresAt)
      if (expiry !== null && !(expiry > now)) throw badRequest('expiresAt must be in the future')
      const expiresAt = expiry === null ? null : new Date(expiry).toISOString()
      // An offset on a four-digit year can normalize into an expanded year, outside the log's schema.
      if (expiresAt?.startsWith('+')) throw badRequest('expiresAt is outside the supported date range')
      // Do not expose the log event ID: regular posts can supply their own event IDs and detect collisions.
      const id = crypto.randomUUID()
      const payload = { to: input.to, topic: input.topic, text: input.text, by, sentAt: new Date(now).toISOString(), expiresAt }
      signal.throwIfAborted()
      await session.append({ type: 'operational.sent', payload: { ...payload, message: id } })
      return { message: messageView({ ...payload, id }) }
    },
    async read(principal: string) {
      const { state } = await latest()
      const now = Date.now()
      const addresses: OperationalRecipient[] = [{ agent: principal }, ...rolesFor(principal).map((role) => ({ role }))]
      const found = addresses.flatMap((to) => Object.values(own(state.topics, operationalRecipientKey(to)) ?? {}).map((id) => state.byId[id]!))
      const messages = found.filter((message) => !expired(message, now) && receiptOf(message, principal).archivedAt === null)
        .sort((a, b) => b.index - a.index)
        .slice(0, 15)
        .map((message) => messageView(message, receiptOf(message, principal)))
      return { messages }
    },
    async change(by: Author, id: string, status: OperationalStatus | 'archive', signal: AbortSignal) {
      return whileHeadMoves(async () => {
        const { state, index } = await latest()
        const now = Date.now()
        const found = own(state.byId, id)
        if (!found || !visibleTo(found.to, by.principal, rolesFor(by.principal)) || expired(found, now)) throw absent()
        const receipt = receiptOf(found, by.principal)
        if (receipt.archivedAt !== null && status !== 'archive') throw absent()
        if (status === 'archive' ? receipt.archivedAt !== null : status === 'seen' ? receipt.seenAt !== null : receipt.actedAt !== null)
          return { message: messageView(found, receipt) }

        // A racing replacement or receipt changes the head, so retry eligibility and idempotency together.
        const at = new Date(now).toISOString()
        signal.throwIfAborted()
        await session.append.ifLastIndex(index, status === 'archive'
          ? { type: 'operational.archived', payload: { message: id, by, at } }
          : { type: 'operational.acked', payload: { message: id, by, at, status } })
        return { message: messageView(found, operationalReceiptAfter(found, receipt, status, at)) }
      })
    },
  }
}
