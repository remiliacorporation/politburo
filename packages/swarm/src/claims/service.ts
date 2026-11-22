import { BoardError, type Board, type ClaimedTask } from '@vercel/board'
import { checkCaps, claimStatus, liveClaim, type ClaimRefusal, type ClaimStatus, type ClaimsConfig } from './admission.ts'
import { closeRecord, cooldown, isOpen, readHistory, recordThreads, writeRecord, type ClaimRecord } from './records.ts'

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
  now?: () => number
  leaseSeconds?: number
}

export type ClaimResult = ClaimRefusal | { ok: true; task: string; epoch: number; claimedAt: number; hardEnd: number }
export type TickSummary = { renewed: number; satisfied: number; docked: number; released: number }

type Decision = { kind: 'docked' } | { kind: 'released' } |
  { kind: 'satisfied'; outcome: string | null; evidence: string | null; checkedAt: number }
type Active = { data: ClaimRecord; held: ClaimedTask; id?: string; decision?: Decision }

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
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run)
    queue = next.catch(() => {})
    return next
  }

  async function register(attempt: Active) {
    const { data } = attempt
    attempt.id ??= (await writeRecord(board, 'claim', data, { claimedAt: data.claimedAt, hardEnd: data.hardEnd })).id
    return attempt.id
  }

  async function claim(task: string): Promise<ClaimResult> {
    const { actor } = await board.me()
    let history
    try {
      history = await readHistory(board, task, party, actor)
    } catch (error) {
      if (error instanceof BoardError && error.status === 404) return { ok: false, code: error.code }
      throw error
    }
    if (history.message.channel !== channel) return { ok: false, code: 'wrong_channel' }
    task = history.message.id
    const retryAt = cooldown(history.entries)
    if (retryAt !== null && now() < retryAt) return { ok: false, code: 'reclaim_cooldown', retryAt }
    if (active.has(task)) return { ok: false, code: 'task_claimed' }
    const cap = await checkCaps(board, channel, party, actor, task, config, now)
    if (cap) return cap
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
    const attempt = { data, held }
    active.set(task, attempt)
    await register(attempt)
    return { ok: true, task, epoch: held.epoch, claimedAt, hardEnd }
  }

  async function attach(task: string, evidence: string) {
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
    const { data } = attempt
    const id = await register(attempt)
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
          if (result.result === 'valid') {
            attempt.decision = { kind: 'satisfied', outcome: result.outcome ?? null, evidence: result.evidence ?? null, checkedAt }
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
        const terminal = entries.some((entry) => entry.data.epoch === data.epoch &&
          (entry.kind === 'satisfied' || entry.kind === 'dock' || entry.kind === 'released'))
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
    status: async (): Promise<ClaimStatus[]> => claimStatus(board, channel, party, now, (await board.me()).actor),
  }
}
