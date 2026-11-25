import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { collect, HostStatusError, toJson, toText } from '../host/status.ts'

export const name = 'host'
export const summary = 'host status --root DIR [--json]'
export const usageOrder = 25
export const usage = ['swarm host status --root DIR [--launchd DIR] [--proc DIR] [--json]']

const usageText = 'usage: swarm host status --root DIR [--launchd DIR] [--proc DIR] [--json]'

function printError(headline: string) {
  const safe = headline.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  console.error(`error: ${safe}`)
}

function misuse(message: string): number {
  printError(message)
  console.error(usageText)
  return 2
}

export function run(argv: string[]): number {
  const [action, ...flags] = argv
  if (action !== 'status') return misuse(action === undefined ? 'missing host command' : `unknown host command ${action}`)
  let values: { root?: string; launchd?: string[]; proc?: string; json?: boolean }
  try {
    ;({ values } = parseArgs({
      args: flags,
      strict: true,
      options: {
        root: { type: 'string' },
        launchd: { type: 'string', multiple: true },
        proc: { type: 'string' },
        json: { type: 'boolean' },
      },
    }))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
  }
  if (!values.root?.trim()) return misuse('missing --root')
  try {
    const rows = collect({
      root: resolve(values.root),
      ...(values.launchd?.length ? { launchd: values.launchd.map((dir) => resolve(dir)) } : {}),
      ...(values.proc !== undefined ? { proc: resolve(values.proc) } : {}),
    })
    process.stdout.write(values.json ? toJson(rows) : toText(rows))
    return 0
  } catch (error) {
    if (error instanceof HostStatusError) {
      printError(error.message)
      return 1
    }
    throw error
  }
}
