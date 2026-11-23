import { createHash } from 'node:crypto'
import type { Board, MessageView } from '@vercel/board'

export type Attempt = { v: 1; party: string; task: string; epoch: number }
type Payloads = {
  artifact: { evidence: string }
  dock: { points: number; hardEnd: number; cooldownUntil: number }
}
type Kind = keyof Payloads
export type Entry = {
  [K in Kind]: { kind: K; data: Attempt & Payloads[K]; message: MessageView }
}[Kind]

const fence = '```json\n'

export async function writeRecord<K extends Kind>(board: Board, kind: K, attempt: Attempt, payload: Payloads[K]) {
  const { v, party, task, epoch } = attempt
  const suffix = kind === 'dock' ? `:${createHash('sha256').update((await board.me()).actor).digest('hex').slice(0, 16)}` : ''
  return board.reply(task, {
    id: `swarm-${kind}:${party}:${task}:${epoch}${suffix}`,
    text: `${fence}${JSON.stringify({ ...payload, v, kind, party, task, epoch })}\n\`\`\``,
    labels: { 'swarm.kind': kind, 'swarm.party': party, 'swarm.epoch': String(epoch) },
    noSync: true,
  })
}

function payloadMatches(kind: unknown, data: Record<string, unknown>): kind is Kind {
  switch (kind) {
    case 'artifact': return typeof data.evidence === 'string' && data.evidence.trim().length > 0
    case 'dock': return Number.isFinite(data.points) && Number.isFinite(data.hardEnd) && Number.isFinite(data.cooldownUntil)
    default: return false
  }
}

function readRecord(message: MessageView, task: string, party: string, actor: string): Entry | null {
  if (message.deleted || message.by.actor !== actor ||
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

export async function readHistory(board: Board, task: string, party: string, actor: string): Promise<Entry[]> {
  const limit = 500
  let after = task
  const entries: Entry[] = []
  for (let page = 0; page < 4; page++) {
    const { message, replies } = await board.thread(task, { after, limit })
    // The handle also accepts a reply ID; restart at its root rather than skip older replies.
    if (page === 0 && message.id !== task) {
      task = message.id
      after = task
      page--
      continue
    }
    entries.push(...replies.flatMap((reply) => readRecord(reply, task, party, actor) ?? []))
    if (replies.length < limit) return entries
    after = replies.at(-1)!.id
  }
  // A full last page doesn't prove that the history ended there.
  throw new Error(`task ${task}: claim history exceeds the read budget`)
}

export function cooldown(entries: Entry[]): number {
  let until = -Infinity
  for (const { data } of entries.filter((entry) => entry.kind === 'dock')) {
    until = Math.max(until, data.cooldownUntil)
  }
  return until
}
