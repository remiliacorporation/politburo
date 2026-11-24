export const mirrorKinds = ['pr', 'branch', 'issue'] as const
export type MirrorKind = typeof mirrorKinds[number]
export type MirrorRecord = {
  kind: MirrorKind
  repo: string
  key: string
  state: 'open' | 'closed' | 'merged' | 'gone'
  draft?: boolean
  title?: string
  author?: string
  head?: { ref: string; sha: string }
  base?: string
  updatedAt?: string
  observedAt: string
}

export type MirrorStatus = { complete: boolean; observedAt: string; reason?: string }
export type MirrorReason = 'gh_failed' | 'unexpected_response' | 'page_limit' | 'sync_interrupted'
export type MirrorItem = Omit<MirrorRecord, 'observedAt'>
export type MirrorRead = { kind: MirrorKind; complete: boolean; items: MirrorItem[]; reason?: MirrorReason }
export type MirrorReader = (options: { repo: string }) => Promise<readonly MirrorRead[]>
export type MirrorClock = () => number | Date | string

export const mirrorReasons = ['gh_failed', 'unexpected_response', 'page_limit', 'sync_interrupted'] as const
export const isoNow = (now: MirrorClock) => new Date(now()).toISOString()
export const validRepo = (repo: string) => /^[a-z0-9-]+\/[a-z0-9_.-]+$/iu.test(repo) && !/\/\.{1,2}$/u.test(repo)
