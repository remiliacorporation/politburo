import { BoardError, type Board } from '@vercel/board'
import { checkCaps, claimStatus, type ClaimRefusal, type ClaimStatus, type ClaimsConfig } from './admission.ts'
import { cooldown, HistoryTooLong, readHistory, writeRecord, type Attempt } from './records.ts'

export type { ClaimStatus, ClaimsConfig } from './admission.ts'

export type ClaimsOptions = {
  board: Board
  channel: string
  party: string
  config: ClaimsConfig
  now?: () => number
  leaseSeconds?: number
}

export type ClaimResult = ClaimRefusal | { ok: true; task: string; epoch: number; claimedAt: number; hardEnd: number }

export function createClaims({ board, channel, party, config, now = Date.now, leaseSeconds = 60 }: ClaimsOptions) {
  if (config.pause_on_downtime) throw new Error('claims.pause_on_downtime must be false')
  if (!Number.isFinite(leaseSeconds)) throw new Error('leaseSeconds must be finite')
  const lease = Math.max(30, Math.min(3600, Math.floor(leaseSeconds), config.hours * 3600))
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run)
    queue = next.catch(() => {})
    return next
  }

  async function claim(task: string): Promise<ClaimResult> {
    const { actor } = await board.me()
    let history
    try {
      history = await readHistory(board, task, party, actor)
      if (history.message.channel !== channel) return { ok: false, code: 'wrong_channel' }
      task = history.message.id
      const retryAt = cooldown(history.entries)
      if (retryAt !== null && now() < retryAt) return { ok: false, code: 'reclaim_cooldown', retryAt }
      const cap = await checkCaps(board, channel, party, actor, task, config, now)
      if (cap) return cap
    } catch (error) {
      if (error instanceof HistoryTooLong) return { ok: false, code: 'history_too_long' }
      if (!history && error instanceof BoardError && error.status === 404) return { ok: false, code: error.code }
      throw error
    }
    // Some backends cap the lease at five minutes; the initial duration must not be shortened.
    const initialLease = Math.min(lease, 300)
    let held
    try {
      held = await board.tasks.claim(task, { lease: initialLease })
    } catch (error) {
      if (error instanceof BoardError && error.status >= 400 && error.status < 500) return { ok: false, code: error.code }
      throw error
    }
    // The service clock checks deadlines; the deadline itself starts on the board's clock.
    const claimedAt = Date.parse(held.until) - initialLease * 1000
    const hardEnd = claimedAt + config.hours * 3_600_000
    const attempt: Attempt = { v: 1, party, task, epoch: held.epoch }
    try {
      await writeRecord(board, 'claim', attempt, { claimedAt, hardEnd })
    } catch (error) {
      try {
        await held.release()
      } catch (releaseError) {
        if (!(releaseError instanceof BoardError && releaseError.code === 'claim_lost')) {
          throw new AggregateError([error, releaseError], `task ${task}: claim record write and lease release failed`)
        }
      }
      throw error
    }
    return { ok: true, task, epoch: held.epoch, claimedAt, hardEnd }
  }

  async function attach(task: string, evidence: string) {
    if (!evidence.trim() || evidence.length > 2048 || /\p{Cc}/u.test(evidence)) {
      throw new Error('claim evidence must be nonblank, at most 2048 characters, and contain no control characters')
    }
    const { actor } = await board.me()
    const { message, entries } = await readHistory(board, task, party, actor)
    if (message.channel !== channel) throw new Error('task is outside the work channel')
    const latest = entries.filter((entry) => entry.kind === 'claim').at(-1)
    if (!latest) throw new Error('task has no claim attempt for this party')
    await writeRecord(board, 'artifact', latest.data, { evidence })
  }

  return {
    claim: (task: string) => serial(() => claim(task)),
    attach: (task: string, evidence: string) => serial(() => attach(task, evidence)),
    status: async (): Promise<ClaimStatus[]> => claimStatus(board, channel, party, config, now, (await board.me()).actor),
  }
}
