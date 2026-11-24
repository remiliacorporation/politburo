#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { stringify } from 'yaml'
import { ConfigError, loadConfig, parseConfigText } from './config/load.ts'
import { rolloutMain } from './rollout/rollout-cli.ts'
import { skillsMain } from './skills/cli.ts'
import { runSetup } from './sprite/cli.ts'
import { workCommand, workUsage } from './work/cli.ts'

const usage = 'usage: swarm config <show|validate> [--json] [--party FILE] [--repo FILE]\n       swarm trackers scan <repo> [--party FILE] [--repo FILE] [--json]\n       swarm skills sync --dir DIR [--party FILE] [--repo FILE] [--dry-run] [--force] [--json]\n       swarm capture <run|collect>\n       swarm mirror sync --repo owner/name [--json]\n       swarm overlap <work-id> --work FILE [--max-age-minutes N] [--json]\n       swarm rollout <add|notify|ack|stale|show> [--dir D] [--json]\n       swarm serve --help'

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

async function main(args: string[]): Promise<number> {
  const [command, action, ...flags] = args
  if (command === 'work') return workCommand(args.slice(1))
  if (command === 'setup') return runSetup(args.slice(1))
  if (args.length === 1 && command === '--help') {
    console.log(`${usage}\n${workUsage}`)
    return 0
  }
  if (args.length === 2 && command === 'config' && action === '--help') {
    console.log(usage)
    return 0
  }
  if (command === 'skills') return skillsMain(args.slice(1))
  if (command === undefined) return misuse('missing command')
  if (command === 'rollout') return rolloutMain(args.slice(1))
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

// One line per area: the loader returns run(argv): Promise<number>.
const subcommands: Record<string, () => Promise<{ run(argv: string[]): Promise<number> }>> = {
  claims: () => import('./claims/cli.ts'),
  check: () => import('./checks/cli.ts'),
  watch: () => import('./watch/cli.ts'),
  trackers: () => import('./trackers/cli.ts'),
  cutover: () => import('./cutover/cli.ts'),
  mail: async () => ({
    run: async (argv: string[]) => {
      if (argv[0] === 'bridge') return (await import('./mail/cli.ts')).runMail(argv)
      const { run } = await import('./cutover/cli.ts')
      return run(argv, 'mail')
    },
  }),
  capture: async () => ({ run: (await import('./capture/cli.ts')).captureMain }),
  secretary: async () => ({ run: (await import('./secretary/cli.ts')).secretaryMain }),
  mirror: async () => ({ run: async (argv) => (await import('./mirror/command.ts')).runMirrorCommand(['mirror', ...argv]) }),
  overlap: async () => ({ run: async (argv) => (await import('./mirror/command.ts')).runMirrorCommand(['overlap', ...argv]) }),
  outcome: async () => ({ run: (argv) => import('./outcomes/cli.ts').then((mod) => mod.outcomeCommand(argv, console)) }),
  setup: async () => ({ run: async (argv) => runSetup(argv) }),
}
const [subcommand, ...subargs] = process.argv.slice(2)
const area = subcommand !== undefined && Object.hasOwn(subcommands, subcommand) ? subcommands[subcommand] : undefined
process.exitCode = subcommand === 'serve'
  ? await (await import('./identity/serve.ts')).serveCommand(subargs)
  : area ? await (await area()).run(subargs) : await main(process.argv.slice(2))
