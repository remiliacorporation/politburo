export type SourceKind = 'github' | 'linear'
export type SourceRef = { source: string; itemId: string; displayId: string; url: string }
export type ItemState = 'open' | 'done' | 'withdrawn' | 'unknown'
export type Priority = 'urgent' | 'high' | 'normal' | 'low' | 'lowest' | 'none'
export type Observation = {
  ref: SourceRef
  title: string
  rawState: string
  state: ItemState
  priority: Priority
  labels: string[]
  assignees: string[]
  updatedAt: string
  observedAt: string
}

export interface TrackerAdapter {
  readonly source: string
  scan(cursor?: string): Promise<{ items: Observation[]; nextCursor?: string; complete: boolean }>
  get(ref: SourceRef): Promise<Observation | 'gone' | 'inaccessible'>
}

export class TrackerError extends Error {
  readonly reason: 'bad_source' | 'no_credential' | 'unauthorized' | 'unavailable'
    | 'rate_limited' | 'bad_response' | 'write_disabled'

  constructor(reason: TrackerError['reason']) {
    super(reason)
    this.name = 'TrackerError'
    this.reason = reason
  }
}

export function parseSourceId(id: string): { kind: SourceKind; scope: string } {
  const github = /^github:([a-zA-Z0-9-]+\/(?!\.{1,2}$)[a-zA-Z0-9_.-]+)$/.exec(id)?.[1]
  if (github) return { kind: 'github', scope: github }
  const linear = /^linear:([A-Z0-9]+)$/.exec(id)?.[1]
  if (linear) return { kind: 'linear', scope: linear }
  throw new TrackerError('bad_source')
}

export function badge(ref: SourceRef): string {
  return parseSourceId(ref.source).kind === 'github' ? `GH#${ref.displayId}` : `LIN ${ref.displayId}`
}
