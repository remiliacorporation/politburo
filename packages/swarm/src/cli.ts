#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { stringify } from 'yaml'
import { ConfigError, loadConfig, parseConfigText } from './config/load.ts'
import { skillsMain } from './skills/cli.ts'

const usage = 'usage: swarm config <show|validate> [--json] [--party FILE] [--repo FILE]\n       swarm trackers scan <repo> [--party FILE] [--repo FILE] [--json]'

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

function printError(headline: string) {
  const safe = headline.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  console.error(`error: ${safe}`)
}

function misuse(message: string): number {
  printError(message)
  console.error(usage)
  return 2
}

function main(args: string[]): number {
  const [command, action, ...flags] = args
  if (
    (args.length === 1 && command === '--help') ||
    (args.length === 2 && command === 'config' && action === '--help')
  ) {
    console.log(usage)
    return 0
  }
  if (command === 'skills') return skillsMain(args.slice(1))
  if (command === undefined) return misuse('missing command')
  if (command !== 'config') return misuse(`unknown command ${command}`)
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

// One line per area: the subcommand's module exports run(argv): Promise<number>.
const subcommands: Record<string, () => Promise<{ run(argv: string[]): Promise<number> }>> = {
  check: () => import('./checks/cli.ts'),
  watch: () => import('./watch/cli.ts'),
  trackers: () => import('./trackers/cli.ts'),
}
const [subcommand, ...subargs] = process.argv.slice(2)
const area = subcommand !== undefined && Object.hasOwn(subcommands, subcommand) ? subcommands[subcommand] : undefined
process.exitCode = area ? await (await area()).run(subargs) : main(process.argv.slice(2))
