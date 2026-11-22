import { BoardError, type Board, type MessageView } from '@vercel/board'

export type Attempt = { v: 1; party: string; task: string; epoch: number }
type Payloads = {
  claim: { claimedAt: number; hardEnd: number }
  artifact: { evidence: string }
  satisfied: { outcome: string | null; evidence: string | null; checkedAt: number }
  dock: { points: number; hardEnd: number; cooldownUntil: number }
  released: { reason: string }
}
type Kind = keyof Payloads
export type ClaimRecord = Attempt & Payloads['claim']
export type Entry = {
  [K in Kind]: { kind: K; data: Attempt & Payloads[K]; message: MessageView }
}[Kind]

const state = 'swarm.state'
const fence = '```json\n'

export function writeRecord<K extends Kind>(board: Board, kind: K, attempt: Attempt, payload: Payloads[K]) {
  const { v, party, task, epoch } = attempt
  return board.reply(task, {
    id: `swarm-${kind}:${party}:${task}:${epoch}`,
    text: `${fence}${JSON.stringify({ v, kind, party, task, epoch, ...payload })}\n\`\`\``,
    labels: {
      'swarm.kind': kind, 'swarm.party': party, 'swarm.epoch': String(epoch),
      ...(kind === 'claim' ? { [state]: 'open' } : {}),
    },
    noSync: true,
  })
}

function payloadMatches(kind: unknown, data: Record<string, unknown>): kind is Kind {
  const { claimedAt, hardEnd, evidence, outcome, checkedAt, points, cooldownUntil, reason } = data
  switch (kind) {
    case 'claim': return Number.isFinite(claimedAt) && Number.isFinite(hardEnd)
    case 'artifact': return typeof evidence === 'string'
    case 'satisfied': return (outcome === null || typeof outcome === 'string') &&
      (evidence === null || typeof evidence === 'string') && Number.isFinite(checkedAt)
    case 'dock': return Number.isFinite(points) && Number.isFinite(hardEnd) && Number.isFinite(cooldownUntil)
    case 'released': return typeof reason === 'string'
    default: return false
  }
}

function readRecord(message: MessageView, task: string, party: string, actor?: string): Entry | null {
  if (message.deleted || (actor !== undefined && message.by.actor !== actor) ||
      !message.text.startsWith(fence) || !message.text.endsWith('\n```')) return null
  let data: Record<string, unknown> | null
  try {
    data = JSON.parse(message.text.slice(fence.length, -4))
  } catch {
    return null
  }
  if (!data || data.v !== 1 || data.task !== task || data.party !== party ||
      !Number.isSafeInteger(data.epoch) || !payloadMatches(data.kind, data)) return null
  return { kind: data.kind, data, message } as Entry
}

export class HistoryTooLong extends Error {
  constructor(task: string) {
    super(`task ${task}: claim history exceeds the read budget`)
  }
}

export async function readHistory(board: Board, task: string, party: string, actor?: string): Promise<{ message: MessageView; entries: Entry[] }> {
  const limit = 500
  let after = task
  const entries: Entry[] = []
  for (let page = 0; page < 4; page++) {
    const { message, replies } = await board.thread(task, { after, limit })
    // The handle also accepts a reply ID; restart at its root rather than skip older replies.
    if (page === 0 && message.id !== task) {
      task = message.id
      after = task
      continue
    }
    entries.push(...replies.flatMap((reply) => readRecord(reply, message.id, party, actor) ?? []))
    if (replies.length < limit) return { message, entries }
    after = replies.at(-1)!.id
  }
  // A full last page doesn't prove that the history ended there.
  throw new HistoryTooLong(task)
}

export function isOpen(entry: Entry): entry is Extract<Entry, { kind: 'claim' }> {
  return entry.kind === 'claim' && entry.message.labels[state] === 'open'
}

export async function closeRecord(board: Board, id: string): Promise<void> {
  try {
    await board.label(id, { if: { [state]: 'open' }, set: { [state]: 'closed' } })
  } catch (error) {
    if (!(error instanceof BoardError && error.code === 'label_conflict')) throw error
  }
}

export async function* recordThreads(board: Board, channel: string, label: Record<string, string>, since?: number) {
  let before: string | undefined
  do {
    const page = await board.threads({ channel, label, limit: 100, ...(before ? { before } : {}) })
    // Each backward page is returned oldest first; scan it from the newest end for a cutoff.
    for (const { message, last } of since === undefined ? page.threads : page.threads.toReversed()) {
      if (since !== undefined && Date.parse((last ?? message).createdAt) < since) return
      if (message.channel === channel && message.task) yield message.id
    }
    before = page.older ?? undefined
  } while (before)
}

export function cooldown(entries: Entry[]): number | null {
  let until: number | null = null
  for (const { data } of entries.filter((entry) => entry.kind === 'dock')) {
    until = Math.max(until ?? -Infinity, data.cooldownUntil)
  }
  return until
}
