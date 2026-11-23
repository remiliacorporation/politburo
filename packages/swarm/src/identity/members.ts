import { parseCan, PERMISSIONS, type Grant, type GrantShape, type Permission } from '@vercel/board/access'

export type Member = Readonly<{ email: string; can: GrantShape['can'] }>
export type Members = ReadonlyMap<string, Member>

const emailPattern = /^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

export function principalId(email: string): string {
  // Board user grants match the suffix, which must fit USER_ID as well as the host ID.
  if (!emailPattern.test(email) || email.length > 197) throw new TypeError('invalid member email')
  const suffix = email.toLowerCase().replace('@', '.at.')
  if (suffix.indexOf('.at.') !== suffix.lastIndexOf('.at.')) throw new TypeError('invalid member email')
  return `cloudflare:person:${suffix}`
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function fields(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return plainObject(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function list(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return false
  return true
}

function memberCan(input: unknown): Member['can'] {
  if (!plainObject(input)) throw new TypeError('invalid member grants')
  const patterns = Reflect.ownKeys(input)
  if (!patterns.length || patterns.length > 64) throw new TypeError('invalid member grants')
  try {
    return Object.fromEntries(patterns.map((pattern) => {
      if (typeof pattern !== 'string' || /[;=\s]/.test(pattern)) throw new TypeError()
      const grant = input[pattern]
      if (grant !== 'all' && (!list(grant) || grant.length > 8 ||
          [...grant].some((permission) => !PERMISSIONS.includes(permission as Permission)))) throw new TypeError()
      const parsed = parseCan(`${pattern}=${grant === 'all' ? grant : grant.join(',')}`) as Record<string, Grant>
      if (!Object.hasOwn(parsed, pattern)) throw new TypeError()
      return [pattern, parsed[pattern]!]
    }))
  } catch {
    throw new TypeError('invalid member grants')
  }
}

export function parseMembers(input: unknown): Members {
  if (!fields(input, 'members') || !list(input.members)) throw new TypeError('invalid member registry')
  const members = new Map<string, Member>()
  for (const entry of input.members) {
    if (!fields(entry, 'email', 'can') || typeof entry.email !== 'string') throw new TypeError('invalid member entry')
    principalId(entry.email)
    const email = entry.email.toLowerCase()
    if (members.has(email)) throw new TypeError('duplicate member email')
    members.set(email, { email, can: memberCan(entry.can) })
  }
  return members
}

export function memberFor(members: Members, email: string): Member | null {
  // Some non-ASCII characters lowercase to ASCII, so check before folding.
  return emailPattern.test(email) ? members.get(email.toLowerCase()) ?? null : null
}
