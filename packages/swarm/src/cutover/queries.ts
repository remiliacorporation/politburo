import { execFile } from 'node:child_process'
import { parseArgs } from 'node:util'
import { currentTag, CutoverError, hasOnly, type Clock } from './ports.ts'

export const urgencies = ['p0', 'p1', 'p2', 'p3'] as const
export type Urgency = typeof urgencies[number]
export interface LedgerRecord {
  id: string; urgency: Urgency; from: string; at: string
  deliveredAt?: string; wokenAt?: string; ackedAt?: string; deliveries?: number
}
export interface LedgerPort { records(tag: string, since?: string): Promise<LedgerRecord[]> }

export function misuse(field: string, why: string): never {
  throw new CutoverError('usage', `${field}: ${why}`)
}

export function argvJson(text: string | undefined, field: string): [string, ...string[]] {
  let argv: unknown
  try { argv = JSON.parse(text ?? '') } catch { misuse(field, 'expected an argv JSON array') }
  if (!Array.isArray(argv) || !argv[0] || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    misuse(field, 'expected strings with a non-empty executable and no NUL bytes')
  }
  return argv as [string, ...string[]]
}

export function isoDateTime(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(text) ||
      !Number.isFinite(Date.parse(text))) return false
  const year = Number(text.slice(0, 4)), month = Number(text.slice(5, 7)), day = Number(text.slice(8, 10))
  // Shift by 400 years to avoid Date.UTC's special handling of years 0–99.
  return new Date(Date.UTC(year + 400, month - 1, day)).toISOString().slice(5, 10) === text.slice(5, 10)
}

function isRecord(value: unknown): value is LedgerRecord {
  if (!hasOnly(value, 'id urgency from at deliveredAt wokenAt ackedAt deliveries')) return false
  const r = value
  return typeof r.id === 'string' && r.id.length > 0 && typeof r.from === 'string' &&
    urgencies.includes(r.urgency as Urgency) && typeof r.at === 'string' &&
    [r.deliveredAt, r.wokenAt, r.ackedAt].every(t => t === undefined || typeof t === 'string') &&
    (r.deliveries === undefined || (typeof r.deliveries === 'number' && Number.isInteger(r.deliveries) && r.deliveries >= 0))
}

export function commandLedger([program, ...args]: [string, ...string[]]): LedgerPort {
  return { async records(tag, since) {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(program, [...args, tag, ...(since === undefined ? [] : ['--since', since])],
          { env: {}, encoding: 'utf8' }, (error, out) => error ? reject(error) : resolve(out)).stdin?.end()
      })
      const records: unknown = JSON.parse(stdout)
      if (Array.isArray(records) && records.every(isRecord)) return records
    } catch { /* never echo child output or command arguments */ }
    throw new CutoverError('ledger_unreadable', 'ledger_unreadable: cannot read ledger records')
  } }
}

const needsAck = (r: LedgerRecord) => r.urgency === 'p0' || r.urgency === 'p1'

function soakTime(text: string): number {
  // Date.parse truncates fractional seconds beyond milliseconds.
  return isoDateTime(text) && !/\.\d{4}/.test(text) ? Date.parse(text) : NaN
}

export async function soak(tag: string, ledger: LedgerPort, since?: string, p1Minutes = 10) {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 }
  const missedP0P1: string[] = [], duplicates: string[] = [], unknownDeliveries: string[] = []
  const lateP0: string[] = [], lateP1: string[] = []
  let unknownTimes = 0
  for (const r of await ledger.records(tag, since)) {
    counts[r.urgency]++
    const { deliveries } = r
    if (deliveries === undefined || !Number.isFinite(deliveries)) unknownDeliveries.push(r.id)
    else if (deliveries > 1) duplicates.push(r.id)
    if (!r.deliveredAt && needsAck(r)) missedP0P1.push(r.id)
    const delay = r.deliveredAt ? soakTime(r.deliveredAt) - soakTime(r.at) : NaN
    const knownDelay = Number.isFinite(delay) && delay >= 0
    if (!knownDelay || (r.ackedAt !== undefined && !isoDateTime(r.ackedAt))) unknownTimes++
    if (knownDelay && r.urgency === 'p0' && delay > 60_000) lateP0.push(r.id)
    if (knownDelay && r.urgency === 'p1' && delay > p1Minutes * 60_000) lateP1.push(r.id)
  }
  const dirty = missedP0P1.length || duplicates.length || unknownDeliveries.length || lateP0.length || lateP1.length || unknownTimes
  return { counts, missedP0P1, duplicates, unknownDeliveries, lateP0, lateP1, unknownTimes,
    verdict: counts.p0 + counts.p1 === 0 ? 'empty' : dirty ? 'not clean' : 'clean' }
}

export async function acks(tag: string, ledger: LedgerPort, since?: string, clock: Clock = Date) {
  const records = (await ledger.records(tag, since)).filter(needsAck).map(r => ({ ...r,
    state: r.ackedAt && isoDateTime(r.ackedAt) ? 'acked' : r.wokenAt ? 'woken' : r.deliveredAt ? 'delivered' : 'undelivered' }))
  const cutoff = clock.now() - 15 * 60_000
  const overdue = records.filter(r => r.state !== 'acked' && Date.parse(r.at) < cutoff).map(r => r.id)
  return { records, overdue }
}

export function plain(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function rows(entries: [string, string | number][]) {
  const width = entries.reduce((max, [label]) => Math.max(max, label.length), 0)
  for (const [label, value] of entries) console.log(`${label.padEnd(width)}  ${value}`)
}

export function commandFailure(error: unknown, json = false): number {
  const failure = error instanceof CutoverError ? error :
    (error as NodeJS.ErrnoException)?.code?.startsWith('ERR_PARSE_ARGS')
      ? new CutoverError('usage', 'flags: invalid or missing value')
      : new CutoverError('command_failed', 'command failed')
  if (json) console.log(JSON.stringify({ reason: failure.reason, headline: failure.headline }))
  else console.error(`error: ${failure.headline}`)
  return failure.reason === 'usage' ? 2 : 1
}

export async function runQuery(action: 'soak' | 'acks', tag: string | undefined, args: string[]): Promise<number> {
  const string = { type: 'string' } as const
  let json = false
  try {
    const { values: v } = parseArgs({ args, options: { since: string, json: { type: 'boolean' },
      'ledger-cmd': string, 'p1-minutes': string } })
    json = v.json ?? false
    if (!tag || !currentTag.test(tag)) misuse('tag', 'expected two or three lowercase letters')
    if (v.since !== undefined && !isoDateTime(v.since)) misuse('since', 'expected an ISO date-time')
    if (action === 'acks' && v['p1-minutes'] !== undefined) misuse('p1-minutes', 'only allowed for soak')
    const minutes = Number(v['p1-minutes'] ?? 10)
    if (v['p1-minutes']?.trim() === '' || !Number.isFinite(minutes * 60_000) || minutes < 0) {
      misuse('p1-minutes', 'expected non-negative minutes')
    }
    const ledger = commandLedger(argvJson(v['ledger-cmd'], 'ledger-cmd'))
    const ids = (list: string[]) => list.length ? `${list.length} (${list.map(plain).join(', ')})` : '0'
    if (action === 'soak') {
      const result = await soak(tag, ledger, v.since, minutes)
      if (json) console.log(JSON.stringify(result))
      else rows([...Object.entries(result.counts), ['missed p0/p1', ids(result.missedP0P1)],
        ['duplicates', ids(result.duplicates)], ['unknown deliveries', ids(result.unknownDeliveries)],
        ['late p0', ids(result.lateP0)], ['late p1', ids(result.lateP1)],
        ['unknown times', result.unknownTimes], ['verdict', result.verdict]])
      return result.verdict === 'not clean' ? 1 : 0
    }
    const result = await acks(tag, ledger, v.since)
    if (json) console.log(JSON.stringify(result))
    else rows([...result.records.map((r): [string, string] => [plain(r.id), `${r.urgency}  ${r.state}`]),
      ['overdue', ids(result.overdue)]])
    return 0
  } catch (error) { return commandFailure(error, json) }
}
