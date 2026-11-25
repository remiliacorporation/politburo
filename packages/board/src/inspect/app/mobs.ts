import type { MessageView } from '../../api/routes.ts'
import { itemOfSprite, speciesOfMob } from './icons.ts'
import { listedRepos, repoOfTask, reposOf } from './repos.ts'
import { isTask, type State } from './store.ts'
import { ago, firstLine, until } from './words.ts'
import { workPlacement, type SwarmRecords } from './work.ts'

/** Where a board keeps the party config the mob map reads: one JSON message, the newest wins. */
export const PARTY_CONFIG_CHANNEL = 'config/party'

export type MobClass = 'passive' | 'neutral' | 'hostile' | 'boss' | 'unknown'

export type SpeciesPools = {
  passive: readonly string[]
  neutral: readonly string[]
  hostile: readonly string[]
  boss: readonly string[]
}

/**
 * The default party config's species pools (`names.mob_species`). A `config/party`
 * message replaces them. A species in neither is unknown.
 */
const DEFAULT_POOLS: SpeciesPools = {
  passive: [
    'COW', 'SHEEP', 'MOOSH', 'CHICKEN', 'PIG', 'FOX', 'CAT', 'OCELOT', 'BAT', 'AXOLOTL', 'FROG', 'TURTLE',
    'TADPOLE', 'PUFFER', 'PARROT', 'RABBIT', 'SQUID', 'COD', 'SALMON', 'ALLAY', 'DONKEY', 'MULE', 'CAMEL',
    'HORSE', 'SKORSE', 'ZORSE', 'VILLAGER', 'SNOWMAN',
  ],
  neutral: ['BEE', 'DOLPHIN', 'WOLF', 'POLAR', 'ENDERMAN', 'SPIDER', 'GOAT', 'PIGLIN', 'LLAMA', 'PANDA', 'CAVSPIDR', 'GOLEM', 'PIGMAN'],
  hostile: [
    'CREEPER', 'HOGLIN', 'ZOGLIN', 'BRUTE', 'GUARDIAN', 'SHULKER', 'WITCH', 'SKELETON', 'STRAY', 'WITHSKEL',
    'BLAZE', 'GHAST', 'PHANTOM', 'PILLAGER', 'VINDICTR', 'EVOKER', 'VEX', 'ZOMBIE', 'HUSK', 'DROWNED',
    'ZILLAGER', 'SILVER', 'MITE', 'SLIME', 'MAGMA',
  ],
  boss: ['DRAGON', 'WITHER', 'WARDEN', 'ELDERG'],
}

const EMPTY_POOLS: SpeciesPools = { passive: [], neutral: [], hostile: [], boss: [] }

const CLASSES = ['passive', 'neutral', 'hostile', 'boss'] as const

/** The profile or the last segment of an actor id: `…+21-CAT` and `vercel:user:21-CAT` are `21-CAT`. */
export function actorTail(id: string): string {
  const plus = id.lastIndexOf('+')
  if (plus >= 0) return id.slice(plus + 1)
  const colon = id.lastIndexOf(':')
  return colon >= 0 ? id.slice(colon + 1) : id
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf)
  return []
}

/** The species pools a party-config JSON message holds, or null when it isn't one. */
export function parseSpeciesPools(text: string): SpeciesPools | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const names = (value as { names?: unknown }).names
  const species = names && typeof names === 'object' ? (names as { mob_species?: unknown }).mob_species : undefined
  if (!species || typeof species !== 'object') return null
  const record = species as Record<string, unknown>
  if (!('passive' in record) && !('neutral' in record) && !('hostile' in record) && !('boss' in record)) return null
  const list = (key: string) => [...new Set(stringsOf(record[key]).map((name) => name.trim().toUpperCase()).filter((name) => /^[A-Z][A-Z0-9]*$/.test(name)))]
  return { passive: list('passive'), neutral: list('neutral'), hostile: list('hostile'), boss: list('boss') }
}

/** The newest readable species pools among the messages the page holds, or null when the board has none. */
export function poolsFromMessages(messages: Record<string, MessageView>): SpeciesPools | null {
  let newest: MessageView | null = null
  for (const message of Object.values(messages)) {
    if (message.channel !== PARTY_CONFIG_CHANNEL || message.deleted || message.re !== null) continue
    if (parseSpeciesPools(message.text) === null) continue
    if (!newest || message.createdAt > newest.createdAt || (message.createdAt === newest.createdAt && message.id > newest.id)) newest = message
  }
  return newest ? parseSpeciesPools(newest.text) : null
}

/** A species' class in these pools. Null pools are the default party config. */
export function classOf(species: string, pools: SpeciesPools | null): MobClass {
  const source = pools ?? DEFAULT_POOLS
  for (const name of CLASSES) if (source[name].includes(species)) return name
  return 'unknown'
}

/** Pools that classify every species as unknown, for a config read the board refused. */
export const refusedPools = EMPTY_POOLS

export type MobSprite = { id: string; item: string }

export type MobHold = {
  taskId: string
  title: string
  countdown: string
  pr: string
  stalled: boolean
  reason: string
  party: string | null
  repo: string | null
  until: number
}

export type MobCard = {
  id: string
  species: string
  className: MobClass
  actorId: string
  party: string | null
  repo: string | null
  status: 'running' | 'stalled' | 'idle'
  holds: MobHold[]
  sprites: MobSprite[]
}

export type MobGroup = { party: string; repos: { repo: string; mobs: MobCard[] }[] }

function countdown(iso: string, now: number): string {
  if (Date.parse(iso) <= now) return `expired ${ago(iso, now)} ago`
  const remaining = until(iso, now)
  return `expires ${remaining === 'now' ? 'in 0s' : remaining}`
}

function prOf(labels: Record<string, string>, obs: SwarmRecords['observations'][string] | null): string {
  const labeled = labels['pr.number']
  if (labeled && /^[1-9][0-9]*$/.test(labeled)) return `PR #${labeled}`
  if (obs?.pr) return `PR #${obs.pr.number}`
  return 'no PR'
}

function identityOf(id: string, name?: string | null, handle?: string | null) {
  const candidates = [actorTail(id)]
  if (name && !candidates.includes(name)) candidates.push(name)
  if (handle && !candidates.includes(handle)) candidates.push(handle)
  for (const candidate of candidates) {
    const item = itemOfSprite(candidate)
    if (item) return { kind: 'sprite' as const, mob: candidate.slice(0, candidate.lastIndexOf('.')), sprite: candidate, item }
    const species = speciesOfMob(candidate)
    if (species) return { kind: 'mob' as const, mob: candidate, species }
  }
  return null
}

type Draft = { id: string; species: string; actorId: string; sprites: Map<string, MobSprite>; holds: MobHold[] }

function ensure(drafts: Map<string, Draft>, mob: string, species: string, actorId: string | null) {
  let draft = drafts.get(mob)
  if (!draft) {
    draft = { id: mob, species, actorId: actorId && actorTail(actorId) === mob ? actorId : mob, sprites: new Map(), holds: [] }
    drafts.set(mob, draft)
  }
  if (actorId && actorTail(actorId) === mob) draft.actorId = actorId
  return draft
}

function byLabel(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

/** Every mob the board knows, from its actors and from who holds an open claim, grouped by party then repo. */
export function mobRoster(state: State, now: number, records: SwarmRecords | null, pools: SpeciesPools | null): MobGroup[] {
  const known = new Set(reposOf(state.channels, listedRepos(state.messages)).map((repo) => repo.tag))
  const drafts = new Map<string, Draft>()
  for (const [id, actor] of Object.entries(state.actors)) {
    const who = identityOf(id, actor.name, actor.handle)
    if (!who) continue
    if (who.kind === 'sprite') {
      const species = speciesOfMob(who.mob)
      if (!species) continue
      ensure(drafts, who.mob, species, null).sprites.set(who.sprite, { id: who.sprite, item: who.item })
    } else {
      ensure(drafts, who.mob, who.species, id)
    }
  }
  for (const root of Object.values(state.openTaskRoots)) {
    if (!isTask(root) || root.deleted || !root.task.claim) continue
    const who = identityOf(root.task.claim.actor)
    if (!who) continue
    if (who.kind === 'sprite') {
      const species = speciesOfMob(who.mob)
      if (!species) continue
      ensure(drafts, who.mob, species, null).sprites.set(who.sprite, { id: who.sprite, item: who.item })
      continue
    }
    const draft = ensure(drafts, who.mob, who.species, root.task.claim.actor)
    if (draft.holds.some((hold) => hold.taskId === root.id)) continue
    const id = root.labels['work.id']?.toLowerCase()
    const obs = id && records && Object.hasOwn(records.observations, id) ? records.observations[id]! : null
    const [group, reason] = workPlacement(root, obs, null, now, state)
    draft.holds.push({
      taskId: root.id,
      title: [root.labels['work.id'], firstLine(root.text)].filter(Boolean).join(' '),
      countdown: countdown(root.task.claim.until, now),
      pr: prOf(root.labels, obs),
      stalled: group === 'repair',
      reason,
      party: root.labels.party?.trim() || null,
      repo: repoOfTask(root, known),
      until: Date.parse(root.task.claim.until),
    })
  }
  const cards = [...drafts.values()].map((draft): MobCard => {
    const holds = [...draft.holds].sort((a, b) => Number(b.stalled) - Number(a.stalled) || a.until - b.until)
    const primary = holds[0]
    return {
      id: draft.id,
      species: draft.species,
      className: classOf(draft.species, pools),
      actorId: draft.actorId,
      party: primary?.party ?? null,
      repo: primary?.repo ?? null,
      status: holds.length === 0 ? 'idle' : holds.some((hold) => hold.stalled) ? 'stalled' : 'running',
      holds,
      sprites: [...draft.sprites.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    }
  })
  const grouped = new Map<string | null, Map<string | null, MobCard[]>>()
  for (const card of cards) {
    let repos = grouped.get(card.party)
    if (!repos) grouped.set(card.party, repos = new Map())
    const list = repos.get(card.repo)
    if (list) list.push(card)
    else repos.set(card.repo, [card])
  }
  return [...grouped.keys()].sort(byLabel).map((party) => ({
    party: party ?? 'no party',
    repos: [...grouped.get(party)!.keys()].sort(byLabel).map((repo) => ({
      repo: repo ?? 'no repo',
      mobs: grouped.get(party)!.get(repo)!.sort((a, b) => (a.id < b.id ? -1 : 1)),
    })),
  }))
}
