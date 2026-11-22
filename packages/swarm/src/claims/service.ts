import { BoardError, type Board, type ClaimedTask } from '@vercel/board'
import { checkCaps, claimStatus, liveClaim, type ClaimRefusal, type ClaimStatus, type ClaimsConfig } from './admission.ts'
import { closeRecord, cooldown, HistoryTooLong, isOpen, readHistory, recordThreads, writeRecord, type ClaimRecord } from './records.ts'

export type { ClaimStatus, ClaimsConfig } from './admission.ts'

// Callers supply the validator until the WP-401 contract validator is available.
export type Validate = (input: { task: string; text: string; party: string; epoch: number; checkedAt: number }) =>
  Promise<{ result: 'valid' | 'invalid' | 'unverifiable'; outcome?: string | null; evidence?: string }>

export type ClaimsOptions = {
  board: Board
  channel: string
  party: string
  config: ClaimsConfig
  validate: Validate
  // Tests inject now. Date.now assumes the service runs on the board's host, as designed.
  // hardEnd always comes from the board's lease answer.
  now?: () => number
  leaseSeconds?: number
}

export type ClaimResult = ClaimRefusal | { ok: true; task: string; epoch: number; claimedAt: number; hardEnd: number }
export type TickSummary = { renewed: number; satisfied: number; docked: number; released: number }

type Decision = { kind: 'docked' } | { kind: 'released' } |
  { kind: 'satisfied'; outcome: string | null; evidence: string | null; checkedAt: number }
type Active = { data: ClaimRecord; held: ClaimedTask; id: string; decision?: Decision }

async function ignoreLost(write: () => Promise<unknown>) {
  try {
    await write()
  } catch (error) {
    if (!(error instanceof BoardError && error.code === 'claim_lost')) throw error
  }
}

export function createClaims({ board, channel, party, config, validate, now = Date.now, leaseSeconds = 60 }: ClaimsOptions) {
  if (config.pause_on_downtime) throw new Error('claims.pause_on_downtime must be false')
  if (!Number.isFinite(leaseSeconds)) throw new Error('leaseSeconds must be finite')
  const lease = Math.max(30, Math.min(3600, Math.floor(leaseSeconds), config.hours * 3600))
  const active = new Map<string, Active>()
  let pendingRecovery = false
  let recovered = false
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
      if (!recovered) await recover()
      history = await readHistory(board, task, party, actor)
      if (history.message.channel !== channel) return { ok: false, code: 'wrong_channel' }
      task = history.message.id
      const retryAt = cooldown(history.entries)
      if (retryAt !== null && now() < retryAt) return { ok: false, code: 'reclaim_cooldown', retryAt }
      const cap = await checkCaps(board, channel, party, actor, task, config, now)
      if (cap) return cap
    } catch (error) {
      if (error instanceof HistoryTooLong) return { ok: false, code: 'history_too_long' }
      if (recovered && !history && error instanceof BoardError && error.status === 404) return { ok: false, code: error.code }
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
    const data: ClaimRecord = { v: 1, party, task, epoch: held.epoch, claimedAt, hardEnd }
    try {
      const { id } = await writeRecord(board, 'claim', data, { claimedAt, hardEnd })
      active.set(task, { data, held, id })
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

  async function dock(data: ClaimRecord) {
    await writeRecord(board, 'dock', data, {
      points: config.dock.missed_claim, hardEnd: data.hardEnd,
      cooldownUntil: data.hardEnd + config.reclaim_cooldown_minutes * 60_000,
    })
  }

  async function advance(attempt: Active, summary: TickSummary) {
    const { data, id } = attempt
    const remaining = data.hardEnd - now()
    if (!attempt.decision && remaining <= 0) attempt.decision = { kind: 'docked' }
    if (!attempt.decision) {
      try {
        attempt.held = await attempt.held.renew(Math.max(30, Math.min(lease, Math.floor(remaining / 1000))))
        summary.renewed++
      } catch (error) {
        if (!(error instanceof BoardError && error.code === 'claim_lost')) throw error
        attempt.decision = { kind: 'released' }
      }
      if (!attempt.decision) {
        const checkedAt = now()
        if (checkedAt < data.hardEnd) {
          const result = await validate({ task: data.task, text: attempt.held.task.text, party, epoch: data.epoch, checkedAt })
          const answeredAt = now()
          if (result.result === 'valid' && answeredAt < data.hardEnd) {
            attempt.decision = { kind: 'satisfied', outcome: result.outcome ?? null, evidence: result.evidence ?? null, checkedAt: answeredAt }
          }
        }
        if (!attempt.decision && now() >= data.hardEnd) attempt.decision = { kind: 'docked' }
      }
    }
    const decision = attempt.decision
    if (!decision) return
    if (decision.kind === 'satisfied') {
      const { outcome, evidence, checkedAt } = decision
      await writeRecord(board, 'satisfied', data, { outcome, evidence, checkedAt })
      await ignoreLost(() => attempt.held.block('outcome satisfied; awaiting review', { kind: 'review' }))
    } else if (decision.kind === 'docked') {
      await ignoreLost(() => attempt.held.release())
      await dock(data)
    } else {
      await writeRecord(board, 'released', data, { reason: 'lease_lost' })
    }
    await closeRecord(board, id)
    active.delete(data.task)
    summary[decision.kind]++
  }

  async function recover(summary?: TickSummary) {
    const { actor } = await board.me()
    let pending = false
    const labels = { 'swarm.kind': 'claim', 'swarm.party': party, 'swarm.state': 'open' }
    for await (const task of recordThreads(board, channel, labels)) {
      const { message, entries } = await readHistory(board, task, party, actor)
      for (const { data, message: record } of entries.filter(isOpen)) {
        if (active.get(task)?.data.epoch === data.epoch) continue
        const satisfied = entries.some((entry) => entry.data.epoch === data.epoch && entry.kind === 'satisfied')
        const terminal = satisfied || entries.some((entry) => entry.data.epoch === data.epoch &&
          (entry.kind === 'dock' || entry.kind === 'released'))
        // A lapsed lease can still read as 'claimed' in thread history; the board decides.
        if (satisfied && (message.task?.state === 'ready' || message.task?.state === 'claimed')) {
          try {
            await board.tasks.block(task, 'outcome satisfied; awaiting review', { kind: 'review' })
          } catch (error) {
            if (!(error instanceof BoardError && error.code === 'task_claimed')) throw error
            pending = true
            continue
          }
        }
        const at = now()
        if (!terminal && at >= data.hardEnd) {
          await dock(data)
          if (summary) summary.docked++
        } else if (!terminal) {
          if (message.task?.epoch === data.epoch && liveClaim(message, actor, at)) {
            pending = true
            continue
          }
          await writeRecord(board, 'released', data, { reason: 'lease_lost' })
          if (summary) summary.released++
        }
        await closeRecord(board, record.id)
      }
    }
    pendingRecovery = pending
    recovered = true
  }

  async function tick(): Promise<TickSummary> {
    const summary = { renewed: 0, satisfied: 0, docked: 0, released: 0 }
    const failures: unknown[] = []
    for (const attempt of [...active.values()]) await advance(attempt, summary).catch((error) => void failures.push(error))
    if (pendingRecovery) await recover(summary).catch((error) => void failures.push(error))
    if (failures.length) throw new AggregateError(failures, 'claims tick failed for some claims; the rest were advanced')
    return summary
  }

  return {
    claim: (task: string) => serial(() => claim(task)),
    attach: (task: string, evidence: string) => serial(() => attach(task, evidence)),
    tick: () => serial(tick),
    recover: () => serial(() => recover()),
    status: async (): Promise<ClaimStatus[]> => claimStatus(board, channel, party, config, now, (await board.me()).actor),
  }
}
