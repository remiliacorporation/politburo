import { addDecimal } from './decimal.ts'
import { BUCKETS, COVERAGE_STATES, type Basis, type Bucket, type CoverageState, type Dispatch, type SpendRecord } from './types.ts'

export type EnvelopeField = 'party' | 'repo' | 'work_id' | 'attempt' | 'tier' | 'parent' | 'session' | 'trace_id' | 'execution_id' | 'sponsor'
export type Level = 'sprite' | 'mob' | 'work_item' | 'spawner' | 'repo' | 'party'
export type LevelScope = Partial<Record<'party' | 'repo' | 'work_id' | 'execution_id', string | null>>

type LedgerRead = {
  heads(): readonly SpendRecord[]
  dispatches(): readonly Dispatch[]
}
type Key = Record<string, string | null>
type TokenTotal = { known: number; known_records: number; unknown_records: number }
type AmountTotal = { basis: Exclude<Basis, 'unknown' | 'not_applicable'>; unit: string; known: string; records: number }
export type Totals = {
  records: number
  coverage: Record<CoverageState, number>
  tokens: Record<Bucket, TokenTotal>
  amounts: AmountTotal[]
  amount_unknown_records: number
  executions: { total: number; without_records: number }
}
export type GroupRow = { key: Key; totals: Totals }
export type LevelRow = { level: Level; key: Key; own: Totals; inclusive: Totals }

type Execution = {
  fields: Record<EnvelopeField, string | null>
  records: SpendRecord[]
}

function byExecution(ledger: LedgerRead): Map<string, Execution> {
  const executions = new Map<string, Execution>()
  for (const { envelope: { trace, ...fields }, sponsor } of ledger.dispatches()) {
    executions.set(trace.execution_id, {
      fields: { ...fields, execution_id: trace.execution_id, trace_id: trace.id, sponsor }, records: [],
    })
  }
  for (const record of ledger.heads()) {
    if (record.envelope) executions.get(record.envelope.trace.execution_id)?.records.push(record)
  }
  return executions
}

function compare(a: string | null, b: string | null): number {
  return a === b ? 0 : a === null || (b !== null && a < b) ? -1 : 1
}

function compareKeys(a: Key, b: Key): number {
  for (const field of Object.keys(a)) {
    const order = compare(a[field]!, b[field]!)
    if (order) return order
  }
  return 0
}

function aggregate(executions: readonly Execution[], unbound: readonly SpendRecord[] = []): Totals {
  const coverage = Object.fromEntries(COVERAGE_STATES.map((state) => [state, 0])) as Totals['coverage']
  const amounts = new Map<string, AmountTotal>()
  const buckets = BUCKETS.map((bucket) => ({ bucket, known: 0n, known_records: 0, unknown_records: 0 }))
  let records = 0
  let amountUnknown = 0
  let missing = 0

  function add(r: SpendRecord) {
    records++
    coverage[r.coverage.state]++
    if (r.coverage.state === 'conflict') {
      for (const tally of buckets) {
        if (r.coverage.field_quality[`tokens.${tally.bucket}`] !== 'not_applicable') tally.unknown_records++
      }
      if (r.basis !== 'not_applicable') amountUnknown++
      return
    }
    for (const tally of buckets) {
      const value = r.tokens[tally.bucket]
      if (value !== null) {
        tally.known += BigInt(value)
        tally.known_records++
      } else if (r.coverage.field_quality[`tokens.${tally.bucket}`] !== 'not_applicable') {
        tally.unknown_records++
      }
    }
    if (r.basis === 'unknown') amountUnknown++
    if (r.amount && r.basis !== 'unknown' && r.basis !== 'not_applicable') {
      const { basis } = r
      const { value, unit } = r.amount
      const key = `${basis}:${unit}`
      const total = amounts.get(key) ?? { basis, unit, known: '0', records: 0 }
      total.known = addDecimal(total.known, value)
      total.records++
      amounts.set(key, total)
    }
  }

  for (const execution of executions) {
    if (!execution.records.length) missing++
    for (const record of execution.records) add(record)
  }
  for (const record of unbound) add(record)

  const tokens = Object.fromEntries(buckets.map(({ bucket, known, known_records, unknown_records }) => {
    const count = Number(known)
    if (!Number.isSafeInteger(count)) throw new RangeError(`tokens.${bucket}: subtotal exceeds safe integer range`)
    return [bucket, { known: count, known_records, unknown_records: unknown_records + missing }]
  })) as Totals['tokens']
  return {
    records, coverage, tokens,
    amounts: [...amounts.values()].sort((a, b) => compare(a.basis, b.basis) || compare(a.unit, b.unit)),
    amount_unknown_records: amountUnknown + missing,
    executions: { total: executions.length, without_records: missing },
  }
}

function matches(execution: Execution, where: Partial<Record<EnvelopeField, string | null>>): boolean {
  return (Object.keys(where) as EnvelopeField[]).every((field) => execution.fields[field] === where[field])
}

function group(executions: Iterable<Execution>, fields: readonly EnvelopeField[]) {
  const groups = new Map<string, { key: Key; members: Execution[] }>()
  for (const execution of executions) {
    const key = Object.fromEntries(fields.map((field) => [field, execution.fields[field]]))
    const id = JSON.stringify(key)
    const row = groups.get(id) ?? { key, members: [] }
    row.members.push(execution)
    groups.set(id, row)
  }
  return [...groups.values()].sort((a, b) => compareKeys(a.key, b.key))
}

export function rollupBy(
  ledger: LedgerRead, by: EnvelopeField | EnvelopeField[], where: Partial<Record<EnvelopeField, string | null>> = {},
): GroupRow[] {
  const executions = [...byExecution(ledger).values()].filter((execution) => matches(execution, where))
  return group(executions, Array.isArray(by) ? by : [by]).map(({ key, members }) => ({ key, totals: aggregate(members) }))
}

export function rollupLevel(ledger: LedgerRead, level: Level, scope: LevelScope = {}): LevelRow[] {
  const all = byExecution(ledger)
  // Never add inclusive totals across adjacent levels: each fact is counted once per row, as its current head.
  if (level === 'sprite' || level === 'mob' || level === 'spawner') {
    const roots = new Map<string, { own: Execution; inclusive: Execution[] }>()
    for (const execution of all.values()) {
      if (execution.fields.tier === level && matches(execution, scope)) {
        roots.set(execution.fields.execution_id!, { own: execution, inclusive: [execution] })
      }
    }
    // The scope picks the rows; what a row includes is found among every execution.
    for (const execution of all.values()) {
      if (level === 'spawner') {
        const { sponsor, execution_id } = execution.fields
        if (sponsor !== null && sponsor !== execution_id) roots.get(sponsor)?.inclusive.push(execution)
      } else if (level === 'mob') {
        const seen = new Set([execution.fields.execution_id])
        let parent = execution.fields.parent
        while (parent !== null && !seen.has(parent)) {
          seen.add(parent)
          roots.get(parent)?.inclusive.push(execution)
          parent = all.get(parent)?.fields.parent ?? null
        }
      }
    }
    return [...roots.entries()].sort(([a], [b]) => compare(a, b)).map(([execution_id, row]) => {
      const own = aggregate([row.own])
      return { level, key: { execution_id }, own, inclusive: row.inclusive.length === 1 ? own : aggregate(row.inclusive) }
    })
  }
  const executions = [...all.values()]
  const groups = level === 'work_item'
    ? group(executions.filter((e) => e.fields.work_id !== null), ['party', 'repo', 'work_id'])
    : level === 'repo'
      ? group(executions.filter((e) => e.fields.repo !== null), ['party', 'repo'])
      : group(executions, ['party'])
  // A scope selects groups, not a subset of each group's spend.
  return groups.filter(({ members }) => members.some((e) => matches(e, scope))).map(({ key, members }) => ({
    level, key, inclusive: aggregate(members),
    own: aggregate(members.filter(({ fields: { tier, parent, work_id, repo } }) =>
      level === 'work_item' ? tier !== 'mob' && tier !== 'sprite' && parent === null
        : level === 'repo' ? work_id === null : repo === null)),
  }))
}

export function unmatched(ledger: Pick<LedgerRead, 'heads'>): Totals {
  return aggregate([], ledger.heads().filter((record) => record.envelope === null))
}
