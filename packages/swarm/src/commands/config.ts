import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { stringify } from 'yaml'
import { ConfigError, loadConfig, parseConfigText } from '../config/load.ts'
import { misuse, printError } from '../cli-usage.ts'

export const name = 'config'
export const summary = 'config <show|validate> [--json] [--party FILE] [--repo FILE]'

class ReadError extends Error {}

function readLayer(path: string | undefined): unknown {
  if (path === undefined) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ReadError(`cannot read ${path}`)
  }
  return parseConfigText(text)
}

export function run(args: string[]): number {
  const [action, ...flags] = args
  if (action === undefined) return misuse('missing config command')
  if (action !== 'show' && action !== 'validate') {
    return misuse(`unknown config command ${action}`)
  }

  let values
  try {
    ;({ values } = parseArgs({
      args: flags,
      strict: true,
      options: {
        json: { type: 'boolean' },
        party: { type: 'string' },
        repo: { type: 'string' },
      },
    }))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
  }

  try {
    const tree = loadConfig({
      party: readLayer(values.party),
      repo: readLayer(values.repo),
    })
    if (action === 'validate') {
      console.log(values.json ? JSON.stringify({ valid: true }) : 'valid')
    } else {
      const output = values.json ? `${JSON.stringify(tree, null, 2)}\n` : stringify(tree)
      process.stdout.write(output)
    }
    return 0
  } catch (error) {
    if (error instanceof ConfigError) {
      const { field, message } = error
      if (values.json) {
        console.log(JSON.stringify({ valid: false, field, message }))
      } else {
        printError(field ? `${field}: ${message}` : message)
      }
    } else if (error instanceof ReadError) {
      printError(error.message)
    } else {
      throw error
    }
    return 1
  }
}
