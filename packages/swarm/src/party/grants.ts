import { BoardError, type Board, type GrantCan, type GrantView, type PrincipalInput } from '@vercel/board'
import { grantAccess, PERMISSIONS, type Caller, type DecidingGrant } from '@vercel/board/access'
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

function isBroad(principal: { kind: string }) {
  return principal.kind === 'all-users' || principal.kind === 'all-projects' ||
    principal.kind === 'all-apps' || principal.kind === 'everyone'
}

// An empty pattern beats a broader allow. Dropping it opens that channel for whoever the broader pattern still names.
function carriedDenies(can: Can): GrantCan | null {
  const denies: Record<string, 'none'> = {}
  let allows = false
  for (const [pattern, at] of Object.entries(can)) {
    if (at !== 'all' && at.length === 0) denies[pattern] = 'none'
    else allows = true
  }
  if (!allows) return null
  const specific: Record<string, 'none'> = {}
  for (const pattern of Object.keys(denies)) {
    if (Object.keys(can).some((other) => other !== pattern && covers(other, pattern))) specific[pattern] = 'none'
  }
  return Object.keys(specific).length > 0 ? specific : null
}

function broadInput(principal: GrantView['principals'][number]): PrincipalInput {
  if (principal.kind === 'all-projects') return { kind: 'all-projects', environments: [...principal.environments] }
  if (principal.kind === 'all-users') return { kind: 'all-users' }
  if (principal.kind === 'all-apps') return { kind: 'all-apps' }
  return { kind: 'everyone' }
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
    // Shrink a grant that still carries a deny before revoking anything else: the operator's
    // manage at that channel may itself be a grant this pass is about to take away.
    const spare = grants.filter((grant) => !kept.has(grant.id))
    spare.sort((a, b) => Number(carriedDenies(b.can) !== null && b.principals.some(isBroad)) - Number(carriedDenies(a.can) !== null && a.principals.some(isBroad)))
    for (const grant of spare) {
      const wanted = onlyUsers(grant) ? undefined : desiredByCan.get(canKey(grant.can))
      const givesAccess = Object.values(grant.can).some((at) => at.length > 0)
      const denies = carriedDenies(grant.can)
      const remove: PrincipalInput[] = []
      for (const principal of grant.principals) {
        if (principal.kind === 'user' && !wanted?.some((p) => p.userId === principal.userId)) {
          remove.push({ kind: 'user', userId: principal.userId })
        } else if (givesAccess && isBroad(principal)) {
          remove.push(broadInput(principal))
        }
      }
      const droppingBroad = remove.some(isBroad)
      if (denies && droppingBroad && remove.length === grant.principals.length) {
        await handle.updateGrant(grant.id, { can: denies })
        counts.updated++
        continue
      }
      if (denies && droppingBroad) {
        await handle.createGrant({ principals: grant.principals.filter(isBroad).map(broadInput), can: denies })
        counts.created++
      }
      if (remove.length === grant.principals.length) {
        if ((await revokeGrant(handle, grant)).revoked) counts.revoked++
      } else if (remove.length) {
        await handle.updateGrant(grant.id, { remove })
        counts.updated++
      }
    }
    const audit = await auditGrants(handle, registry, { kind, party }, grants)
    if (!audit.ok) throw new Error(`cannot apply grants: ${audit.violations.join('; ')}`)
    return counts
  } catch (error) {
    if (error instanceof BoardError && error.status === 409 && error.code === 'grant_lockout') {
      throw new Error('cannot apply grants: the operator must be a registry jockey')
    }
    throw error
  }
}

// Revoking a channel grant can be the last manage there once a deny stays behind. Say so, and
// go ahead, unless the grant is what manages every channel: that refusal is the operator's to keep.
async function revokeGrant(handle: Board, grant: GrantView) {
  try {
    return await handle.revokeGrant(grant.id)
  } catch (error) {
    const at = grant.can['*']
    const managesAll = at === 'all' || (Array.isArray(at) && at.includes('manage'))
    if (!managesAll && error instanceof BoardError && error.status === 409 && error.code === 'grant_lockout') {
      return handle.revokeGrant(grant.id, { lockMeOut: true })
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

export async function auditGrants(handle: Board, registry: Registry, { kind, party }: GrantOptions, before?: readonly GrantView[])
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
  const current = await handle.grants()
  for (const { principals, can } of current) {
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
  // A dropped deny is wider access even when every remaining user is inside the registry ceiling.
  if (before && violations.size === 0) for (const entry of widened(before, current, registry)) violations.add(entry)
  return { ok: violations.size === 0, violations: [...violations] }
}

function deciding(grants: readonly GrantView[]): DecidingGrant[] {
  return grants.map((grant) => ({
    can: grant.can,
    principals: grant.principals.map((principal): DecidingGrant['principals'][number] => {
      switch (principal.kind) {
        case 'user':
          return { kind: 'user', userId: principal.userId }
        case 'project':
          return { kind: 'project', projectId: principal.projectId, environments: principal.environments, ...(principal.teamId ? { teamId: principal.teamId } : {}) }
        case 'all-projects':
          return { kind: 'all-projects', environments: principal.environments }
        case 'github':
          return {
            kind: 'github', repository: principal.repository,
            ...(principal.repositoryId ? { repositoryId: principal.repositoryId } : {}),
            ...(principal.workflow !== undefined ? { workflow: principal.workflow } : {}),
            ...(principal.branch !== undefined ? { branch: principal.branch } : {}),
            ...(principal.event !== undefined ? { event: principal.event } : {}),
          }
        case 'app':
          return { kind: 'app', clientId: principal.clientId }
        case 'oidc':
          return { kind: 'oidc', issuer: principal.issuer, claims: principal.claims }
        case 'invitee':
          return { kind: 'invitee', id: principal.id }
        case 'all-users':
        case 'all-apps':
        case 'everyone':
          return { kind: principal.kind }
        default: {
          const unexpected: never = principal
          return unexpected
        }
      }
    }),
  }))
}

function watchChannels(grants: readonly GrantView[]): string[] {
  const channels = new Set<string>()
  for (const grant of grants) {
    for (const pattern of Object.keys(grant.can)) {
      if (pattern === '*') continue
      const path = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
      channels.add(path)
      if (pattern.endsWith('/')) channels.add(`${path}/x`)
    }
  }
  return [...channels]
}

type Probe = { who: string; caller: Caller; member?: boolean }

function probes(before: readonly GrantView[], after: readonly GrantView[], registry: Registry): Probe[] {
  const users = new Set<string>()
  for (const email of [...registry.jockeys, ...registry.parties.flatMap((party) => party.members.map((member) => member.email))]) {
    users.add(principalOf(email).userId)
  }
  const projects = new Map<string, { projectId: string; environment: string }>()
  for (const grant of [...before, ...after]) {
    for (const principal of grant.principals) {
      if (principal.kind === 'user') users.add(principal.userId)
      if (principal.kind === 'project') {
        for (const environment of principal.environments) projects.set(`${principal.projectId}\0${environment}`, { projectId: principal.projectId, environment })
      }
    }
  }
  return [
    ...[...users].map((userId): Probe => ({ who: userId, caller: { kind: 'user', userId }, member: true })),
    ...[...projects.values()].map(({ projectId, environment }): Probe => ({
      who: `project ${projectId}`, caller: { kind: 'project', projectId, environment },
    })),
  ]
}

function held(grants: readonly GrantView[], probe: Probe, channels: readonly string[]): Map<string, Set<string>> {
  const access = grantAccess({ caller: probe.caller, grants: deciding(grants), ...(probe.member ? { member: true } : {}) })?.caller
  const out = new Map<string, Set<string>>()
  const spots = ['*', ...channels]
  for (const spot of spots) out.set(spot, new Set())
  if (!access) return out
  for (const permission of PERMISSIONS) {
    if (access.at(permission, '*')) out.get('*')!.add(permission)
    for (const channel of channels) if (access.can(permission, channel)) out.get(channel)!.add(permission)
  }
  return out
}

function widened(before: readonly GrantView[], after: readonly GrantView[], registry: Registry): string[] {
  const channels = watchChannels([...before, ...after])
  const violations: string[] = []
  for (const probe of probes(before, after, registry)) {
    const earlier = held(before, probe, channels)
    const later = held(after, probe, channels)
    for (const spot of new Set([...earlier.keys(), ...later.keys()])) {
      const had = earlier.get(spot) ?? new Set<string>()
      const has = later.get(spot) ?? new Set<string>()
      // A more specific allow can hide a permission the broader grant still gives. That is not
      // wider: wider is a permission added while every permission already held is still held.
      if ([...had].some((permission) => !has.has(permission))) continue
      for (const permission of [...has].filter((permission) => !had.has(permission)).sort()) {
        violations.push(`${probe.who} gained ${permission} at ${spot}`)
      }
    }
  }
  return violations
}
