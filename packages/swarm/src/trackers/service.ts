import { mergeWorkItems, sourceOrder, type ExplicitLink, type SourceStatus } from './merge.ts'
import { TrackerError, type Observation, type TrackerAdapter } from './types.ts'

export type SourceScan = { status: SourceStatus; pages: number; reason?: TrackerError['reason'] }

export async function scanTrackers({ sources, precedence, links, maxPages = 20 }: {
  sources: { adapter: TrackerAdapter }[]; precedence: string[]; links?: ExplicitLink[]; maxPages?: number
}) {
  if (new Set(sources.map(({ adapter }) => adapter.source)).size !== sources.length) throw new TrackerError('bad_source')
  const order = sourceOrder(precedence)
  const statuses: Record<string, SourceScan> = Object.create(null)
  const observations = new Map<string, Observation>()
  const limit = Number.isFinite(maxPages) ? Math.floor(maxPages) : 20
  for (const { adapter } of [...sources].sort((a, b) => order(a.adapter.source, b.adapter.source))) {
    const result: SourceScan = { status: 'partial', pages: 0 }
    statuses[adapter.source] = result
    let cursor: string | undefined
    try {
      while (result.pages < limit) {
        const page = await adapter.scan(cursor)
        result.pages++
        for (const item of page.items) {
          const key = JSON.stringify([item.ref.source, item.ref.itemId])
          const previous = observations.get(key)
          const elapsed = previous ? Date.parse(item.updatedAt) - Date.parse(previous.updatedAt) : 0
          if (!previous || elapsed > 0 || (elapsed === 0 && JSON.stringify(item) < JSON.stringify(previous))) {
            observations.set(key, item)
          }
        }
        if (page.complete) result.status = 'complete'
        cursor = page.nextCursor
        if (page.complete || cursor === undefined) break
      }
    } catch (error) {
      result.status = result.pages ? 'partial' : 'error'
      result.reason = error instanceof TrackerError ? error.reason : 'unavailable'
    }
  }
  const sourceStatus = Object.fromEntries(Object.entries(statuses).map(([source, { status }]) => [source, status]))
  return { items: mergeWorkItems([...observations.values()], { precedence, links, sourceStatus }), sources: { ...statuses } }
}
