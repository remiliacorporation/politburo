import { attentionFor, needsAttentionAnswer } from './attention-store.ts'
import { claimOrder, claimable, lapsed } from './claim-order.ts'
import { byWritten, isTask, type State, type TaskRoot, type Viewer } from './store.ts'

export function needsAction(state: State, viewer: Viewer | null, now: number) {
  const decisions: TaskRoot[] = []
  const stalled: TaskRoot[] = []
  const candidates: TaskRoot[] = []
  const errors = new Set(viewer ? Object.values(state.openTaskAttentionRefusals) : [])
  if (state.tasksRefused !== null) errors.add(state.tasksRefused)
  for (const root of Object.values(state.openTaskRoots)) {
    if (!isTask(root) || root.deleted) continue
    const { readError } = attentionFor(state, root, viewer)
    if (readError !== null) errors.add(readError)
    if (needsAttentionAnswer(state, root)) decisions.push(root)
    else if (lapsed(root, now) && (!viewer || !claimable(root, viewer, now))) stalled.push(root)
    else candidates.push(root)
  }
  return {
    errors: [...errors],
    decisions: decisions.sort(byWritten), // The request has no creation time in the API; use the root's age.
    stalled: stalled.sort((a, b) => a.task.claim!.until.localeCompare(b.task.claim!.until) || byWritten(a, b)),
    ready: viewer ? claimOrder(candidates, viewer, now) : [],
  }
}

/** Keep the relative order of surviving rows, adding newcomers after them in their current group. */
export function keepOrder(rows: TaskRoot[], previous: ReadonlyMap<string, number>): TaskRoot[] {
  return [...rows].sort((a, b) => (previous.get(a.id) ?? Infinity) - (previous.get(b.id) ?? Infinity))
}
