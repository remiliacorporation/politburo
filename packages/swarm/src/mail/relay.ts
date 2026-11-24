import type { Board } from '@vercel/board'
import {
  inspectMailBlock, labelMail, matchesMailKey, readableMailKey, readMailRoots, type MailRoot,
} from './inbox.ts'
import { MAIL_LABELS, MAIL_STATES, MAIL_URGENCIES, MailError, type MailMessage } from './message.ts'
import { postMail } from './send.ts'

export type RelayOptions = {
  source: { name: string; board: Pick<Board, 'channel' | 'reply' | 'label'>; outbox: string }
  boards: Record<string, Board>
  now: () => Date
  timeoutMs?: number
}

export type RelayReport = { delivered: number; pending: number; rejected: number; down: string[] }

type Delivery = { root: MailRoot; message: MailMessage; key: string; channel: string }

const { state, origin } = MAIL_LABELS
const { open, forwarded, rejected } = MAIL_STATES

function isPending(root: MailRoot) {
  return root.labels[state] === undefined || root.labels[state] === open
}

function route(root: MailRoot, now: Date, source: string) {
  const { message, reason } = inspectMailBlock(root, now)
  if (!message) return { reason }
  if (!message.to) return { reason: 'missing_to' }
  const readable = readableMailKey(root)
  if (readable !== undefined && !matchesMailKey(readable, message.id)) return { reason: 'invalid_post_key' }
  const slash = message.to.indexOf('/')
  // The mail contract already requires nonempty slug segments (and forbids NUL).
  const channel = message.to.slice(slash + 1)
  if (channel.length > 512) return { reason: 'destination_refused' }
  return { root, message, name: message.to.slice(0, slash), channel, key: readable ?? `mail:${source}:${root.id}` }
}

export function createRelay({ source, boards, now, timeoutMs = 10_000 }: RelayOptions) {
  function setState(root: MailRoot, next: string) {
    return labelMail(source.board, root.id, root.labels[state] ?? null, { [state]: next })
  }

  async function reject(root: MailRoot, reason: string) {
    // Write the reason before the terminal state so a retry can finish either write.
    await source.board.reply(root.id, { id: `rejection:${root.id}:${reason}`, text: reason, noSync: true })
    return await setState(root, rejected) ? 'rejected' : 'pending'
  }

  async function reconcile(board: Board, { root, message, key, channel }: Delivery) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The handle can't cancel post. A late write is reconciled with the same key on retry.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('destination timed out')), timeoutMs)
      })
      const labels = { 'swarm.delivery': `${source.name}:${root.id}`,
        ...(root.labels[origin] === 'file' && { [origin]: 'file' }),
      }
      // postMail reconciles by payload, not by mutable labels.
      const landed = await Promise.race([postMail(board, channel, message, key, labels), deadline])
      return { landed } as const
    } catch (error) {
      if (error instanceof MailError && error.reason === 'id_collision') return { result: 'id_collision' } as const
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return { result: 'destination_refused' } as const
      }
      return { result: 'down' } as const
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async deliverOnce(): Promise<RelayReport> {
      const clock = now()
      const report: RelayReport = { delivered: 0, pending: 0, rejected: 0, down: [] }
      const invalid: { root: MailRoot; reason: string }[] = []
      const deliveries: (Delivery & { name: string })[] = []
      for (const root of await readMailRoots(source.board, source.outbox)) {
        if (!isPending(root)) continue
        const entry = route(root, clock, source.name)
        if (entry.reason !== undefined) invalid.push({ root, reason: entry.reason })
        else if (!Object.hasOwn(boards, entry.name)) invalid.push({ root, reason: 'unknown_board' })
        else deliveries.push(entry)
      }
      const down = new Set<string>()
      for (const urgency of MAIL_URGENCIES) {
        const queues = new Map<string, Delivery[]>()
        for (const entry of deliveries) {
          if (entry.message.urgency !== urgency) continue
          if (down.has(entry.name)) {
            report.pending++
            continue
          }
          const queue = queues.get(entry.name)
          if (queue) queue.push(entry)
          else queues.set(entry.name, [entry])
        }

        // Run boards concurrently within a tier, but wait before starting the next tier.
        const unavailable = await Promise.all([...queues].map(async ([name, queue]) => {
          const board = boards[name]!
          for (const [index, entry] of queue.entries()) {
            const { root, channel } = entry
            const { landed, result } = await reconcile(board, entry)
            if (landed) {
              await source.board.reply(root.id, {
                id: `delivery:${root.id}`, text: `delivered to ${name}/${channel}: ${landed.id}`, noSync: true,
              })
              report[await setState(root, forwarded) ? 'delivered' : 'pending']++
            } else if (result === 'down') {
              report.pending += queue.length - index
              return name
            } else {
              report[await reject(root, result)]++
            }
          }
        }))
        for (const name of unavailable) if (name !== undefined) down.add(name)
      }
      report.down = [...down]
      for (const { root, reason } of invalid) report[await reject(root, reason)]++
      return report
    },
  }
}
