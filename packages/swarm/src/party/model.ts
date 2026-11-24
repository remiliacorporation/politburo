import { principalOf, RegistryError } from './principal.ts'
export { RegistryError } from './principal.ts'

export type Role = 'member' | 'reader'
export type Member = { email: string; role: Role }
export type Party = { id: string; name: string; colour: string; members: Member[] }
export type Registry = { version: 1; jockeys: string[]; parties: Party[] }

export function emptyRegistry(): Registry {
  return { version: 1, jockeys: [], parties: [] }
}

function object(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  const proto = value === null || typeof value !== 'object' ? undefined : Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new RegistryError(field, 'must be an object')
  for (const key of Reflect.ownKeys(value as object)) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      throw new RegistryError(field ? `${field}.${String(key)}` : String(key), 'unknown field')
    }
  }
  return value as Record<string, unknown>
}

function list<T>(value: unknown, field: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new RegistryError(field, 'must be an array')
  return Array.from(value, (item, index) => parse(item, `${field}.${index}`))
}

function unique(value: string, seen: Set<string>, field: string): string {
  if (seen.has(value)) throw new RegistryError(field, 'duplicate value')
  seen.add(value)
  return value
}

function emailOf(value: unknown, field: string, seen: Set<string>): string {
  if (typeof value !== 'string' || value !== value.toLowerCase()) {
    throw new RegistryError(field, 'must be a lowercase email')
  }
  try {
    principalOf(value)
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error
    throw new RegistryError(field, error.message)
  }
  return unique(value, seen, field)
}

export function validateRegistry(value: unknown): Registry {
  const { version, jockeys, parties } = object(value, '', ['version', 'jockeys', 'parties'])
  if (version !== 1) throw new RegistryError('version', 'must be 1')
  const ids = new Set<string>()
  const jockeyEmails = new Set<string>()
  return {
    version,
    jockeys: list(jockeys, 'jockeys', (item, field) => emailOf(item, field, jockeyEmails)),
    parties: list(parties, 'parties', (item, field) => {
      const { id, name, colour, members } = object(item, field, ['id', 'name', 'colour', 'members'])
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new RegistryError(`${field}.id`, 'invalid party id')
      if (typeof name !== 'string' || !name.trim()) throw new RegistryError(`${field}.name`, 'must be non-empty text')
      if (typeof colour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(colour)) throw new RegistryError(`${field}.colour`, 'must be #RRGGBB')
      unique(id, ids, `${field}.id`)
      const emails = new Set<string>()
      return {
        id, name, colour,
        members: list<Member>(members, `${field}.members`, (item, path) => {
          const { email, role } = object(item, path, ['email', 'role'])
          if (role !== 'member' && role !== 'reader') throw new RegistryError(`${path}.role`, 'must be member or reader')
          return { email: emailOf(email, `${path}.email`, emails), role }
        }),
      }
    }),
  }
}
