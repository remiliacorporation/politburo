import type { PartyConfig } from '../config/load.ts'

function usedNames(inUse: Iterable<string>): Set<string> {
  const used = new Set<string>()
  for (const name of inUse) {
    if (typeof name !== 'string') throw new TypeError('each in-use name must be a string')
    if (/[\p{Cc}\p{Cf}]/u.test(name)) {
      throw new RangeError('in-use names must not contain control or format characters')
    }
    used.add(name)
  }
  return used
}

function firstFree(pool: readonly string[], inUse: Iterable<string>, kind: string): string {
  const used = usedNames(inUse)
  const name = pool.find((name) => !used.has(name))
  if (name === undefined) throw new Error(`${kind} name pool is exhausted`)
  return name
}

export function allocateSpawnerName(config: PartyConfig, inUse: Iterable<string>): string {
  return firstFree(config.names.spawners, inUse, 'spawner')
}

export function allocateSecretaryName(config: PartyConfig, inUse: Iterable<string>): string {
  return firstFree(config.names.secretaries, inUse, 'secretary')
}

function firstFreeNumbered(pool: readonly string[], inUse: Iterable<string>): string {
  const used = usedNames(inUse)
  // A numbered live name still occupies its species/item after the bare name retires.
  for (const base of pool) {
    if (used.has(base)) continue
    const occupied = [...used].some((name) => name.startsWith(base) && !pool.includes(name)
      && /^(?:[2-9]|[1-9][0-9]+)$/.test(name.slice(base.length)))
    if (!occupied) return base
  }
  const base = pool[0]!
  let number = 2
  while (used.has(`${base}${number}`)) number++
  return `${base}${number}`
}

export function allocateMobSpecies(config: PartyConfig, job: string, inUse: Iterable<string>): string {
  const species = config.names.mob_species
  if (job === 'boss') return firstFreeNumbered(species.boss, inUse)
  for (const kind of ['passive', 'neutral', 'hostile']) {
    if (Object.hasOwn(species[kind], job)) return firstFreeNumbered(species[kind][job], inUse)
  }
  throw new Error(`unknown mob job ${job}`)
}

/** Pass the live item names for this mob, without their mob ID prefix. */
export function allocateSpriteItem(config: PartyConfig, job: string, inUse: Iterable<string>): string {
  const items = config.names.sprite_items
  if (!Object.hasOwn(items, job)) throw new Error(`unknown sprite job ${job}`)
  return firstFreeNumbered(items[job], inUse)
}
