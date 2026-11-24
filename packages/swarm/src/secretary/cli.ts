import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { compareJournal, parseLive, readJournal, type Difference } from './diff.ts'
import { unknownLedger } from './ledger.ts'
import { parity, parityDir } from './parity.ts'
import { redact } from './redact.ts'
import { replay, validSegment } from './replay.ts'
import { scorecard } from './scorecard.ts'
import { createShadow, type ShadowOptions } from './shadow.ts'

const string = { type: 'string' } as const, boolean = { type: 'boolean' } as const
const flags = {
  shadow: { mail: string, tag: string, out: string, once: boolean, interval: string },
  diff: { shadow: string, live: string, json: boolean },
  replay: { seed: string, dir: string, tag: string },
  parity: { dir: string },
  scorecard: { out: string, tag: string, since: string, until: string },
}
class Misuse extends Error {}
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

function printDiff(differences: Difference[], json = false) {
  const summary = differences.length ? 'diff' : 'zero diff'
  const display = (value: Difference['expected']) => value === null ? '(missing)'
    : Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.join(', ') : JSON.stringify(value)
  // Redact values before either renderer escapes them, after comparison is done.
  const safe = JSON.parse(JSON.stringify(differences, (_, value: unknown) =>
    typeof value === 'string' ? redact(value) : value)) as Difference[]
  if (json) console.log(JSON.stringify({ result: summary, differences: safe }))
  else if (!safe.length) console.log(summary)
  else for (const { id, expected, got } of safe) console.log(plain(`${id}  ${display(expected)}  ${display(got)}`))
  return differences.length ? 1 : 0
}

async function poll(options: ShadowOptions, once: boolean, interval: number) {
  const stop = new AbortController()
  const signal = () => stop.abort()
  process.on('SIGINT', signal).on('SIGTERM', signal)
  try {
    const service = await createShadow(options)
    try {
      while (!stop.signal.aborted) {
        const { appended } = await service.tick(Date.now())
        if (appended) console.log(`appended ${appended}`)
        if (once) break
        await setTimeout(interval, undefined, { signal: stop.signal }).catch((error: Error) => {
          if (error.name !== 'AbortError') throw error
        })
      }
    } finally { await service.close() }
  } finally { process.off('SIGINT', signal).off('SIGTERM', signal) }
}

function date(value: string | undefined, flag: string) {
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i.test(value) || !Number.isFinite(ms)) {
    throw new Misuse(`--${flag} must be an ISO date or timestamp`)
  }
  return ms
}

export async function secretaryMain(args: string[]): Promise<number> {
  const [command, ...rest] = args
  try {
    if (!command) throw new Misuse('expected shadow, diff, replay, parity or scorecard')
    if (!Object.hasOwn(flags, command)) throw new Misuse(`unknown secretary command ${command}`)
    let values: Record<string, unknown>
    try { ({ values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: flags[command as keyof typeof flags] })) }
    catch (error) { throw new Misuse((error as Error).message) }
    const get = (flag: string) => values[flag] as string | undefined
    const need = (flag: string) => {
      const value = get(flag)
      if (!value) throw new Misuse(`missing --${flag}`)
      return value
    }
    switch (command) {
      case 'shadow': {
        const opts = { mailDir: need('mail'), tag: need('tag'), outDir: need('out') }
        if (values.once && values.interval !== undefined) throw new Misuse('--once and --interval are mutually exclusive')
        const interval = Number(get('interval') ?? '30') * 1000
        if (!Number.isFinite(interval) || interval < 1 || interval > 2 ** 31 - 1) throw new Misuse('invalid --interval')
        await poll(opts, values.once === true, interval)
        return 0
      }
      case 'diff': {
        const shadow = need('shadow'), live = need('live')
        return printDiff(compareJournal(await readJournal(shadow), parseLive(await readFile(live, 'utf8'))), values.json === true)
      }
      case 'replay': {
        const input = need('seed'), dir = need('dir'), seed = Number(input)
        if (!/^[+-]?\d+$/.test(input) || !Number.isSafeInteger(seed)) throw new Misuse('--seed must be an integer')
        return printDiff(await replay(seed, dir, get('tag') ?? 'pb'))
      }
      case 'parity': {
        const { cases, failed } = await parity(get('dir') ?? parityDir)
        console.log(cases ? `${cases} cases, ${failed} failed` : '0 cases')
        return failed ? 1 : 0
      }
      case 'scorecard': {
        const out = need('out'), tag = need('tag')
        if (!validSegment(tag)) throw new Error('bad_tag')
        const untilMs = date(get('until'), 'until') ?? Date.now(), since = date(get('since'), 'since')
        if (since !== undefined && since > untilMs) throw new Misuse('--since is after --until')
        const records = await readJournal(join(out, tag, 'decisions.jsonl'), true)
        const sinceMs = since ?? records.reduce((first, r) => Math.min(first, 'receivedAt' in r ? r.receivedAt : r.at), untilMs)
        const rows = await scorecard({ records, ledger: unknownLedger, tag, sinceMs, untilMs })
        const width = Math.max(...Object.keys(rows).map((name) => name.length))
        for (const [name, value] of Object.entries(rows)) console.log(`${name.padEnd(width)}  ${value}`)
        return 0
      }
    }
  } catch (error) {
    console.error(`error: ${plain(redact(error instanceof Error ? error.message : 'secretary failed'))}`)
    return error instanceof Misuse ? 2 : 1
  }
  return 2
}
