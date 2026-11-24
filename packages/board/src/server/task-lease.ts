import type { Message, Task } from '../contract/folds.ts'

/** A claim from an earlier pause epoch is fenced even after resume. */
export const stale = (task: Task, pauseEpoch: number) => task.claim !== null && (task.claim.pauseEpoch ?? 0) !== pauseEpoch

export const lapsed = (task: Task, at: number, pauseEpoch: number) => task.state === 'claimed' && (stale(task, pauseEpoch) || Date.parse(task.claim!.until) <= at)

export const holdEndsLease = (claim: NonNullable<Task['claim']>) => claim.until === claim.holdUntil

export function expiry(root: Pick<Message, 'id' | 'thread'>, task: Task, at: number, waits = false) {
  const claim = task.claim!
  const hardEnd = holdEndsLease(claim) && Date.parse(claim.until) <= at
  return {
    type: 'task.expired' as const,
    payload: {
      id: root.id, thread: root.thread, epoch: task.epoch,
      ...(hardEnd ? { reason: 'hold' as const } : {}),
      ...(waits ? { waiting: true } : {}),
    },
  }
}

/** Record an expiry before a write can hide it, even if the lease timer hasn't run. */
export function expiredClaim(root: Message, at: number, pauseEpoch: number, waits = false) {
  return root.task && lapsed(root.task, at, pauseEpoch) ? [expiry(root, root.task, at, waits)] : []
}
