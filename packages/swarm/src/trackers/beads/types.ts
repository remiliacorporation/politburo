// Local stub of WP-407's scan/get interface (mob 285-BEE).
// Its implementation is not on main yet.
export type BdRunner = (args: readonly string[]) => Promise<string>

export type Reason =
  | { kind: 'closed'; detail?: string }
  | { kind: 'in_progress'; assignee?: string }
  | { kind: 'hooked' } | { kind: 'pinned' }
  | { kind: 'deferred'; until?: string }
  | { kind: 'status_blocked' }
  | { kind: 'blocked_by'; ids: string[]; via: 'edge' | 'parent' }
  | { kind: 'unknown_status'; status: string }
  | { kind: 'unexplained' }
export type Runnability = { runnable: true } | { runnable: false; reasons: [Reason, ...Reason[]] }

export interface BeadItem {
  source: 'beads'; store: string; id: string; title: string; status: string
  priority: number | undefined; type: string | undefined
  parent?: string; assignee?: string; externalRef?: string; runnable: Runnability
}
export interface Disagreement {
  id: string; bdReady: boolean; derivedReady: boolean
  kind: 'bd_withholds' | 'bd_offers' | 'unlisted'; reasons: Reason[]
}
export interface ScanResult {
  source: 'beads'; store: string; epic: string; observedAt: string
  items: BeadItem[]; disagreements: Disagreement[]
}
export interface TrackerAdapter {
  scan(query: { epic: string }): Promise<ScanResult>
  get(id: string): Promise<BeadItem | undefined>
}
