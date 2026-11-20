import type { MessageView } from '@vercel/board'

export type ControllerRecipient = { agent: string } | { role: string }

/** The board's inbox view, including the calling principal's receipts. */
export type ControllerMessage = Readonly<{
  id: string
  to: Readonly<ControllerRecipient>
  topic: string
  text: string
  by: Readonly<MessageView['by']>
  sentAt: string
  expiresAt: string | null
  seenAt: string | null
  actedAt: string | null
  archivedAt: string | null
}>

export interface ControllerBoard {
  /** A page of the board's event long-poll (`wait` in seconds). Only its cursor is needed. */
  poll(query: { after?: string; wait: number }, signal: AbortSignal): Promise<{ cursor: string }>
  operationalInbox: {
    read(): Promise<{ messages: readonly ControllerMessage[] }>
    ack(id: string, status: 'seen' | 'acted'): Promise<{ message: ControllerMessage }>
    send(input: { to: ControllerRecipient; topic: string; text: string }): Promise<{ message: ControllerMessage }>
  }
}

export interface ControllerRegistry {
  /** Resolve the immediate parent's inbox address, not a role or a list of ancestors. */
  parentOf(agent: string): string | null | Promise<string | null>
}

export interface ControllerClock {
  /** Monotonic milliseconds. This clock does not author board timestamps. */
  now(): number
  /** Wait for at least `ms`, or reject on abort. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export type ControllerOptions = {
  board: ControllerBoard
  registry: ControllerRegistry
  clock: ControllerClock
  agent: string
  roles?: readonly string[]
  /** Time from first observation to escalation eligibility. */
  ackTimeoutMs: number
  /** Feed wait in whole seconds, 1–25. Defaults to 25. */
  longPollSeconds?: number
  /** Signal to stop the loop and cancel pending checks. */
  signal: AbortSignal
  /** Return 'acted' on completion. Returning nothing or throwing leaves the message unacted. */
  wake(message: ControllerMessage, signal: AbortSignal): void | 'acted' | Promise<void | 'acted'>
}

const unacted = (message: ControllerMessage) => message.actedAt === null && message.archivedAt === null

/** Follow one principal's inbox. Wake and escalation deduplication lasts for this invocation. */
export async function runController(options: ControllerOptions): Promise<void> {
  const { board, registry, clock, agent, roles = [], ackTimeoutMs, longPollSeconds = 25, wake } = options
  if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 2_147_483_647) {
    throw new RangeError('invalid ackTimeoutMs')
  }
  if (!Number.isInteger(longPollSeconds) || longPollSeconds < 1 || longPollSeconds > 25) {
    throw new RangeError('invalid longPollSeconds')
  }

  const { operationalInbox: inbox } = board
  const stopped = new AbortController()
  const signal = AbortSignal.any([options.signal, stopped.signal])
  const roleSet = new Set(roles)
  const handled = new Set<string>()
  const addressed = ({ to }: ControllerMessage) => 'agent' in to ? to.agent === agent : roleSet.has(to.role)
  let after: string | undefined

  function start(message: ControllerMessage) {
    const id = message.id
    handled.add(id)
    const acted = new AbortController()
    const pending = AbortSignal.any([signal, acted.signal])

    async function deliver() {
      // Use the server's receipt, including any acted receipt written since the read.
      const receipt = message.seenAt === null ? (await inbox.ack(id, 'seen')).message : message
      if (signal.aborted || !unacted(receipt)) {
        acted.abort()
        return
      }
      let result: void | 'acted'
      try {
        result = await wake(receipt, signal)
      } catch {
        // A handler failure is not an acted receipt. Leave the deadline armed.
        return
      }
      if (result === 'acted' && !signal.aborted) {
        await inbox.ack(id, 'acted')
        acted.abort()
      }
    }

    async function escalate() {
      try {
        await clock.sleep(ackTimeoutMs, pending)
      } catch (error) {
        if (pending.aborted) return
        throw error
      }
      if (pending.aborted) return
      const parent = await registry.parentOf(agent)
      if (pending.aborted || parent === null || parent === agent) return
      // Use a fresh inbox view after the parent lookup. A receipt by another
      // client, or a message no longer visible, must not produce an escalation.
      const { messages } = await inbox.read()
      if (!pending.aborted && messages.some((current) => current.id === id && addressed(current) && unacted(current))) {
        await inbox.send({
          to: { agent: parent },
          topic: `escalation:${id}`,
          text: `Operational message ${id} addressed to ${agent} was not acted on before its deadline.`,
        })
      }
    }

    void escalate().catch((error: unknown) => stopped.abort(error))
    void deliver().catch((error: unknown) => {
      // It can disappear (expire, be replaced or be archived) between read and ack.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'operational_message_not_found') acted.abort()
      else stopped.abort(error)
    })
  }

  try {
    while (!signal.aborted) {
      const nextPoll = clock.now() + longPollSeconds * 1_000
      const page = await board.poll({ after, wait: longPollSeconds }, signal)
      if (signal.aborted) break
      after = page.cursor
      // Operational payloads are private. Even an empty page can be a wakeup;
      // only the authenticated inbox read says what can be delivered.
      const { messages } = await inbox.read()
      if (signal.aborted) break
      for (const message of messages) {
        if (addressed(message) && unacted(message) && !handled.has(message.id)) start(message)
      }
      const remaining = nextPoll - clock.now()
      if (remaining > 0) await clock.sleep(remaining, signal)
    }
    signal.throwIfAborted()
  } catch (error) {
    if (!options.signal.aborted) throw signal.aborted ? signal.reason : error
  } finally {
    stopped.abort()
  }
}
