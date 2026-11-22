import type { Board, MessageView } from '@vercel/board'
import { cooldown, isOpen, readHistory, recordThreads } from './records.ts'

export type ClaimsConfig = {
  hours: number
  pause_on_downtime: boolean
  reclaim_cooldown_minutes: number
  open_claims_per_repo: number
  uncommitted_claims_per_repo: number
  dock: { missed_claim: number }
}

export type ClaimRefusal = { ok: false; code: string; retryAt?: number | null }
export type ClaimStatus = { task: string; party: string; cooldownUntil: number | null } & (
  { state: 'claimed'; epoch: number; hardEnd: number; timeLeftMs: number } |
  { state: 'cooling' }
)

export function liveClaim(message: MessageView, actor: string, now: number) {
  const task = message.task
  return task?.state === 'claimed' && task.claim?.actor === actor && Date.parse(task.claim.until) > now
}

export async function checkCaps(
  board: Board, channel: string, party: string, actor: string, task: string, config: ClaimsConfig, now: () => number,
): Promise<ClaimRefusal | null> {
  const claims: { hardEnd: number | null; committed: boolean; message: MessageView }[] = []
  let after: string | undefined
  for (;;) {
    const page = await board.tasks.list({ channel, state: 'claimed', limit: 100, ...(after ? { after } : {}) })
    for (const { message } of page.tasks) {
      if (message.channel !== channel || !liveClaim(message, actor, now())) continue
      if (message.id === task) return { ok: false, code: 'task_claimed' }
      const history = await readHistory(board, message.id, party, actor)
      const epoch = history.message.task?.epoch
      const records = history.entries.filter((entry) => entry.data.epoch === epoch)
      claims.push({
        hardEnd: records.find(isOpen)?.data.hardEnd ?? null,
        committed: records.some((entry) => entry.kind === 'artifact'),
        message: history.message,
      })
    }
    if (page.tasks.length < 100 || page.cursor === after) break
    after = page.cursor
  }
  const at = now()
  const open = claims.filter(({ message }) => liveClaim(message, actor, at))
  const uncommitted = open.filter((claim) => !claim.committed)
  const atCap = (code: keyof Pick<ClaimsConfig, 'open_claims_per_repo' | 'uncommitted_claims_per_repo'>, items: typeof claims): ClaimRefusal | null => {
    if (items.length < config[code]) return null
    const ends = items.flatMap(({ hardEnd }) => hardEnd === null ? [] : [hardEnd])
    return { ok: false, code, retryAt: ends.length ? Math.min(...ends) : null }
  }
  return atCap('open_claims_per_repo', open) ?? atCap('uncommitted_claims_per_repo', uncommitted)
}

export async function claimStatus(board: Board, channel: string, party: string, now: () => number, actor?: string): Promise<ClaimStatus[]> {
  const rows: ClaimStatus[] = []
  for await (const task of recordThreads(board, channel, { 'swarm.party': party })) {
    const { message, entries } = await readHistory(board, task, party, actor)
    const at = now()
    const until = cooldown(entries)
    const cooldownUntil = until !== null && until > at ? until : null
    const open = entries.find((entry) => isOpen(entry) && entry.data.epoch === message.task?.epoch && liveClaim(message, entry.message.by.actor, at))
    if (open && isOpen(open) && !entries.some((entry) => entry.data.epoch === open.data.epoch && entry.kind === 'satisfied')) {
      const { epoch, hardEnd } = open.data
      rows.push({ task, party, state: 'claimed', epoch, hardEnd, timeLeftMs: Math.max(0, hardEnd - at), cooldownUntil })
    } else if (cooldownUntil !== null) {
      rows.push({ task, party, state: 'cooling', cooldownUntil })
    }
  }
  return rows
}
