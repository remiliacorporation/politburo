import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig, parseConfigText } from '../config/load.ts'
import { syncSkills } from './sync.ts'

const usage = 'usage: swarm skills sync --dir DIR [--party FILE] [--repo FILE] [--dry-run] [--force] [--json]'

function escapeControls(text: string, controls = /[\x00-\x1f\x7f-\x9f]/g) {
  return text.replace(controls, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function printError(message: string) {
  console.error(`error: ${escapeControls(message)}`)
}

function misuse(message: string): number {
  printError(message)
  console.error(usage)
  return 2
}

function readLayer(path: string | undefined): unknown {
  if (path === undefined) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${path}`)
  }
  return parseConfigText(text)
}

export function skillsMain(args: string[]): number {
  const [action, ...flags] = args
  if ((action === '--help' && flags.length === 0) ||
      (action === 'sync' && flags.length === 1 && flags[0] === '--help')) {
    console.log(usage)
    return 0
  }
  if (action === undefined) return misuse('missing skills command')
  if (action !== 'sync') return misuse(`unknown skills command ${action}`)

  let values
  try {
    ;({ values } = parseArgs({
      args: flags,
      options: {
        dir: { type: 'string' },
        party: { type: 'string' },
        repo: { type: 'string' },
        'dry-run': { type: 'boolean' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
  }
  if (!values.dir) return misuse('--dir is required')

  try {
    const config = loadConfig({ party: readLayer(values.party), repo: readLayer(values.repo) })
    const files = syncSkills(config, values.dir, values['dry-run'], values.force)
    if (values.json) {
      console.log(escapeControls(JSON.stringify({ files }), /[\x7f-\x9f]/g))
    } else {
      for (const { path, action } of files) console.log(`${action}  ${escapeControls(path)}`)
    }
    return 0
  } catch (error) {
    if (!(error instanceof Error)) throw error
    printError(error instanceof ConfigError && error.field ? `${error.field}: ${error.message}` : error.message)
    return 1
  }
}
