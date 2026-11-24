import { parseArgs } from 'node:util'
import { defaultConfig } from '../config/load.ts'
import { RegistryError, type Registry } from './model.ts'
import { addJockey, addParty, getParty, loadRegistry, removeJockey, removeMember, removeParty, setMember, updateRegistry } from './store.ts'

const usage = 'usage: swarm party <list|show|add|remove|member|jockey> ... [--registry FILE]\n       or set SWARM_REGISTRY'

function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function fail(message: string, code: 1 | 2): number {
  console.error(`error: ${safe(message)}`)
  if (code === 2) console.error(usage)
  return code
}

function rows(entries: [string, string][], indent = ''): void {
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0)
  for (const [key, value] of entries) console.log(`${indent}${key.padEnd(width)}  ${safe(value)}`)
}

export function runParty(args: string[]): number {
  const [action, ...flags] = args
  if (action === '--help' && flags.length === 0) {
    console.log(usage)
    return 0
  }
  const options = {
    registry: { type: 'string' }, json: { type: 'boolean' },
    name: { type: 'string' }, colour: { type: 'string' }, role: { type: 'string' },
  } as const
  let parsed
  try {
    parsed = parseArgs({ args: flags, options, allowPositionals: true })
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return fail(error.message.replace(/^./, (letter) => letter.toLowerCase()), 2)
  }
  const { positionals, values } = parsed
  const [first, second, third] = positionals
  const read = action === 'list' || action === 'show'
  const memberWrite = action === 'member' && (first === 'add' || first === 'set')
  if (values.json && !read) return fail('--json is only for list and show', 2)
  if ((values.name !== undefined || values.colour !== undefined) && action !== 'add') {
    return fail('--name and --colour are only for party add', 2)
  }
  const { role } = values
  if (role !== undefined && (!memberWrite || (role !== 'member' && role !== 'reader'))) {
    return fail('--role must be member or reader and is only for member add and set', 2)
  }
  const count = positionals.length
  if (!(action === 'list' && count === 0 ||
    (action === 'show' || action === 'add' || action === 'remove') && count === 1 ||
    action === 'member' && (memberWrite || first === 'remove') && count === 3 ||
    action === 'jockey' && (first === 'add' || first === 'remove') && count === 2)) {
    return fail('invalid party command or arguments', 2)
  }
  if (action === 'add' && first !== 'default' && (values.name === undefined || values.colour === undefined)) {
    return fail('party add requires --name and --colour', 2)
  }

  const file = values.registry ?? process.env.SWARM_REGISTRY
  if (!file) return fail('no registry file: pass --registry FILE or set SWARM_REGISTRY', 2)
  try {
    if (action === 'list') {
      const reg = loadRegistry(file)
      if (values.json) console.log(JSON.stringify(reg))
      else rows([...reg.parties.map(({ id, name }): [string, string] => [id, name]),
        ...reg.jockeys.map((email): [string, string] => ['jockey', email])])
      return 0
    }
    if (action === 'show') {
      const party = getParty(loadRegistry(file), first!)
      if (values.json) console.log(JSON.stringify({ party }))
      else {
        rows([['id', party.id], ['name', party.name], ['colour', party.colour]])
        rows(party.members.map(({ email, role }) => [email, role]), '  ')
      }
      return 0
    }

    let mutate: (reg: Registry) => Registry
    let outcome: string
    if (action === 'add') {
      const defaults = defaultConfig().party
      mutate = (reg) => addParty(reg, { id: first!, name: values.name ?? defaults.name, colour: values.colour ?? defaults.colour })
      outcome = `added party ${first}`
    } else if (action === 'remove') {
      mutate = (reg) => removeParty(reg, first!)
      outcome = `removed party ${first}`
    } else if (action === 'member') {
      mutate = (reg) => memberWrite ? setMember(reg, second!, third!, role ?? 'member') : removeMember(reg, second!, third!)
      outcome = `${memberWrite ? 'set' : 'removed'} member ${third!.toLowerCase()} in ${second}`
    } else {
      mutate = (reg) => first === 'add' ? addJockey(reg, second!) : removeJockey(reg, second!)
      outcome = `${first === 'add' ? 'added' : 'removed'} jockey ${second!.toLowerCase()}`
    }
    updateRegistry(file, mutate)
    console.log(`${outcome}; registry saved; board grants unchanged until apply`)
    return 0
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const field = error instanceof RegistryError && error.field
    return fail(field ? `${field}: ${error.message}` : error.message, 1)
  }
}
