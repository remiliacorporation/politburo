import type { Board } from '@vercel/board'
import { MAIL_LABELS, MAIL_STATES, labelsFor, validateMessage, type MailMessage } from './message.ts'
import { boardConflict, mailBlock, samePayload } from './send.ts'

export type InboxOptions = {
  board: Pick<Board, 'channel' | 'label' | 'reply'> & Partial<Pick<Board, 'thread'>>
  channel: string
  now: () => Date
}
export type OpenMail = { messageId: string; message: MailMessage }
export type MailRoot = Awaited<ReturnType<ReturnType<Board['channel']>['messages']>>['messages'][number]

const { state } = MAIL_LABELS
const { open, handled, forwarded, expired, rejected } = MAIL_STATES
const admitted = new Set<string>([open, handled, forwarded])
const derivedKey = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const remoteThread = /^thr_[0-9a-f-]{36}$/

// MessageView.id is the mutation ref. A local root's thread is its event key, but
// handles can hash that key and Vercel exposes a server thread ID instead.
export function readableMailKey(root: MailRoot) {
  return [root.thread, root.id].find((value) => value?.startsWith('mail:'))
}

export function matchesMailKey(key: string, id: string) {
  const split = key.indexOf(':', 'mail:'.length)
  return split > 'mail:'.length && !!key.slice('mail:'.length, split).trim() && key.slice(split + 1) === id
}

function matchesKey(root: MailRoot, key: string | undefined, id: string) {
  if (key !== undefined) {
    const delivery = root.labels['swarm.delivery']
    return matchesMailKey(key, id) || (delivery !== undefined && key === `mail:${delivery}`)
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

export function inspectMailBlock(root: MailRoot, now: Date) {
  const entry = mailBlock(root)
  if (!entry) return { reason: 'invalid_block' } as const
  const [reason] = validateMessage(entry.data, { now })
  return reason === undefined ? { message: entry.data as MailMessage } as const : { reason } as const
}

type Inspection = { message: MailMessage; opaqueId: string | undefined; reason?: never } |
  { reason: string; message?: never; opaqueId?: never }

function inspect(root: MailRoot, now: Date): Inspection {
  const result = inspectMailBlock(root, now)
  if (!result.message) return result
  const { message } = result
  const key = readableMailKey(root)
  if (!matchesKey(root, key, message.id)) return { reason: 'invalid_post_key' }
  const opaqueId = key === undefined
    ? JSON.stringify([root.by!.principal, root.labels['swarm.delivery'], message.id]) : undefined
  return { message, opaqueId }
}

const tuple = (root: MailRoot, { from, ref, class: kind }: MailMessage) =>
  JSON.stringify([root.by?.principal, root.labels['swarm.delivery'], from, ref, kind])
const submillis = (at: string) => (at.match(/\.\d{3}(\d+)/)?.[1] ?? '').replace(/0+$/, '')

export function compareInstants(a: string, b: string) {
  const millis = Date.parse(a) - Date.parse(b)
  if (millis) return millis
  // Date.parse truncates fractions to milliseconds, but admission distinguishes strictly newer mail.
  const left = submillis(a)
  const right = submillis(b)
  return left === right ? 0 : left < right ? -1 : 1
}

function isExpired(message: MailMessage, now: Date) {
  return (message.urgency === 'p2' || message.urgency === 'p3') && message.expires !== undefined &&
    compareInstants(message.expires, now.toISOString()) <= 0
}

export async function readMailRoots(board: Pick<Board, 'channel'>, channel: string): Promise<MailRoot[]> {
  const inbox = board.channel(channel)
  const found = new Map<string, MailRoot>()
  // Without a cursor the handle starts at the newest page, not the beginning.
  let after = '0'
  for (;;) {
    const page = await inbox.messages({ after, limit: 100 })
    for (const root of page.messages) {
      if (root.re === null && !root.deleted) found.set(root.id, root)
    }
    if (page.cursor === after) return [...found.values()]
    after = page.cursor
  }
}

export async function labelMail(board: Pick<Board, 'label'>, id: string, expected: string | null, set: Record<string, string>) {
  try {
    await board.label(id, { if: { [state]: expected }, set })
    return true
  } catch (error) {
    if (boardConflict(error, 'label_conflict')) return false
    throw error
  }
}

export function createInbox({ board, channel, now }: InboxOptions) {
  const roots = () => readMailRoots(board, channel)
  const label = (id: string, expected: string | null, set: Record<string, string>) => labelMail(board, id, expected, set)

  async function reject(id: string, expected: string | null, reason: string, other?: string) {
    await board.reply(id, {
      id: `reject:${id}:${reason}`, text: other === undefined ? reason : `${reason}: ${other}`, noSync: true,
    })
    return label(id, expected, { [state]: rejected })
  }

  async function inspectOpen(root: MailRoot, clock: Date) {
    if (root.labels[state] !== open) return
    const { message } = inspect(root, clock)
    if (!message) return
    // Making roots immutable needs a board change (design/swarm-board-additions.md, Open), outside this slice.
    if (root.labels[MAIL_LABELS.class] !== message.class || root.labels[MAIL_LABELS.urgency] !== message.urgency) {
      await reject(root.id, open, 'label_mismatch')
      return
    }
    return message
  }

  return {
    async admit() {
      const clock = now()
      const entries = (await roots()).map((root) => ({ root, ...inspect(root, clock) }))
      type Candidate = { id: string; message: MailMessage; state: string }
      const seen = new Map<string, Candidate[]>()
      const ids = new Map<string, { id: string; message: MailMessage }>()
      const remember = (root: MailRoot, message: MailMessage, status: string) => {
        if (message.urgency === 'p0') return
        const key = tuple(root, message)
        const group = seen.get(key) ?? []
        group.push({ id: root.id, message, state: status })
        seen.set(key, group)
      }
      for (const { root, message, opaqueId } of entries) {
        const status = root.labels[state]
        if (!message || status === undefined) continue
        if (opaqueId !== undefined && !ids.has(opaqueId)) ids.set(opaqueId, { id: root.id, message })
        if (admitted.has(status)) remember(root, message, status)
      }
      for (const { root, message, reason, opaqueId } of entries) {
        if (root.labels[state] !== undefined) continue
        if (!message) {
          if (!await reject(root.id, null, reason)) return
          continue
        }
        if (isExpired(message, clock)) {
          if (!await label(root.id, null, { [state]: expired })) return
          if (opaqueId !== undefined && !ids.has(opaqueId)) ids.set(opaqueId, { id: root.id, message })
          continue
        }
        const previous = opaqueId === undefined ? undefined : ids.get(opaqueId)
        if (previous) {
          const reason = samePayload(message, previous.message) ? 'duplicate' : 'id_collision'
          if (!await reject(root.id, null, reason, previous.id)) return
          continue
        }
        if (opaqueId !== undefined) ids.set(opaqueId, { id: root.id, message })
        const group = message.urgency === 'p0' ? [] : seen.get(tuple(root, message)) ?? []
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
        remember(root, message, open)
      }
    },

    async readOpen({ limit }: { limit: number }): Promise<OpenMail[]> {
      const nowAt = now()
      const found: OpenMail[] = []
      for (const root of await roots()) {
        const message = await inspectOpen(root, nowAt)
        if (!message) continue
        if (isExpired(message, nowAt)) {
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

    async take(messageId: string) {
      const root = board.thread
        ? await board.thread(messageId, { limit: 1 }).then(({ message }) => message, (error: unknown) => {
          if (error instanceof Object && 'status' in error && error.status === 404) return undefined
          throw error
        })
        : (await roots()).find(({ id }) => id === messageId)
      if (!root || root.id !== messageId || root.channel !== channel || root.re !== null || root.deleted) return false
      if (!await inspectOpen(root, now())) return false
      return label(messageId, open, { [state]: handled })
    },
  }
}
