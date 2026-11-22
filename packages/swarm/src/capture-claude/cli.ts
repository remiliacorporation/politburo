import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import {
  buildRecord, createReceiver, fileRegistry, jsonlWriter, parseTranscript, readJsonl, reconcile,
  releaseQuarantine, sessionFromEvidenceRef, type Envelope, type RequestFact, type SpendRecord,
} from './index.ts'
import { buckets as tokenBuckets, identifier } from './facts.ts'
import { tokenFingerprint } from './record.ts'

const usage = `usage: swarm capture-claude serve --dir DIR [--port N]
       swarm capture-claude bind --dir DIR --session NATIVE_ID --party P
         --tier core|spawner|secretary|mob|sprite|jockey --trace TRACE_ID
         --execution EXEC_ID [--ref INTERNAL_SESSION] [--repo R] [--work W]
         [--attempt A] [--parent X] [--json]
       swarm capture-claude check --dir DIR --session NATIVE_ID
         --transcript FILE [--write] [--json]
       swarm capture-claude --help`
const string = { type: 'string' } as const
const boolean = { type: 'boolean' } as const
const options = {
  serve: { dir: string, port: string },
  bind: {
    dir: string, session: string, party: string, tier: string, trace: string, execution: string,
    ref: string, repo: string, work: string, attempt: string, parent: string, json: boolean,
  },
  check: { dir: string, session: string, transcript: string, write: boolean, json: boolean },
} satisfies Record<string, ParseArgsConfig['options']>

type AllOptions = typeof options.serve & typeof options.bind & typeof options.check
type FlagValues = { [K in keyof AllOptions]?: AllOptions[K]['type'] extends 'string' ? string : boolean }

class Misuse extends Error {}
class Failure extends Error {}

function safe(text: string) {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Misuse(`missing --${name}`)
  return value
}

function state(dir: string) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Failure(`state directory not found: ${dir}`)
  }
  return {
    ledger: join(dir, 'ledger.jsonl'), quarantine: join(dir, 'quarantine.jsonl'),
    registry: fileRegistry(join(dir, 'sessions.json')),
  }
}

type State = ReturnType<typeof state>
const buckets = ['input_uncached', 'output', 'cache_read', 'cache_write'] as const

async function serve(paths: State, port: number): Promise<number> {
  const receiver = createReceiver({
    registry: paths.registry, ledger: jsonlWriter(paths.ledger), quarantine: jsonlWriter(paths.quarantine),
    host: '127.0.0.1', port,
  })
  const address = await receiver.listen().catch((error) => {
    throw new Failure(error?.code === 'EADDRINUSE' ? 'receiver port is already in use' : 'cannot start receiver')
  })
  const url = `http://${address.host}:${address.port}`
  let interrupt!: () => void
  let terminate!: () => void
  const stopped = new Promise<number>((resolve) => {
    process.on('SIGINT', interrupt = () => resolve(130))
    process.on('SIGTERM', terminate = () => resolve(0))
  })
  try {
    console.log(`listening  ${url}

    # paste into a posix shell before starting claude code
    set -a
    CLAUDE_CODE_ENABLE_TELEMETRY=1
    OTEL_LOGS_EXPORTER=otlp
    OTEL_EXPORTER_OTLP_PROTOCOL=http/json
    OTEL_EXPORTER_OTLP_ENDPOINT=${url}
    OTEL_LOGS_EXPORT_INTERVAL=1000
    set +a
    # keep prompts, tool details and api bodies off (the default)`)
    const code = await stopped
    await receiver.close()
    return code
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

function bind(paths: State, session: string, envelope: Envelope, json: boolean) {
  try {
    paths.registry.bind(session, envelope)
  } catch (error) {
    if (error instanceof Error && error.message === 'native session already bound') throw new Failure(error.message)
    throw error
  }
  const { released } = releaseQuarantine({
    records: readJsonl(paths.quarantine),
    registry: { lookup: (id) => id === session ? envelope : null }, ledger: jsonlWriter(paths.ledger),
    actor: 'swarm capture-claude bind', reason: 'session bound',
  })
  console.log(json ? JSON.stringify({ bound: session, released }) : `bound  ${safe(session)}\nreleased  ${released}`)
  return 0
}

function totals(facts: RequestFact[]) {
  return Object.fromEntries(buckets.map((bucket) => {
    let sum = 0, unknown = 0
    for (const fact of facts) {
      const value = fact.tokens[bucket]
      if (value === null) unknown++
      else sum += value
    }
    return [bucket, unknown === 0 ? sum : unknown === facts.length ? { unknown } : { known: sum, unknown }]
  }))
}

function display(value: number | { unknown: number; known?: number }) {
  if (typeof value === 'number') return `${value}`
  return value.known === undefined ? `unknown (${value.unknown})` : `${value.known} known, ${value.unknown} unknown`
}

function revisionHistory(history: SpendRecord[]) {
  // A released row and its retained quarantine copy are one logical revision.
  const byKey = new Map(history.map((row) => [row.dedupe_key, row]))
  const canonical = new Map(history.map((row) => [row.record_id, byKey.get(row.dedupe_key)!.record_id]))
  const children = new Map<string, SpendRecord>()
  for (const row of byKey.values()) {
    if (row.revises === null) continue
    const parent = canonical.get(row.revises)
    if (parent && parent !== row.record_id) children.set(parent, row)
  }
  const head = (row: SpendRecord): SpendRecord => {
    let child: SpendRecord | undefined
    while ((child = children.get(row.record_id))) row = child
    return row
  }
  return { byKey, head }
}

function check(paths: State, session: string, file: string, write: boolean, json: boolean) {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { throw new Failure(`cannot read transcript ${file}`) }
  const { facts: transcript, badLines, foreign, noId } = parseTranscript(text, session)
  const requestIds = new Set(transcript.map((fact) => fact.requestId))
  const responseIds = new Set(transcript.map((fact) => fact.responseId))
  const originals = new Map<RequestFact, SpendRecord>()
  const { byKey, head } = revisionHistory([...readJsonl(paths.quarantine), ...readJsonl(paths.ledger)])
  // Compare the transcript with the original OTLP observation, not with a prior check.
  for (const record of byKey.values()) {
    if (record.source !== 'claude_local_request' || sessionFromEvidenceRef(record.evidence_ref) !== session ||
      record.coverage.state === 'closed_reconciled' || record.coverage.state === 'conflict') continue
    const [request, response] = record.evidence_ref.split('/')[2]!.split(':')
    const id = identifier(decodeURIComponent(request || response || ''))
    // Check uses the preferred ID (request first) to pair with transcript rows.
    const responseOnly = responseIds.has(id) && !requestIds.has(id)
    originals.set({
      source: 'otlp', nativeSession: session, requestId: responseOnly ? null : id,
      responseId: responseOnly ? id : null, model: record.actual_model,
      tokens: record.tokens, occurred: record.occurred,
    }, record)
  }
  const otlp = [...originals.keys()]
  const { counters, records, counterparts } = reconcile(otlp, transcript, { exactCounts: true })
  const differs = badLines || foreign || noId || counters.mismatched || counters.transcriptOnly || counters.otlpOnly
  const result = differs ? 'differs' : 'match'

  if (write) {
    const envelope = paths.registry.lookup(session)
    const writer = jsonlWriter(envelope ? paths.ledger : paths.quarantine)
    const append = (record: SpendRecord) => {
      if (writer.append(record) === 'differs') throw new Failure('check record differs from stored record')
    }
    const now = new Date()
    const actor = 'swarm capture-claude check'
    for (const item of records) {
      if (item.state === 'otlp_only') continue
      const record = buildRecord(item, envelope, now)
      const original = originals.get(item.fact)
      if (original) {
        const matched = item.state === 'matched'
        const current = head(original)
        const other = counterparts.get(item.fact)
        const state = matched ? 'closed_reconciled' : 'conflict'
        const event = !matched && other
          ? `${record.source_event_key}:${tokenFingerprint(other.tokens)}` : record.source_event_key
        if (current.coverage.state !== state || current.source_event_key !== event) {
          // The parent is part of the transition key: a later check can return to this state.
          append({
            ...record, evidence_ref: original.evidence_ref, revises: current.record_id,
            actor, reason: matched ? 'transcript match' : 'transcript mismatch',
            dedupe_key: `${record.dedupe_key}:check:${current.record_id}`, source_event_key: event,
            coverage: { ...record.coverage, state },
          })
        }
        if (matched && other) {
          const backfill = buildRecord({ ...item, fact: other, state: 'transcript_only' }, envelope, now)
          const prior = byKey.get(`${backfill.dedupe_key}:transcript`)
          if (prior && head(prior).status !== 'superseded') {
            const current = head(prior)
            const tokens = { ...current.tokens }
            const field_quality = { ...current.coverage.field_quality }
            for (const bucket of tokenBuckets) {
              tokens[bucket] = null
              field_quality[`tokens.${bucket}`] = 'unknown'
            }
            append({
              ...backfill, dedupe_key: `${current.dedupe_key}:superseded`, revises: current.record_id,
              actor, reason: 'matched late telemetry', status: 'superseded', tokens,
              coverage: { state: 'closed_reconciled', field_quality },
            })
          }
        }
      } else if (item.state === 'transcript_only') {
        const dedupe_key = `${record.dedupe_key}:transcript`
        if (!byKey.has(dedupe_key)) append({ ...record, dedupe_key })
      } else {
        append(record)
      }
    }
  }

  const sums = { otlp: totals(otlp), transcript: totals(transcript) }
  if (json) console.log(JSON.stringify({ counters, totals: sums, badTranscriptLines: badLines, foreign, noId, result }))
  else {
    const { matched, mismatched, transcriptOnly, otlpOnly } = counters
    console.log(`matched          ${matched}\nmismatched       ${mismatched}\ntranscript only  ${transcriptOnly}\notlp only        ${otlpOnly}`)
    if (badLines) console.log(`bad transcript lines  ${badLines}`)
    if (foreign) console.log(`foreign rows  ${foreign}`)
    if (noId) console.log(`rows without id  ${noId}`)
    const width = Math.max(4, ...buckets.map((key) => display(sums.otlp[key]!).length))
    console.log(`\n${' '.repeat(16)}${'otlp'.padEnd(width)}  transcript`)
    for (const key of buckets) {
      console.log(`${key.padEnd(16)}${display(sums.otlp[key]!).padEnd(width)}  ${display(sums.transcript[key]!)}`)
    }
    console.log(result)
  }
  return result === 'match' ? 0 : 1
}

export async function runCaptureClaude(args: string[]): Promise<number> {
  const [command, ...flags] = args
  let json = false
  try {
    if (command === '--help' && !flags.length) { console.log(usage); return 0 }
    if (command !== 'serve' && command !== 'bind' && command !== 'check') {
      throw new Misuse(command === undefined ? 'missing capture-claude command' : `unknown capture-claude command ${command}`)
    }
    if (flags.length === 1 && flags[0] === '--help') { console.log(usage); return 0 }
    let values: FlagValues
    try {
      values = parseArgs({ args: flags, options: options[command], strict: true }).values as FlagValues
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new Misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
    }
    json = values.json ?? false
    const dir = required(values.dir, 'dir')
    if (command === 'serve') {
      const port = values.port ?? '0'
      if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Misuse('port must be between 0 and 65535')
      return await serve(state(dir), Number(port))
    }
    const session = required(values.session, 'session')
    if (identifier(session) === null) throw new Misuse('invalid --session')
    if (command === 'check') {
      const file = required(values.transcript, 'transcript')
      return check(state(dir), session, file, values.write ?? false, json)
    }
    const tier = required(values.tier, 'tier')
    if (tier !== 'core' && tier !== 'spawner' && tier !== 'secretary' && tier !== 'mob' && tier !== 'sprite' && tier !== 'jockey') {
      throw new Misuse('invalid --tier')
    }
    const execution = required(values.execution, 'execution')
    const envelope: Envelope = {
      party: required(values.party, 'party'), tier, session: required(values.ref ?? execution, 'ref'),
      repo: values.repo ?? null, work_id: values.work ?? null, attempt: values.attempt ?? null,
      parent: values.parent ?? null, trace: { id: required(values.trace, 'trace'), execution_id: execution },
    }
    return bind(state(dir), session, envelope, json)
  } catch (error) {
    // Never echo parser or filesystem errors that might contain captured text.
    const message = error instanceof Failure || error instanceof Misuse
      ? error.message : `cannot ${command} capture data`
    if (error instanceof Misuse) {
      console.error(`error: ${safe(message)}\n${usage}`)
      return 2
    }
    if (json) console.log(JSON.stringify({ error: message }))
    else console.error(`error: ${safe(message)}`)
    return 1
  }
}
