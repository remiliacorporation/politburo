// Local stub for WP-404's Ready to pull order.
export type QueueItem = { work_id: string; priority: number; ready_at: string; party?: string }

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

export function orderReadyToPull(items: QueueItem[]): QueueItem[] {
  return items.toSorted((a, b) => b.priority - a.priority
    || Date.parse(a.ready_at) - Date.parse(b.ready_at)
    || cmp(a.work_id, b.work_id))
}
