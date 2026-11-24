import { badge, type ItemState, type Observation, type Priority } from './types.ts'

export type ExplicitLink = { workId: string; refs: { source: string; itemId: string }[] }
export type SourceStatus = 'complete' | 'partial' | 'error'
export type WorkItem = {
  key: string
  workId?: string
  title: string
  observations: Observation[]
  badges: string[]
  state: ItemState
  stateSource?: string
  disagreements: { source: string; state: ItemState }[]
  priority: Priority
  stale: boolean
  conflict?: string
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export function sourceOrder(precedence: string[]) {
  const rank = (source: string) => {
    const index = precedence.indexOf(source)
    return index === -1 ? precedence.length : index
  }
  return (a: string, b: string) => rank(a) - rank(b) || compare(a, b)
}

export function mergeWorkItems(observations: Observation[], opts: {
  precedence: string[]; links?: ExplicitLink[]; sourceStatus?: Record<string, SourceStatus>
}): WorkItem[] {
  const order = sourceOrder(opts.precedence)
  const sorted = [...observations].sort((a, b) => order(a.ref.source, b.ref.source)
    || compare(a.ref.itemId, b.ref.itemId) || compare(JSON.stringify(a), JSON.stringify(b)))
  const groups = new Map<string, Pick<WorkItem, 'observations' | 'workId' | 'conflict'>>()
  for (const observation of sorted) {
    const { source, itemId } = observation.ref
    const ids = new Set<string>()
    for (const label of observation.labels) {
      const match = /^work:([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(label)
      if (match) ids.add(match[1]!.toLowerCase())
    }
    for (const link of opts.links ?? []) {
      if (link.refs.some((ref) => ref.source === source && ref.itemId === itemId)) ids.add(link.workId.toLowerCase())
    }
    const workId = ids.size === 1 ? [...ids][0] : undefined
    const key = workId === undefined ? `ref:${source}:${itemId}` : `work:${workId}`
    const group = groups.get(key) ?? { observations: [], workId }
    if (ids.size > 1) group.conflict = 'conflicting work ids'
    group.observations.push(observation)
    groups.set(key, group)
  }
  return [...groups].sort(([a], [b]) => compare(a, b)).map(([key, group]) => {
    const { observations } = group
    const winner = observations.find((item) => item.state !== 'unknown')
    const { title, priority, state } = winner ?? observations[0]!
    const stale = observations.some(({ ref }) => (opts.sourceStatus?.[ref.source] ?? 'complete') !== 'complete')
    const disagreements = observations.filter((item) => item.state !== state)
      .map(({ ref, state }) => ({ source: ref.source, state }))
    return {
      key, ...group, title, badges: observations.map(({ ref }) => badge(ref)),
      state, stateSource: winner?.ref.source, disagreements, priority, stale,
    }
  })
}
