import type { Board } from '@vercel/board'
import { MAIL_LABELS, MAIL_STATES, labelsFor, validateMessage, type MailMessage } from './message.ts'
import { boardConflict } from './send.ts'

export type InboxOptions = {
  board: Pick<Board, 'channel' | 'label' | 'reply'>
  channel: string
  now: () => Date
}
export type OpenMail = { messageId: string; message: MailMessage }
type Root = Awaited<ReturnType<ReturnType<Board['channel']>['messages']>>['messages'][number]

const { state } = MAIL_LABELS
const { open, handled, forwarded, expired, rejected } = MAIL_STATES
const admitted = new Set<string>([open, handled, forwarded])
const derivedKey = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const remoteThread = /^thr_[0-9a-f-]{36}$/

function matchesKey(root: Root, id: string) {
  // MessageView.id is the mutation ref. A local root's thread is its event key, but
  // handles can hash that key and Vercel exposes a server thread ID instead.
  const key = [root.thread, root.id].find((value) => value?.startsWith('mail:'))
  if (key !== undefined) {
    const split = key.indexOf(':', 'mail:'.length)
    return split > 'mail:'.length && !!key.slice('mail:'.length, split).trim() && key.slice(split + 1) === id
  }
  // An opaque key can't prove the mailbox scope; fall back to board-authored provenance.
  const by = root.by
  if (!by) return false
  const blindKeyPrefix = `key:${by.principal}:`
  const opaque = derivedKey.test(root.thread) || remoteThread.test(root.thread) ||
    (root.thread.startsWith(blindKeyPrefix) && /^[0-9a-f]{32}$/.test(root.thread.slice(blindKeyPrefix.length)))
  return opaque && (root.author?.verified === true ||
    (by.actor === by.principal && /^board:client(?::[a-z0-9_-]+)?$/.test(by.actor)))
}

function inspect(root: Root, now: Date) {
  const [entry] = root.blocks
  if (root.blocks.length !== 1 || entry?.schema !== 'swarm-message' || entry.version !== 1) {
    return { reason: 'invalid_block' } as const
  }
  const [reason] = validateMessage(entry.data, { now })
  if (reason !== undefined) return { reason } as const
  const message = entry.data as MailMessage
  if (!matchesKey(root, message.id)) return { reason: 'invalid_post_key' } as const
  return { message } as const
}

const tuple = ({ from, ref, class: kind }: MailMessage) => JSON.stringify([from, ref, kind])
const submillis = (at: string) => (at.match(/\.\d{3}(\d+)/)?.[1] ?? '').replace(/0+$/, '')

function compareInstants(a: string, b: string) {
  const millis = Date.parse(a) - Date.parse(b)
  if (millis) return millis
  // Date.parse truncates fractions to milliseconds, but admission distinguishes strictly newer mail.
  const left = submillis(a)
  const right = submillis(b)
  return left === right ? 0 : left < right ? -1 : 1
}

export function createInbox({ board, channel, now }: InboxOptions) {
  async function roots(): Promise<Root[]> {
    const inbox = board.channel(channel)
    const found = new Map<string, Root>()
    // Without a cursor the handle starts at the newest page, not the beginning.
    let after = '0'
    for (;;) {
      const page = await inbox.messages({ after, limit: 100 })
      for (const root of page.messages) {
        if (root.re === null && !root.deleted) found.set(root.id, root)
      }
      if (page.cursor === after || page.messages.length === 0) return [...found.values()]
      after = page.cursor
    }
  }

  async function label(id: string, expected: string | null, set: Record<string, string>) {
    try {
      await board.label(id, { if: { [state]: expected }, set })
      return true
    } catch (error) {
      if (boardConflict(error, 'label_conflict')) return false
      throw error
    }
  }

  async function reject(id: string, expected: string | null, reason: string, other?: string) {
    if (!await label(id, expected, { [state]: rejected })) return false
    await board.reply(id, { text: other === undefined ? reason : `${reason}: ${other}` })
    return true
  }

  return {
    async admit() {
      const clock = now()
      const entries = (await roots()).map((root) => ({ root, ...inspect(root, clock) }))
      type Candidate = { id: string; message: MailMessage; state: string }
      const seen = new Map<string, Candidate[]>()
      const remember = (id: string, message: MailMessage, status: string) => {
        const key = tuple(message)
        const group = seen.get(key) ?? []
        group.push({ id, message, state: status })
        seen.set(key, group)
      }
      for (const { root, message } of entries) {
        const status = root.labels[state]
        if (message && status !== undefined && admitted.has(status)) remember(root.id, message, status)
      }
      for (const { root, message, reason } of entries) {
        if (root.labels[state] !== undefined) continue
        if (!message) {
          if (!await reject(root.id, null, reason)) return
          continue
        }
        const group = seen.get(tuple(message)) ?? []
        const duplicate = group.find((old) => compareInstants(old.message.at, message.at) >= 0)
        if (duplicate) {
          if (!await reject(root.id, null, 'duplicate', duplicate.id)) return
          continue
        }
        // Close older open roots first: a reader must not see both revisions as open.
        for (const old of group) {
          if (old.state === open && await reject(old.id, open, 'superseded', root.id)) old.state = rejected
        }
        // Another scan won this root; don't make decisions on later roots from stale labels.
        if (!await label(root.id, null, labelsFor(message))) return
        remember(root.id, message, open)
      }
    },

    async readOpen({ limit }: { limit: number }): Promise<OpenMail[]> {
      const nowAt = now()
      const found: OpenMail[] = []
      for (const root of await roots()) {
        if (root.labels[state] !== open) continue
        const { message } = inspect(root, nowAt)
        if (!message) continue
        if ((message.urgency === 'p2' || message.urgency === 'p3') && message.expires !== undefined &&
            compareInstants(message.expires, nowAt.toISOString()) <= 0) {
          await label(root.id, open, { [state]: expired })
        } else {
          found.push({ messageId: root.id, message })
        }
      }
      found.sort((a, b) => a.message.urgency.localeCompare(b.message.urgency) || compareInstants(a.message.at, b.message.at))
      const firstOther = found.findIndex(({ message }) => message.urgency !== 'p0')
      const urgent = firstOther === -1 ? found.length : firstOther
      return found.slice(0, Math.max(urgent, limit || 0))
    },

    take(messageId: string) {
      return label(messageId, open, { [state]: handled })
    },
  }
}
