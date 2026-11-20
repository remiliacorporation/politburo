import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { BoardError, type Board } from '@vercel/board'
import type { Harness, Result, RunRef, WorkSpec } from './harness.ts'
import { checkedMs } from './process.ts'
import type { CapacityKind, CapacityPolicy } from './capacity.ts'
import type { UsageGuard } from './usage.ts'

export type RunTaskOptions = {
  board: Board
  harness: Harness
  work: WorkSpec
  provider: string
  model?: string
  attemptId?: string
  /** Board lease request, in seconds. The runner uses the actual lease returned by the board. */
  lease?: number
  /** Max delay between renewals; by default renew at a third of the time left on the lease. */
  renewEveryMs?: number
  pollMs?: number
  usageGuard?: UsageGuard
  /** Reserve a kind (worker by default) and, for heavy work, a machine slot. */
  capacity?: { policy: CapacityPolicy; kind?: CapacityKind; heavy?: boolean }
} & ({ taskId: string; selection?: never } | {
  taskId?: never
  /** Explicitly scoped ready selection using board's own eligibility rules. */
  selection: { channel: string; label?: Record<string, string>; from?: string[] }
})

export type RunTaskOutcome =
  | { status: 'nothing_ready' }
  | { status: 'usage_blocked'; resetAt: number }
  | { status: 'capacity_unavailable' }
  | { status: 'lease_lost'; taskId: string }
  | { status: 'released'; taskId: string; run: RunRef; result: Result }

/** Run one claim, then release it and return the result. Never settle the task. */
export async function runTask(options: RunTaskOptions): Promise<RunTaskOutcome> {
  const { usageGuard, capacity, pollMs = 100, renewEveryMs } = options
  checkedMs(pollMs, 'pollMs')
  if (renewEveryMs !== undefined) checkedMs(renewEveryMs, 'renewEveryMs')
  if (usageGuard) {
    const decision = await usageGuard.check()
    if (!decision.allowed) return { status: 'usage_blocked', resetAt: decision.resetAt }
  }
  if (!capacity) return runClaim(options, pollMs, false)
  const reservation = await capacity.policy.tryReserve({ kind: capacity.kind ?? 'worker', heavy: capacity.heavy })
  if (!reservation) return { status: 'capacity_unavailable' }
  try {
    return await runClaim(options, pollMs, true)
  } finally {
    await reservation.release()
  }
}

async function runClaim(options: RunTaskOptions, pollMs: number, holdForLateStart: boolean): Promise<RunTaskOutcome> {
  const { board, harness, work, provider, model, attemptId = randomUUID(), lease, renewEveryMs } = options
  const claim = options.taskId !== undefined
    ? await board.tasks.claim(options.taskId, { lease })
    : await board.tasks.claim({ ...options.selection, lease })
  if (!claim) return { status: 'nothing_ready' }
  const taskId = claim.task.id
  const leaseLost = { status: 'lease_lost', taskId } as const
  const done = new AbortController()
  let current = claim
  let run: RunRef | undefined
  let lost = false
  let watchdog: NodeJS.Timeout | undefined
  const { promise: loss, resolve: signalLoss } = Promise.withResolvers<typeof leaseLost>()

  function lose() {
    lost = true
    done.abort()
    signalLoss(leaseLost)
  }
  function remaining() {
    return Date.parse(current.until) - Date.now()
  }
  function arm() {
    clearTimeout(watchdog)
    const left = remaining()
    if (!(left > 0)) lose()
    else watchdog = setTimeout(lose, left)
  }
  arm()
  const monitor = (async () => {
    while (!done.signal.aborted) {
      try {
        await sleep(Math.max(1, Math.min(remaining() / 3, renewEveryMs ?? Infinity)), undefined, { signal: done.signal })
      } catch {
        break // Only the runner aborts this sleep.
      }
      if (done.signal.aborted) break
      if (!(remaining() > 0)) { lose(); break }
      try {
        const renewed = await current.renew(lease)
        if (!lost && remaining() > 0) {
          current = renewed
          arm()
        } else lose()
      } catch {
        // Unable to prove the lease is still ours. Stop without any write.
        lose()
      }
    }
  })()

  const execute = async () => {
    if (lost) return leaseLost
    const ref = await harness.start({ attemptId, taskId, claimEpoch: claim.epoch, work, provider, model })
    if (lost) {
      // A start can answer after the lease has been lost and runTask has returned.
      await harness.cancel(ref)
      return leaseLost
    }
    run = ref
    while (!lost) {
      const observation = await harness.observe(ref, { limit: 1 })
      if (lost) break
      if (observation.state === 'exited' || observation.state === 'failed' || observation.state === 'canceled') {
        const result = await harness.collect(ref)
        if (result !== 'not_terminal') return { run: ref, result }
      }
      await sleep(pollMs, undefined, { signal: done.signal })
    }
    return leaseLost
  }

  const execution = execute()
  try {
    const finished = await Promise.race([loss, execution])
    if ('status' in finished) return leaseLost
    // Prevent further renewals and serialize release with any renewal already in flight.
    done.abort()
    await Promise.race([loss, monitor])
    if (lost || !(remaining() > 0)) { lose(); return leaseLost }
    clearTimeout(watchdog)
    try {
      await current.release()
    } catch (error) {
      if (error instanceof BoardError && error.code === 'claim_lost') { lose(); return leaseLost }
      throw error
    }
    return { status: 'released', taskId, ...finished }
  } catch (error) {
    // An uncertain start/observation is not a result. Leave the claim to expire.
    if (!lost && run !== undefined) await harness.cancel(run)
    throw error
  } finally {
    done.abort()
    clearTimeout(watchdog)
    if (lost && run !== undefined) await harness.cancel(run)
    else if (lost && holdForLateStart) {
      // A pending start can still launch work. Keep the slot until it rejects
      // or returns a ref and execute requests cancellation. Loss still wins.
      await execution.catch(() => {})
    }
  }
}
