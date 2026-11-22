import { parseBlocked, parseIssues, type BdIssue } from './parse.ts'
import type { BdRunner, BeadItem, Disagreement, Reason, TrackerAdapter } from './types.ts'

const source = 'beads'
const known = new Set(['open', 'closed', 'in_progress', 'hooked', 'pinned', 'deferred', 'blocked'])

function statusReasons(issue: BdIssue, time: number): Reason[] {
  const { status, assignee, close_reason: detail, defer_until: until } = issue
  const reasons: Reason[] = []
  if (status === 'closed') reasons.push(detail === undefined ? { kind: 'closed' } : { kind: 'closed', detail })
  if (status === 'in_progress') {
    reasons.push(assignee === undefined ? { kind: 'in_progress' } : { kind: 'in_progress', assignee })
  }
  if (status === 'hooked') reasons.push({ kind: 'hooked' })
  if (status === 'pinned') reasons.push({ kind: 'pinned' })
  if (status === 'deferred' || (until !== undefined && Date.parse(until) > time)) {
    reasons.push(until === undefined ? { kind: 'deferred' } : { kind: 'deferred', until })
  }
  if (status === 'blocked') reasons.push({ kind: 'status_blocked' })
  if (!known.has(status)) reasons.push({ kind: 'unknown_status', status })
  return reasons
}

function blockerReason(issue: BdIssue, ids: string[], listed: Map<string, BdIssue>): Reason {
  // bd reports the parent gate as a blocker even without a dependency edge.
  const seen = new Set([issue.id])
  for (let parent = issue.parent; parent !== undefined && !seen.has(parent); parent = listed.get(parent)?.parent) {
    if (ids.includes(parent)) return { kind: 'blocked_by', ids, via: 'parent' }
    seen.add(parent)
  }
  return { kind: 'blocked_by', ids, via: 'edge' }
}

export function beadsAdapter({ run, store, now = () => new Date(), maxBeads = 500 }: {
  run: BdRunner; store: string; now?: () => Date; maxBeads?: number
}): TrackerAdapter {
  // Unlike list --id, show writes .beads/last-touched.
  const list = async (by: '--parent' | '--id', id: string) =>
    parseIssues(await run(['list', '--all', '--json', '-n', '0', by, id]))

  async function readiness(scope: string[]) {
    const ready = parseIssues(await run(['ready', '--json', '-n', '0', ...scope]), 'ready')
    const blocked = parseBlocked(await run(['blocked', '--json', ...scope]))
    return {
      ready: new Set(ready.map(({ id }) => id)),
      blocked: new Map(blocked.map(({ id, blocked_by }) => [id, blocked_by])),
    }
  }

  function item(issue: BdIssue, bdReady: boolean, reasons: Reason[], ids: string[], listed: Map<string, BdIssue>): BeadItem {
    const { id, title, status, priority, issue_type: type, parent, assignee, external_ref: externalRef } = issue
    const [first, ...rest] = !bdReady && status !== 'closed' && ids.length
      ? [...reasons, blockerReason(issue, ids, listed)] : reasons
    return {
      source, store, id, title, status, priority, type,
      ...(parent === undefined ? {} : { parent }), ...(assignee === undefined ? {} : { assignee }),
      ...(externalRef === undefined ? {} : { externalRef }),
      runnable: bdReady ? { runnable: true } : { runnable: false, reasons: [first ?? { kind: 'unexplained' }, ...rest] },
    }
  }

  return {
    async scan({ epic }) {
      const start = now()
      const observedAt = start.toISOString()
      const time = start.getTime()
      const listed = new Map<string, BdIssue>()
      const queue = [{ id: epic, depth: 0 }]
      for (const { id, depth } of queue) {
        for (const issue of await list('--parent', id)) {
          if (issue.id === epic || listed.has(issue.id)) continue
          if (depth >= 8 || listed.size >= maxBeads) throw new Error(`epic too large: ${epic}`)
          listed.set(issue.id, issue)
          queue.push({ id: issue.id, depth: depth + 1 })
        }
      }
      const { ready, blocked } = await readiness(['--parent', epic])
      const disagreements: Disagreement[] = []
      const items = [...listed.values()]
        // Compare numeric id segments so .2 comes before .10.
        .sort((a, b) => ((a.priority ?? Infinity) - (b.priority ?? Infinity)) ||
          a.id.localeCompare(b.id, 'en', { numeric: true }) || (a.id < b.id ? -1 : Number(a.id > b.id)))
        .map((issue) => {
          const { id } = issue
          const bdReady = ready.has(id)
          const reasons = statusReasons(issue, time)
          const ids = issue.dependencies.filter((dep) => dep.type === 'blocks' &&
            listed.get(dep.depends_on_id)?.status !== 'closed').map((dep) => dep.depends_on_id)
          const derivedReady = reasons.length === 0 && ids.length === 0
          const bead = item(issue, bdReady, reasons, blocked.get(id) ?? [], listed)
          if (bdReady && !derivedReady) {
            if (issue.status !== 'closed' && ids.length) reasons.push(blockerReason(issue, ids, listed))
            disagreements.push({ id, bdReady, derivedReady, kind: 'bd_offers', reasons })
          } else if (!bead.runnable.runnable && derivedReady) {
            disagreements.push({ id, bdReady, derivedReady, kind: 'bd_withholds', reasons: bead.runnable.reasons })
          }
          return bead
        })
      for (const id of new Set([...ready, ...blocked.keys()])) {
        if (!listed.has(id)) {
          disagreements.push({ id, bdReady: ready.has(id), derivedReady: false, kind: 'unlisted', reasons: [] })
        }
      }
      return { source, store, epic, observedAt, items, disagreements }
    },
    async get(id) {
      const time = now().getTime()
      const issues = await list('--id', id)
      const issue = issues.find((row) => row.id === id)
      if (!issue) return undefined
      const { ready, blocked } = await readiness([])
      return item(issue, ready.has(id), statusReasons(issue, time), blocked.get(id) ?? [],
        new Map(issues.map((row) => [row.id, row])))
    },
  }
}
