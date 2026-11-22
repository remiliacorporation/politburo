import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig, parseConfigText } from '../config/load.ts'
import { allocateMobSpecies, allocateSecretaryName, allocateSpawnerName, allocateSpriteItem } from './names.ts'
import { allocateSerial } from './serial.ts'

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

function fail(headline: string, code: 1 | 2): number {
  console.error(`error: ${headline.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) =>
    `\\u{${char.codePointAt(0)!.toString(16)}}`)}`)
  return code
}

export function allocMain(args: string[]): number {
  const [command, ...flags] = args
  if (command !== 'serial' && command !== 'name') {
    return fail(command === undefined ? 'missing alloc command' : `unknown alloc command ${command}`, 2)
  }

  let parsed
  try {
    parsed = parseArgs({
      args: flags,
      allowPositionals: command === 'name',
      options: {
        json: { type: 'boolean' },
        dir: { type: 'string' },
        'in-use': { type: 'string', multiple: true },
        party: { type: 'string' },
        repo: { type: 'string' },
      } as const,
    })
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return fail(error.message.replace(/^./, (letter) => letter.toLowerCase()), 2)
  }

  const { values, positionals } = parsed
  const unsupported = (command === 'serial' ? ['in-use', 'party', 'repo'] : ['dir'])
    .find((option) => Object.hasOwn(values, option))
  if (unsupported) return fail(`unknown option --${unsupported} for ${command}`, 2)

  try {
    if (command === 'serial') {
      const dir = values.dir ?? process.env.SWARM_SERIAL_DIR
      if (!dir) return fail('serial requires --dir or SWARM_SERIAL_DIR', 2)
      const serial = allocateSerial(dir)
      console.log(values.json ? JSON.stringify({ serial }) : serial)
    } else {
      const [kind, job] = positionals
      const numbered = kind === 'species' || kind === 'item'
      if (!numbered && kind !== 'spawner' && kind !== 'secretary') {
        return fail('name requires spawner, secretary, species or item', 2)
      }
      if (positionals.length !== (numbered ? 2 : 1) || (numbered && !job)) {
        return fail(numbered ? `${kind} requires one job` : `${kind} takes no job`, 2)
      }
      const input = values['in-use']
      if (input === undefined) return fail('name requires --in-use (repeat for each name; use an empty string for no names)', 2)
      const used = input.length === 1 && input[0] === '' ? [] : input
      const config = loadConfig({ party: readLayer(values.party), repo: readLayer(values.repo) })
      const { spawners, secretaries, mob_species: mob, sprite_items: items } = config.names
      const pools = [spawners, secretaries, mob.boss, ...Object.values(mob.passive),
        ...Object.values(mob.neutral), ...Object.values(mob.hostile), ...Object.values(items)] as string[][]
      const invalid = (name: string) => /[\p{Cc}\p{Cf}\s\p{White_Space},]/u.test(name)
      if (used.some((name) => !name || invalid(name))) return fail('invalid --in-use name', 1)
      if (pools.some((pool) => pool.some(invalid))) return fail('invalid configured pool name', 1)
      const name = kind === 'spawner' ? allocateSpawnerName(config, used)
        : kind === 'secretary' ? allocateSecretaryName(config, used)
        : kind === 'species' ? allocateMobSpecies(config, job!, used)
        : allocateSpriteItem(config, job!, used)
      console.log(values.json ? JSON.stringify({ name }) : name)
    }
    return 0
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const field = error instanceof ConfigError ? error.field : ''
    return fail(field ? `${field}: ${error.message}` : error.message, 1)
  }
}
