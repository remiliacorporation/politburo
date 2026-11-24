import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { WatchError, type AlertSink } from './alerts.ts'

type Pr = { number: number; head: string; state: 'open' | 'draft' | 'merged' | 'closed'; checks: 'pass' | 'fail' | 'pending' | 'unknown' }
export interface PrSource { list(signal?: AbortSignal): Promise<readonly Pr[]> }

type Exec = (args: string[], signal?: AbortSignal) => Promise<string>
const gh: Exec = async (args, signal) => (await promisify(execFile)('gh', args, { signal, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout

function checks(rollup: unknown): Pr['checks'] {
  if (!Array.isArray(rollup) || !rollup.length) return 'unknown'
  const results = rollup.map((check) => {
    const state = check?.state ?? (check?.status === 'COMPLETED' ? check?.conclusion : check?.status)
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)) return 'pass'
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(state)) return 'fail'
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(state)) return 'pending'
    return 'unknown'
  })
  return results.includes('fail') ? 'fail' : results.includes('pending') ? 'pending'
    : results.includes('unknown') ? 'unknown' : 'pass'
}

export function ghPrSource(exec: Exec = gh): PrSource {
  return { async list(signal) {
    const stdout = await exec(['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,headRefOid,state,isDraft,statusCheckRollup'], signal)
    let rows: unknown
    try { rows = JSON.parse(stdout) } catch { throw new WatchError('invalid gh pr list response') }
    if (!Array.isArray(rows)) throw new WatchError('invalid gh pr list response')
    return rows.map((row): Pr => {
      if (!Number.isSafeInteger(row?.number) || row.number <= 0 || typeof row.headRefOid !== 'string' || !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(row.headRefOid)) {
        throw new WatchError('invalid gh pr list row')
      }
      const state = row.state === 'OPEN' ? (row.isDraft === true ? 'draft' : 'open')
        : row.state === 'CLOSED' ? 'closed' : row.state === 'MERGED' ? 'merged' : undefined
      if (!state) throw new WatchError('invalid gh pr state')
      return { number: row.number, head: row.headRefOid, state, checks: checks(row.statusCheckRollup) }
    })
  } }
}

export function prLog(source: PrSource, sink: AlertSink, { statePath, now = Date.now }: { statePath?: string; now?: () => number } = {}) {
  let previous: Map<number, Pr> | undefined
  return { async poll(signal?: AbortSignal) {
    let baseline = previous
    if (!baseline && statePath) {
      const text = await readFile(statePath, { encoding: 'utf8', signal }).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (text !== undefined) baseline = new Map((JSON.parse(text) as Pr[]).map((pr) => [pr.number, pr]))
    }
    signal?.throwIfAborted()
    const rows = await source.list(signal)
    signal?.throwIfAborted()
    const next = new Map(baseline)
    const at = new Date(now()).toISOString()
    for (const { number, head, state, checks } of rows) {
      const pr = { number, head, state, checks }, old = baseline?.get(number)
      const terminal = state === 'merged' || state === 'closed'
      if (!old && terminal) continue // The feed also includes historical terminal PRs.
      const emit = (what: string, value: string) => {
        signal?.throwIfAborted()
        return sink({ at, kind: 'pr', key: `pr:${number}:${what}:${value}`, text: `pr #${number} ${what}: ${value}` })
      }
      if (!old && baseline) await emit('opened', pr.state)
      if (old) for (const field of ['state', 'head', 'checks'] as const) {
        if (old[field] !== pr[field]) await emit(field, pr[field])
      }
      if (terminal && old?.state !== state) next.delete(number)
      else next.set(number, pr)
    }
    // Emit before checkpointing: at-least-once delivery across interruption.
    signal?.throwIfAborted()
    if (statePath) {
      await mkdir(dirname(statePath), { recursive: true })
      const temp = `${statePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify([...next.values()]), { mode: 0o600, flag: 'wx', signal })
        signal?.throwIfAborted()
        await rename(temp, statePath)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
    }
    signal?.throwIfAborted()
    previous = next
  } }
}
