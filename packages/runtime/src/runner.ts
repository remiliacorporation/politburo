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
  | { status: 'paused'; taskId?: string }
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
  const claim = await (options.taskId !== undefined
    ? board.tasks.claim(options.taskId, { lease })
    : board.tasks.claim({ ...options.selection, lease })).catch((error: unknown) => {
    if (error instanceof BoardError && error.code === 'board_paused') return 'paused' as const
    throw error
  })
  if (claim === 'paused') return { status: 'paused' }
  if (!claim) return { status: 'nothing_ready' }
  const taskId = claim.task.id
  const paused = { status: 'paused', taskId } as const
  const leaseLost = { status: 'lease_lost', taskId } as const
  type Stopped = typeof paused | typeof leaseLost
  const done = new AbortController()
  const renewals = new AbortController()
  let current = claim
  let startRequested = false
  let run: RunRef | undefined
  let stopped: Stopped | undefined
  let watchdog: NodeJS.Timeout | undefined
  const { promise: interrupted, resolve: interrupt } = Promise.withResolvers<Stopped>()

  function stop(outcome: Stopped) {
    if (stopped) return
    stopped = outcome
    interrupt(outcome)
    done.abort()
    renewals.abort()
  }
  const lose = () => stop(leaseLost)
  const pauseEpoch = claim.pauseEpoch
  async function crossedPause() {
    if (pauseEpoch === undefined) return false // This backend did not issue a pause fence.
    const status = await board.status()
    return status.paused || status.pauseEpoch !== pauseEpoch
  }
  async function checkPause() {
    try {
      if (await crossedPause() && !done.signal.aborted) stop(paused)
    } catch {
      // A fenced run cannot proceed if its board's control state is unknown.
      if (!done.signal.aborted) lose()
    }
  }
  async function lostClaim() {
    return await crossedPause().catch(() => false) ? paused : leaseLost
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
    while (!renewals.signal.aborted) {
      try {
        await sleep(Math.max(1, Math.min(remaining() / 3, renewEveryMs ?? Infinity)), undefined, { signal: renewals.signal })
      } catch {
        break // Only the runner aborts this sleep.
      }
      if (renewals.signal.aborted) break
      if (!(remaining() > 0)) { lose(); break }
      try {
        const renewed = await current.renew(lease)
        if (stopped) break
        if (!(remaining() > 0)) { lose(); break }
        current = renewed
        arm()
      } catch (error) {
        // A pause fences the same writes as other lease losses. Check which happened.
        if (!stopped) stop(error instanceof BoardError && error.code === 'claim_lost' ? await lostClaim() : leaseLost)
      }
    }
  })()

  async function watchPause() {
    while (!done.signal.aborted) {
      try {
        await sleep(pollMs, undefined, { signal: done.signal })
      } catch {
        break
      }
      if (!done.signal.aborted) await checkPause()
    }
  }

  const execute = async () => {
    if (pauseEpoch !== undefined && !stopped) {
      // A claim response can arrive after its admission epoch was closed.
      await checkPause()
      if (!stopped) void watchPause()
    }
    if (stopped) return stopped
    startRequested = true
    const ref = await harness.start({ attemptId, taskId, claimEpoch: claim.epoch, work, provider, model })
    if (stopped) {
      // Start can answer after runTask has returned. Cancel as soon as we have the ref.
      await harness.cancel(ref)
      return stopped
    }
    run = ref
    while (!stopped) {
      const observation = await harness.observe(ref, { limit: 1 })
      if (stopped) break
      if (observation.state === 'exited' || observation.state === 'failed' || observation.state === 'canceled') {
        const result = await harness.collect(ref)
        if (stopped) break
        if (result !== 'not_terminal') return { run: ref, result }
      }
      await sleep(pollMs, undefined, { signal: done.signal })
    }
    return stopped
  }

  const execution = execute()
  try {
    const finished = await Promise.race([interrupted, execution])
    if ('status' in finished) return finished
    // Serialize release with any renewal already in flight, still watching for pause.
    renewals.abort()
    await Promise.race([interrupted, monitor])
    if (stopped) return stopped
    if (!(remaining() > 0)) { lose(); return leaseLost }
    done.abort()
    clearTimeout(watchdog)
    try {
      await current.release()
    } catch (error) {
      if (error instanceof BoardError && error.code === 'claim_lost') {
        const outcome = await lostClaim()
        stop(outcome)
        return outcome
      }
      throw error
    }
    return { status: 'released', taskId, ...finished }
  } catch (error) {
    if (stopped) return stopped
    // An uncertain start/observation is not a result. Leave the claim to expire.
    if (run !== undefined) await harness.cancel(run)
    throw error
  } finally {
    done.abort()
    renewals.abort()
    clearTimeout(watchdog)
    if (stopped && run !== undefined) await harness.cancel(run)
    else if (stopped && holdForLateStart && startRequested) {
      // Keep the slot until the pending start rejects or returns a ref and
      // execute requests cancellation. The interruption still wins.
      await execution.catch(() => {})
    }
  }
}
