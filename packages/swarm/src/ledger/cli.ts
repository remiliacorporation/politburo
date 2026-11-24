import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  BUCKETS, fromBenchRun, ingest, LedgerError, openLedger, rollupBy, rollupLevel, unmatched,
  validateDispatch, type Dispatch, type EnvelopeField, type Ledger, type Level, type LevelScope,
  type SpendRecord, type Totals,
} from './index.ts'
import { SCHEMA_VERSION } from './schema.ts'

const usage = 'usage: swarm ledger <dispatch|append|rollup> --db FILE [options]'
const levels = ['sprite', 'mob', 'work_item', 'spawner', 'repo', 'party'] satisfies Level[]
const fields = [
  'party', 'repo', 'work_id', 'attempt', 'tier', 'parent', 'session', 'trace_id', 'execution_id', 'sponsor',
] satisfies EnvelopeField[]

class ReadError extends Error {}

function printError(headline: string) {
  const safe = headline.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  console.error(`error: ${safe}`)
}

function misuse(message: string): number {
  printError(message)
  console.error(usage)
  return 2
}

function readInput(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path === '-' ? 0 : path, 'utf8')
  } catch {
    throw new ReadError(path === '-' ? 'cannot read stdin' : `cannot read ${path}`)
  }
  try { return JSON.parse(text) } catch { throw new ReadError('invalid json input') }
}

function sqlite() {
  // On Node 22, keep the experimental SQLite warning off the CLI's stderr.
  const emit = process.emitWarning
  process.emitWarning = (warning, ...args: unknown[]) => {
    if (warning === 'SQLite is an experimental feature and might change at any time') return
    Reflect.apply(emit, process, [warning, ...args])
  }
  try { return process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') }
  finally { process.emitWarning = emit }
}

type DispatchRow = Omit<Dispatch['envelope'], 'trace'> & {
  execution_id: string; trace_id: string; sponsor: string | null; created: string
}
type HeadRow = Omit<SpendRecord, 'envelope' | 'tokens' | 'amount' | 'coverage' | 'actor' | 'reason' | 'exit_reason'>
  & SpendRecord['tokens'] & {
    seq: number; execution_id: string | null; amount_value: string | null; amount_unit: string | null
    coverage_state: SpendRecord['coverage']['state']; field_quality: string
    actor: string | null; reason: string | null; exit_reason: string | null
  }

function readLedger(file: string): Pick<Ledger, 'dispatches' | 'heads'> {
  if (!statSync(file, { throwIfNoEntry: false })) throw new ReadError(`no ledger at ${file}`)
  // openLedger takes a writer lock. Read the same schema in one read-only snapshot.
  const db = new (sqlite().DatabaseSync)(resolve(file), { readOnly: true })
  try {
    db.exec('BEGIN')
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== SCHEMA_VERSION) throw new LedgerError('version', 'unsupported ledger schema version')
    const dispatches = (db.prepare('SELECT * FROM dispatches').all() as unknown as DispatchRow[])
      .map(({ execution_id, trace_id, sponsor, created, ...envelope }): Dispatch => ({
        envelope: { ...envelope, trace: { id: trace_id, execution_id } }, sponsor, created,
      }))
    const envelopes = new Map(dispatches.map(({ envelope }) => [envelope.trace.execution_id, envelope]))
    const heads = (db.prepare('SELECT * FROM heads').all() as unknown as HeadRow[]).map(({
      seq, execution_id, amount_value, amount_unit, coverage_state, field_quality, actor, reason, exit_reason,
      input_uncached, input_total, output, cache_read, cache_write, reasoning, ...fact
    }): SpendRecord => ({
      ...fact,
      envelope: execution_id === null ? null : envelopes.get(execution_id)!,
      tokens: { input_uncached, input_total, output, cache_read, cache_write, reasoning },
      amount: amount_value === null ? null : { value: amount_value, unit: amount_unit! },
      coverage: { state: coverage_state, field_quality: JSON.parse(field_quality) },
      ...(actor === null ? {} : { actor }), ...(reason === null ? {} : { reason }),
      ...(exit_reason === null ? {} : { exit_reason }),
    }))
    return { dispatches: () => dispatches, heads: () => heads }
  } finally {
    db.close()
  }
}

function append(ledger: Ledger, input: unknown, execution: string | undefined): number {
  if (input && typeof input === 'object' && 'schema' in input && input.schema === 'bench-run@1') {
    const dispatch = execution === undefined ? null : ledger.dispatch(execution)
    if (execution !== undefined && !dispatch) {
      throw new LedgerError('unknown_dispatch', 'execution_id: no persisted dispatch')
    }
    const record = fromBenchRun(input, { envelope: dispatch?.envelope ?? null, received: new Date().toISOString() })
    if ('skipped' in record) {
      console.log(`skipped  ${record.skipped}`)
      return record.skipped === 'invalid' ? 1 : 0
    }
    // Receipt time is not part of the incoming bench fact; reuse it on replay.
    const prior = ledger.record(record.record_id)
    input = prior?.dedupe_key === record.dedupe_key ? { ...record, received: prior.received } : record
  }
  const { outcome, record_id } = ingest(ledger, input)
  console.log(`${outcome === 'dedupe_mismatch' ? 'mismatch' : outcome}  ${record_id}`)
  return outcome === 'dedupe_mismatch' ? 1 : 0
}

function totalsLines(totals: Totals, indent: string): string[] {
  const { records, executions, tokens, amounts, amount_unknown_records } = totals
  const lines = [
    `records  ${records}`,
    `executions  ${executions.total}  (${executions.without_records} without records)`,
    ...BUCKETS.map((bucket) => `${bucket}  ${tokens[bucket].known} known  ${tokens[bucket].unknown_records} unknown`),
    ...amounts.map(({ basis, unit, known, records }) => `${basis}  ${unit}  ${known}  (${records} records)`),
    `amount unknown  ${amount_unknown_records}`,
  ]
  return lines.map((line) => indent + line)
}

type Row = ReturnType<typeof rollupLevel>[number] | ReturnType<typeof rollupBy>[number] | Totals

function printRows(rows: Row[], json: boolean) {
  if (json) {
    console.log(JSON.stringify({ rows }))
    return
  }
  const groups = rows.map((row) => {
    if (!('key' in row)) return ['unmatched', ...totalsLines(row, '  ')].join('\n')
    const key = Object.values(row.key).map((value) => value ?? 'null').join('  ')
    if (!('level' in row)) return [key, ...totalsLines(row.totals, '  ')].join('\n')
    return [
      `${row.level}  ${key}`,
      '  own', ...totalsLines(row.own, '    '),
      '  inclusive', ...totalsLines(row.inclusive, '    '),
    ].join('\n')
  })
  if (groups.length) console.log(groups.join('\n\n'))
}

export function ledgerCommand(args: string[]): number {
  const [action, ...flags] = args
  if (action === '--help' && !flags.length) {
    console.log(usage)
    return 0
  }
  if (action === undefined) return misuse('missing ledger command')
  if (action !== 'dispatch' && action !== 'append' && action !== 'rollup') {
    return misuse(`unknown ledger command ${action}`)
  }

  const string = { type: 'string' } as const
  const bool = { type: 'boolean' } as const
  let parsed
  try {
    parsed = parseArgs({
      args: flags, strict: true, allowPositionals: action !== 'rollup',
      options: {
        db: string,
        ...(action !== 'dispatch' ? { execution: string } : {}),
        ...(action === 'rollup' ? {
          level: string, by: string, unmatched: bool, json: bool, party: string, repo: string, 'work-id': string,
        } : {}),
      },
    })
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
  }
  const { values, positionals } = parsed
  if (!values.db) return misuse('missing --db')
  if (positionals.length > 1) return misuse('expected one input')
  const level = typeof values.level === 'string' ? values.level as Level : undefined
  const by = typeof values.by === 'string' ? values.by.split(',') as EnvelopeField[] : undefined
  const execution = typeof values.execution === 'string' ? values.execution : undefined
  if (action === 'rollup') {
    if ([level !== undefined, by !== undefined, !!values.unmatched].filter(Boolean).length !== 1) {
      return misuse('choose one of --level, --by or --unmatched')
    }
    if (level !== undefined && !levels.includes(level)) return misuse('invalid --level')
    if (by?.some((field) => !fields.includes(field))) return misuse('invalid --by field')
  }

  try {
    if (action === 'rollup') {
      const scope: LevelScope = {}
      if (typeof values.party === 'string') scope.party = values.party
      if (typeof values.repo === 'string') scope.repo = values.repo
      if (typeof values['work-id'] === 'string') scope.work_id = values['work-id']
      if (execution !== undefined) scope.execution_id = execution
      const ledger = readLedger(values.db)
      // Unbound records have no envelope fields to match against a scope.
      const rows = level ? rollupLevel(ledger, level, scope) : by ? rollupBy(ledger, by, scope)
        : Object.keys(scope).length ? [] : [unmatched(ledger)]
      printRows(rows, !!values.json)
      return 0
    }
    const input = readInput(positionals[0] ?? '-')
    sqlite()
    const ledger = openLedger(resolve(values.db))
    try {
      if (action === 'append') return append(ledger, input, execution)
      const dispatch = validateDispatch(input)
      const { outcome } = ledger.createDispatch(dispatch)
      console.log(`${outcome}  ${dispatch.envelope.trace.execution_id}`)
      return 0
    } finally {
      ledger.close()
    }
  } catch (error) {
    if (error instanceof LedgerError && error.code === 'locked') {
      printError('ledger is locked by another process')
    } else if (error instanceof LedgerError || error instanceof ReadError || error instanceof RangeError) {
      printError(error.message)
    } else {
      printError(`cannot ${action === 'rollup' ? 'read' : 'write'} ledger at ${values.db}`)
    }
    return 1
  }
}
