import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig, parseConfigText } from '../config/load.ts'
import { planMob } from './plan.ts'
import { syncSkills } from './sync.ts'

const usage = 'usage: swarm skills sync --dir DIR [--party FILE] [--repo FILE] [--dry-run] [--force] [--json]'
const planUsage = 'usage: swarm skills plan-mob --skills DIR --tag TAG --job JOB --serial N\n' +
  '       [--live A,B] [--sprite JOB]... [--party FILE] [--repo FILE] [--registry FILE] [--json]'

function escapeControls(text: string, controls = /[\x00-\x1f\x7f-\x9f]/g) {
  return text.replace(controls, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function printError(message: string) {
  console.error(`error: ${escapeControls(message)}`)
}

function misuse(message: string, commandUsage = usage): number {
  printError(message)
  console.error(commandUsage)
  return 2
}

function failure(error: unknown): number {
  if (!(error instanceof Error)) throw error
  printError(error instanceof ConfigError && error.field ? `${error.field}: ${error.message}` : error.message)
  return 1
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

function planMobMain(flags: string[]): number {
  if (flags.length === 1 && flags[0] === '--help') {
    console.log(planUsage)
    return 0
  }
  let values
  try {
    ;({ values } = parseArgs({
      args: flags,
      options: {
        skills: { type: 'string' }, tag: { type: 'string' }, job: { type: 'string' },
        serial: { type: 'string' }, live: { type: 'string' }, sprite: { type: 'string', multiple: true },
        party: { type: 'string' }, repo: { type: 'string' }, registry: { type: 'string' },
        json: { type: 'boolean' },
      },
    }))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()), planUsage)
  }
  const { skills, tag, job } = values
  if (!skills) return misuse('--skills is required', planUsage)
  if (!tag) return misuse('--tag is required', planUsage)
  if (!job) return misuse('--job is required', planUsage)
  if (!values.serial) return misuse('--serial is required', planUsage)
  const serial = values.serial.replace(/^0+/, '')
  if (!serial || /\D/.test(serial)) return misuse('--serial must be a positive integer', planUsage)

  try {
    const config = loadConfig({ party: readLayer(values.party), repo: readLayer(values.repo) })
    const plan = planMob(config, {
      skills, tag, job, serial, live: values.live, sprite: values.sprite, registry: values.registry,
    })
    if (values.json) console.log(escapeControls(JSON.stringify(plan)))
    else {
      console.log(`mob  ${escapeControls(plan.mob)}`)
      console.log(`title  ${escapeControls(plan.title)}`)
      console.log(`class  ${plan.class}`)
      for (const sprite of plan.sprites) console.log(`sprite  ${escapeControls(sprite)}`)
      console.log(`brief  sha256:${plan.brief_sha256}`)
      console.log(`open  ${plan.open_placeholders} placeholders left for the spawner\n`)
      process.stdout.write(plan.brief)
    }
    return 0
  } catch (error) {
    return failure(error)
  }
}

export function skillsMain(args: string[]): number {
  const [action, ...flags] = args
  if (action === 'plan-mob') return planMobMain(flags)
  if ((action === '--help' && flags.length === 0) ||
      (action === 'sync' && flags.length === 1 && flags[0] === '--help')) {
    console.log(action === '--help' ? `${usage}\n${planUsage}` : usage)
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
    return failure(error)
  }
}
