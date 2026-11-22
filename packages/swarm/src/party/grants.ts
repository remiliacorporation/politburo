import { BoardError, type Board, type GrantView, type PrincipalInput } from '@vercel/board'
import { RegistryError, type Registry } from './model.ts'
import { principalOf } from './principal.ts'
import { channelsFor, jockeyChannels } from './roles.ts'

type Kind = 'repo' | 'party'
type GrantOptions = { kind: Kind; party?: string }
type User = { kind: 'user'; userId: string }
type Can = GrantView['can']
type DesiredGrant = { principals: User[]; can: Can }

const user = (email: string): User => ({ kind: 'user', userId: principalOf(email).userId })

export function desiredGrants(registry: Registry, kind: Kind, partyId?: string): DesiredGrant[] {
  if (kind === 'party') {
    if (partyId === undefined) throw new RegistryError('party', 'party id is required for a party board')
    if (!/^[a-z][a-z0-9-]*$/.test(partyId)) throw new RegistryError('party', 'invalid party id')
  }
  const parties = kind === 'party' ? registry.parties.filter(({ id }) => id === partyId) : registry.parties
  const jockeys = new Set(registry.jockeys)
  const grants: DesiredGrant[] = []
  function add(party: string, role: string, principals: User[], can: Can): void {
    const limit = 32 // Board GrantSpec principals max.
    if (principals.length > limit) throw new RegistryError('grants', `${party} ${role}: board limit is ${limit} principals`)
    if (principals.length) grants.push({ principals, can })
  }
  add(kind === 'party' ? partyId! : 'all parties', 'jockey', [...jockeys].map(user), { ...jockeyChannels })
  for (const party of parties) {
    for (const role of ['member', 'reader'] as const) {
      // A narrower grant would override a jockey's wildcard access in these channels.
      const principals = party.members.filter((m) => m.role === role && !jockeys.has(m.email)).map((m) => user(m.email))
      add(party.id, role, principals, channelsFor(role, party.id, kind))
    }
  }
  return grants
}

function isBroad(principal: GrantView['principals'][number]) {
  return principal.kind === 'all-users' || principal.kind === 'all-projects' ||
    principal.kind === 'all-apps' || principal.kind === 'everyone'
}
const onlyUsers = (grant: GrantView) => grant.principals.every((p) => p.kind === 'user')
const canKey = (can: Can) => JSON.stringify(Object.keys(can).sort().map((pattern) => {
  const at = can[pattern]!
  return [pattern, at === 'all' ? at : [...new Set(at)].sort()]
}))

export async function applyGrants(handle: Board, registry: Registry, { kind, party }: GrantOptions)
  : Promise<{ created: number; updated: number; revoked: number }> {
  const desired = desiredGrants(registry, kind, party)
  const counts = { created: 0, updated: 0, revoked: 0 }
  try {
    const grants = await handle.grants()
    const users = grants.filter(onlyUsers)
    const kept = new Set<string>()
    for (const grant of desired) {
      const key = canKey(grant.can)
      const current = users.find((g) => !kept.has(g.id) && canKey(g.can) === key)
      if (!current) {
        await handle.createGrant(grant)
        counts.created++
        continue
      }
      kept.add(current.id)
      const existing = current.principals.filter((p) => p.kind === 'user')
      const add = grant.principals.filter((p) => !existing.some((q) => q.userId === p.userId))
      const remove = existing.filter((p) => !grant.principals.some((q) => q.userId === p.userId))
        .map(({ userId }): User => ({ kind: 'user', userId }))
      if (add.length || remove.length) {
        await handle.updateGrant(current.id, { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) })
        counts.updated++
      }
    }
    const desiredByCan = new Map(desired.map((grant) => [canKey(grant.can), grant.principals]))
    for (const grant of grants) {
      if (kept.has(grant.id)) continue
      const wanted = onlyUsers(grant) ? undefined : desiredByCan.get(canKey(grant.can))
      const givesAccess = Object.values(grant.can).some((at) => at.length > 0)
      const remove: PrincipalInput[] = []
      for (const principal of grant.principals) {
        if (principal.kind === 'user' && !wanted?.some((p) => p.userId === principal.userId)) {
          remove.push({ kind: 'user', userId: principal.userId })
        } else if (givesAccess && isBroad(principal)) {
          remove.push(principal)
        }
      }
      if (remove.length === grant.principals.length) {
        if ((await handle.revokeGrant(grant.id)).revoked) counts.revoked++
      } else if (remove.length) {
        await handle.updateGrant(grant.id, { remove })
        counts.updated++
      }
    }
    const audit = await auditGrants(handle, registry, { kind, party })
    if (!audit.ok) throw new Error(`cannot apply grants: ${audit.violations.join('; ')}`)
    return counts
  } catch (error) {
    if (error instanceof BoardError && error.status === 409 && error.code === 'grant_lockout') {
      throw new Error('cannot apply grants: the operator must be a registry jockey')
    }
    throw error
  }
}

function covers(ceiling: string, pattern: string): boolean {
  return ceiling === '*' || ceiling === pattern ||
    (ceiling.endsWith('/') && (pattern.startsWith(ceiling) || pattern === ceiling.slice(0, -1)))
}

function mergeCan(target: Map<string, Set<string>>, can: Can): void {
  for (const [pattern, at] of Object.entries(can)) {
    const permissions = target.get(pattern) ?? new Set<string>()
    for (const permission of at === 'all' ? [at] : at) permissions.add(permission)
    target.set(pattern, permissions)
  }
}

export async function auditGrants(handle: Board, registry: Registry, { kind, party }: GrantOptions)
  : Promise<{ ok: boolean; violations: string[] }> {
  const ceilings = new Map<string, Map<string, Set<string>>>()
  for (const { members } of registry.parties) {
    for (const { email } of members) ceilings.set(principalOf(email).userId, new Map())
  }
  for (const { principals, can } of desiredGrants(registry, kind, party)) {
    for (const { userId } of principals) {
      const ceiling = ceilings.get(userId) ?? new Map<string, Set<string>>()
      mergeCan(ceiling, can)
      ceilings.set(userId, ceiling)
    }
  }
  const actual = new Map<string, Map<string, Set<string>>>()
  const violations = new Set<string>()
  for (const { principals, can } of await handle.grants()) {
    for (const principal of principals) {
      if (principal.kind === 'user') {
        const permissions = actual.get(principal.userId) ?? new Map<string, Set<string>>()
        mergeCan(permissions, can)
        actual.set(principal.userId, permissions)
      } else if (isBroad(principal)) {
        for (const [pattern, at] of Object.entries(can)) {
          if (at.length) violations.add(`${principal.kind} grants access at ${pattern}`)
        }
      }
    }
  }
  // Compare what the stored grants give, even if a more specific grant masks it today.
  for (const [userId, can] of actual) {
    const ceiling = ceilings.get(userId)
    for (const [pattern, permissions] of can) {
      const allowed = new Set<string>()
      for (const [at, grants] of ceiling ?? []) {
        if (covers(at, pattern)) for (const permission of grants) allowed.add(permission)
      }
      if (!ceiling || (!allowed.has('all') && [...permissions].some((permission) => !allowed.has(permission)))) {
        violations.add(`${userId} exceeds registry membership at ${pattern}`)
      }
    }
  }
  return { ok: violations.size === 0, violations: [...violations] }
}
