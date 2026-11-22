import type { Board } from '@vercel/board'
import {
  compareInstants, inspectMailBlock, labelMail, matchesMailKey, readableMailKey, readMailRoots, type MailRoot,
} from './inbox.ts'
import { MAIL_LABELS, MAIL_STATES, MailError, type MailMessage } from './message.ts'
import { matchesMailBlock, postMail } from './send.ts'

export type RelayOptions = {
  source: { name: string; board: Pick<Board, 'channel' | 'reply' | 'label'>; outbox: string }
  boards: Record<string, Board>
  now: () => Date
}

export type RelayReport = { delivered: number; pending: number; rejected: number; down: string[] }

type Delivery = { root: MailRoot; message: MailMessage; key: string; channel: string }

const { state } = MAIL_LABELS
const { open, forwarded, rejected, expired } = MAIL_STATES

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
  return {
    root, message, name: message.to.slice(0, slash), channel: message.to.slice(slash + 1),
    key: readable ?? `mail:${source}:${message.id}`,
  }
}

export function createRelay({ source, boards, now }: RelayOptions) {
  function setState(root: MailRoot, next: string) {
    return labelMail(source.board, root.id, root.labels[state] ?? null, { [state]: next })
  }

  async function reject(root: MailRoot, reason: string) {
    // Write the reason before the terminal state so a retry can finish either write.
    await source.board.reply(root.id, { id: `rejection:${root.id}:${reason}`, text: reason })
    return await setState(root, rejected) ? 'rejected' : 'pending'
  }

  async function reconcile(board: Board, { root, message, key, channel }: Delivery, clock: string) {
    const pastExpiry = message.expires !== undefined && compareInstants(message.expires, clock) <= 0
    try {
      if (pastExpiry) {
        // Don't send expired mail, but still finish a receipt if a previous pass landed it.
        const landed = await board.posted(key)
        return landed.channel === channel && landed.re === null && matchesMailBlock(landed, message)
          ? { landed } as const : { result: 'id_collision' } as const
      }
      // A sender with only post cannot forge swarm.delivery: the relay has label rights.
      const landed = await postMail(board, channel, message, key, { 'swarm.delivery': `${source.name}:${root.id}` })
      return { landed } as const
    } catch (error) {
      if (error instanceof MailError && error.reason === 'id_collision') return { result: 'id_collision' } as const
      if (pastExpiry && error && typeof error === 'object' && 'status' in error && error.status === 404 &&
          'code' in error && error.code === 'post_not_found') return { result: 'expired' } as const
      return { result: 'down' } as const
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
      deliveries.sort((a, b) => a.message.urgency.localeCompare(b.message.urgency))
      const queues = new Map<string, Delivery[]>()
      for (const entry of deliveries) {
        const queue = queues.get(entry.name)
        if (queue) queue.push(entry)
        else queues.set(entry.name, [entry])
      }

      // Independent queues keep a slow destination from holding up another board.
      const at = clock.toISOString()
      const down = await Promise.all([...queues].map(async ([name, queue]) => {
        const board = boards[name]!
        for (const [index, entry] of queue.entries()) {
          const { root, channel } = entry
          const { landed, result } = await reconcile(board, entry, at)
          if (landed) {
            await source.board.reply(root.id, {
              id: `delivery:${root.id}`, text: `delivered to ${name}/${channel}: ${landed.id}`,
            })
            report[await setState(root, forwarded) ? 'delivered' : 'pending']++
          } else if (result === 'id_collision') {
            report[await reject(root, result)]++
          } else if (result === 'expired') {
            if (!await setState(root, expired)) report.pending++
          } else {
            report.pending += queue.length - index
            return name
          }
        }
      }))
      report.down = down.filter((name) => name !== undefined)
      for (const { root, reason } of invalid) report[await reject(root, reason)]++
      return report
    },
  }
}
