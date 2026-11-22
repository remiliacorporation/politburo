import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { errorMessage, jsonlSink } from './alerts.ts'
import { diffAlerts, parseScriptLog, parseShadowLog } from './diff.ts'
import { ghPrSource } from './prlog.ts'
import { replay } from './replay.ts'
import { watchService } from './service.ts'
import type { WatchBoard } from './stall.ts'

const boardSignal = new AsyncLocalStorage<AbortSignal | undefined>()
let readers = 0
let restoreFetch: () => void

async function readBoard<T>(signal: AbortSignal | undefined, read: () => Promise<T>) {
  // The Node SDK ignores board({ fetch }) for BOARD_URL and replaces default auth for named boards.
  // Bind its final transport instead, only in the async scope of a configured board read.
  if (readers++ === 0) {
    const fetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const signal = boardSignal.getStore()
      if (!signal) return fetch(input, init)
      const request = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      return fetch(input, { ...init, signal: request ? AbortSignal.any([request, signal]) : signal })
    }
    restoreFetch = () => { globalThis.fetch = fetch }
  }
  // Keep the binding until the SDK settles, even if the service has stopped waiting.
  try { return await boardSignal.run(signal, read) }
  finally { if (--readers === 0) restoreFetch() }
}

async function configuredBoard(): Promise<WatchBoard | undefined> {
  const name = process.env.BOARD_NAME || undefined
  if (!name && !process.env.BOARD_URL?.trim() && !process.env.VERCEL_ORG_ID) return undefined
  // Resolve the board SDK that runtime already depends on.
  const sdk = createRequire(import.meta.resolve('@remilia/politburo-runtime')).resolve('@vercel/board')
  const { board } = await import(pathToFileURL(sdk).href) as { board(options?: { name?: string }): WatchBoard }
  const handle = board(name ? { name } : undefined)
  return {
    status: (signal) => readBoard(signal, () => handle.status()),
    poll: (query, signal) => readBoard(signal, () => handle.poll(query)),
    agents: { list: (channel, signal) => readBoard(signal, () => handle.agents.list(channel)) },
  }
}

const str = { type: 'string' } as const
const bool = { type: 'boolean' } as const
function fail(text: string, code = 2) { console.error(`error: ${text}`); return code }
async function prepare(path: string) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, '', { mode: 0o600 })
}

export async function run(argv: string[], makeBoard: () => WatchBoard | undefined | Promise<WatchBoard | undefined> = configuredBoard): Promise<number> {
  const [command, ...args] = argv
  if (args.includes('--live') || args.some((arg) => arg.startsWith('--live='))) return fail('live watch is not enabled')
  const options: ParseArgsOptionsConfig | undefined = command === 'diff' ? { script: str, service: str, tolerance: str, json: bool }
    : command === 'run' ? { shadow: bool, out: str } : command === 'replay' ? { out: str } : undefined
  if (!options) return fail('expected watch diff, replay, or run')
  let parsed
  try { parsed = parseArgs({ args, options, allowPositionals: command === 'replay' }) }
  catch { return fail('invalid watch arguments') }
  const { values, positionals } = parsed
  const string = (name: string) => typeof values[name] === 'string' ? values[name] : undefined
  const [script, service, tolerance, out] = ['script', 'service', 'tolerance', 'out'].map(string)
  const json = values.json === true
  try {
    if (command === 'diff') {
      if (!script || !service) return fail('diff requires --script and --service')
      const toleranceMinutes = tolerance === undefined ? 10 : Number(tolerance)
      if (tolerance?.trim() === '' || !Number.isFinite(toleranceMinutes) || toleranceMinutes < 0) return fail('invalid tolerance')
      const result = diffAlerts(parseScriptLog(await readFile(script, 'utf8')),
        parseShadowLog(await readFile(service, 'utf8')), { toleranceMinutes })
      if (json) console.log(JSON.stringify(result))
      else if (result.missing.length) for (const { at, kind, line } of result.missing) console.log(`missing  ${at} ${kind} (script line ${line})`)
      else console.log(`same alerts: ${result.matched.length} matched, ${result.extra.length} extra`)
      return result.missing.length ? 1 : 0
    }
    if (command === 'replay') {
      if (positionals.length !== 1) return fail('replay requires one frames file')
      const alerts = await replay(JSON.parse(await readFile(positionals[0]!, 'utf8')))
      if (out) await prepare(out)
      const sink = out ? jsonlSink(out) : (alert: unknown) => console.log(JSON.stringify(alert))
      for (const alert of alerts) await sink(alert)
      return 0
    }
    if (!out) return fail('run requires --out')
    if (makeBoard === configuredBoard && process.env.BOARD_NAME && process.env.BOARD_URL?.trim()) return fail('set only one board location')
    const board = await makeBoard()
    if (!board) return fail('no board configured')
    const stop = new AbortController()
    const abort = () => stop.abort()
    process.on('SIGINT', abort).on('SIGTERM', abort)
    try {
      await prepare(out)
      await watchService({ board, prs: ghPrSource(), sink: jsonlSink(out), statePath: `${out}.prs.json`, signal: stop.signal })
    } finally {
      process.off('SIGINT', abort).off('SIGTERM', abort)
    }
    return 0
  } catch (error) {
    const message = errorMessage(error, `watch ${command} failed`)
    if (json) { console.log(JSON.stringify({ error: message })); return 1 }
    return fail(message, 1)
  }
}
