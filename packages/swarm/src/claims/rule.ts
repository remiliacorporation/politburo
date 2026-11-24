import type { Board, BoardOptions } from '@vercel/board'
import { dockTaskMisses } from './dock.ts'
import { cooldown, readHistory } from './records.ts'

export type ClaimsConfig = {
  hours: number
  pause_on_downtime: boolean
  reclaim_cooldown_minutes: number
  open_claims_per_repo: number
  uncommitted_claims_per_repo: number
  dock: { missed_claim: number }
}

export type ClaimOptions = { board: Board; party: string; channel: string; config: ClaimsConfig; now?: () => number }

export async function* claimedTasks(board: Board, channel: string, actor: string) {
  let after: string | undefined
  for (;;) {
    const page = await board.tasks.list({ channel, state: 'claimed', limit: 100, ...(after ? { after } : {}) })
    for (const { message } of page.tasks) {
      if (message.channel === channel && message.task?.claim?.actor === actor) yield message
    }
    if (page.tasks.length < 100 || page.cursor === after) return
    after = page.cursor
  }
}

const refuse = (code: string, message: string) => ({ refuse: { code, message } })

// Admission checks the board's current views; the board alone decides which claim lands.
export function createClaimRule({ board, party, channel, config, now = Date.now }: ClaimOptions): NonNullable<BoardOptions['claimRule']> {
  if (config.pause_on_downtime) throw new Error('claims.pause_on_downtime is not supported')
  return async (claim) => {
    const scope = claim.task === null ? claim.channel.replace(/\/$/, '') : claim.channel
    if (scope !== channel && !(claim.task === null && channel.startsWith(`${scope}/`))) return
    if (claim.actor !== (await board.me()).actor) return
    if (claim.task !== null) {
      await dockTaskMisses({ board, party, channel, config, now }, claim.task)
      const until = cooldown(await readHistory(board, claim.task, party, claim.actor))
      if (now() < until) return refuse('reclaim_cooldown', `claim cools down until ${new Date(until).toISOString()}`)
    }
    const open = []
    for await (const message of claimedTasks(board, channel, claim.actor)) open.push(message)
    if (open.length >= config.open_claims_per_repo) return refuse('open_claims_per_repo', 'open claim cap reached')
    let uncommitted = 0
    for (const message of open) {
      const entries = await readHistory(board, message.id, party, claim.actor)
      if (!entries.some(({ kind, data }) => kind === 'artifact' && data.epoch === message.task?.epoch)) uncommitted++
    }
    if (uncommitted >= config.uncommitted_claims_per_repo) return refuse('uncommitted_claims_per_repo', 'uncommitted claim cap reached')
  }
}
