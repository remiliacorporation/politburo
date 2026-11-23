import type { MirrorStore } from './store.ts'
import { isoNow, mirrorKinds, type MirrorClock, type MirrorKind, type MirrorRead, type MirrorReader, type MirrorRecord } from './types.ts'

export type MirrorSummary = { kind: MirrorKind; complete: boolean; seen: number; created: number; changed: number; stale?: true }

export async function syncMirror({ reader, store, repo, now }: {
  reader: MirrorReader; store: MirrorStore; repo: string; now: MirrorClock
}): Promise<MirrorSummary[]> {
  // Stamp the start of the read so a slow older poll cannot overwrite a newer one.
  const observedAt = isoNow(now)
  let reads: readonly MirrorRead[]
  try { reads = await reader({ repo }) } catch { reads = [] }
  repo = repo.toLowerCase()
  let previous: MirrorRecord[] | undefined
  let failed = false
  const summary: MirrorSummary[] = []
  for (const kind of mirrorKinds) {
    try {
      const scope = { repo, kind }
      const read = reads.find((entry) => entry.kind === kind)
      const items = (read?.items ?? []).filter((row) => row.repo.toLowerCase() === repo && row.kind === kind && row.state !== 'gone')
      const seen = new Set(items.map((row) => row.key))
      const complete = read?.complete === true && seen.size === read.items.length
      // The status check and writes assume one writer per repo.
      const status = await store.status.read(scope)
      if (status && status.observedAt > observedAt) {
        summary.push({ kind, complete, seen: seen.size, created: 0, changed: 0, stale: true })
        continue
      }
      await store.status.write(scope, { complete: false, observedAt, reason: 'sync_interrupted' })
      const records = items.map((row) => ({ ...row, repo, observedAt }))
      if (complete) {
        previous ??= await store.list({ repo })
        for (const row of previous) {
          if (row.kind === kind && !seen.has(row.key)) {
            records.push({ ...row, state: 'gone', observedAt })
          }
        }
      }
      const counts = await store.upsert(records, { insertOnly: !complete })
      await store.status.write(scope, {
        complete, observedAt, ...(!complete ? { reason: read?.reason ?? (read ? 'unexpected_response' : 'gh_failed') } : {}),
      })
      summary.push({ kind, complete, seen: seen.size, ...counts })
    } catch { failed = true }
  }
  if (failed) throw new Error('mirror write failed')
  return summary
}
