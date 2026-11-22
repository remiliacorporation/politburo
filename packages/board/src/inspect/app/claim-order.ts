import { priorityRank } from '../../contract/schemas.ts'
import { byWritten, type TaskRoot, type Viewer } from './store.ts'

// The one place the page decides which tasks claim-next can take for the viewer, and in what order.
// Needs action and the task list both read it, so what they show cannot drift from each other.
// Pinned to the board's own claim-next by test/claim-order.test.ts.

const assigned = (root: TaskRoot, viewer: Viewer) => root.task.for === viewer.actor && root.task.owner === viewer.principal

/** Whether a task's claim is over: past its lease, so claim-next treats it as ready whatever the board last wrote. */
export const lapsed = (root: TaskRoot, now: number) =>
  root.task.state === 'claimed' && root.task.claim !== null && Date.parse(root.task.claim.until) <= now

/**
 * Whether the viewer's default claim-next can take this task now: its own pool (assigned to them, or
 * unassigned and theirs), where they may label, not parked, ready, a lapsed claim included. `from` is an
 * explicit per-claim choice, not a viewer setting, so tasks of other owners are never claimable here.
 * What the page cannot know: a claim fenced by a pause is claimable again after resume while its lease
 * is unexpired, and the board's API doesn't say so, so such a task counts as held.
 */
export function claimable(root: TaskRoot, viewer: Viewer, now: number): boolean {
  const { task, channel } = root
  return !root.deleted && !task.parked && (task.state === 'ready' || lapsed(root, now)) && viewer.may('label', channel) &&
    (assigned(root, viewer) || (task.for === null && task.owner === viewer.principal))
}

/**
 * Claim-next's order: priority first, then tasks assigned to the viewer, then the oldest. The board scans
 * roots in log order and the page has `createdAt` (then ID), so ties match while the board's clock moves forward.
 */
export const byClaim = (viewer: Viewer) => (a: TaskRoot, b: TaskRoot): number =>
  priorityRank(b.task.priority) - priorityRank(a.task.priority) ||
  Number(assigned(b, viewer)) - Number(assigned(a, viewer)) ||
  byWritten(a, b)

/** The tasks claim-next can take for the viewer, in the order it takes them. */
export function claimOrder(roots: readonly TaskRoot[], viewer: Viewer, now: number): TaskRoot[] {
  return roots.filter((root) => claimable(root, viewer, now)).sort(byClaim(viewer))
}

/** Every task, the ones claim-next can take first and in its order, then the rest by priority and age. */
export function claimFirst(roots: readonly TaskRoot[], viewer: Viewer, now: number): TaskRoot[] {
  const first = claimOrder(roots, viewer, now)
  const taken = new Set(first.map(({ id }) => id))
  const rest = roots.filter(({ id }) => !taken.has(id)).sort((a, b) => priorityRank(b.task.priority) - priorityRank(a.task.priority) || byWritten(a, b))
  return [...first, ...rest]
}
