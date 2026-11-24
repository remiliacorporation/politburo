import { OPEN_WORK_GROUPS, type WorkGroup, type WorkRow } from './work.ts'

export type WorkFilter = {
  text: string
  party?: string
  group?: WorkGroup
  claimant?: string
  priority?: string
  pr?: 'none' | 'draft' | 'open' | 'merged' | 'closed' | 'fail'
  overlap?: boolean
  spend?: 'unknown' | 'partial' | 'complete' | 'stale'
}

function choice<T extends string>(value: string | null, choices: readonly T[]): T | undefined {
  return choices.find((one) => one === value)
}

export function readFilter(params: URLSearchParams): WorkFilter {
  const party = params.get('party')
  const group = choice(params.get('group'), [...OPEN_WORK_GROUPS, 'done'])
  const claimant = params.get('claimant')
  const priority = params.get('priority')
  const pr = choice(params.get('pr'), ['none', 'draft', 'open', 'merged', 'closed', 'fail'] as const)
  const overlap = params.get('overlap')
  const spend = choice(params.get('spend'), ['unknown', 'partial', 'complete', 'stale'] as const)
  return {
    text: params.get('q') ?? '',
    ...(party !== null ? { party } : {}),
    ...(group ? { group } : {}),
    ...(claimant !== null ? { claimant } : {}),
    ...(priority !== null ? { priority } : {}),
    ...(pr ? { pr } : {}),
    ...(overlap === 'true' || overlap === 'false' ? { overlap: overlap === 'true' } : {}),
    ...(spend ? { spend } : {}),
  }
}

export function filterParams({ text, ...facets }: WorkFilter): URLSearchParams {
  const params = new URLSearchParams()
  if (text) params.set('q', text)
  for (const [key, value] of Object.entries(facets)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params
}

export function filterWork(rows: readonly WorkRow[], filter: WorkFilter): WorkRow[] {
  const terms = filter.text.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((row) => {
    if (filter.party !== undefined && row.party?.id !== filter.party) return false
    if (filter.group !== undefined && row.group !== filter.group) return false
    if (filter.claimant !== undefined && row.claimant !== filter.claimant) return false
    if (filter.priority !== undefined && row.priority !== filter.priority) return false
    const pr = filter.pr === 'fail' ? (row.pr?.checks === 'fail' ? 'fail' : undefined) : row.pr?.state ?? 'none'
    if (filter.pr !== undefined && pr !== filter.pr) return false
    if (filter.overlap !== undefined && Boolean(row.overlapText) !== filter.overlap) return false
    if (filter.spend !== undefined && (row.spend?.coverage ?? 'unknown') !== filter.spend) return false
    if (!terms.length) return true
    const fields = [row.workId, row.title, row.party?.name, row.claimant, row.reason, row.prText,
      ...row.trackers.map(({ id }) => id)].join('\n').toLowerCase()
    return terms.every((term) => fields.includes(term))
  })
}

// No History view: the open-task read does not hold closed tasks.
export const SAVED_VIEWS = {
  attention: { title: 'My attention', groups: ['needs', 'review'] },
  operations: { title: 'Repo operations', groups: OPEN_WORK_GROUPS },
  available: { title: 'Available', groups: ['pull'] },
  live: { title: 'Live claims', groups: ['running'] },
  review: { title: 'Review queue', groups: ['review'] },
  exceptions: { title: 'Exceptions', groups: ['needs', 'repair'] },
} as const satisfies Readonly<Record<string, { title: string; groups: readonly WorkGroup[] }>>
