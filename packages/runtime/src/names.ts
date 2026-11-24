/**
 * The one name pool: Soviet industry nouns in allocation order. Use it for any name the product
 * needs (spawners, agents, workers, boards, lanes, demo data, codenames).
 */
export const namePool = Object.freeze([
  // Workplaces
  'ZAVOD', // factory
  'FABRIKA', // mill
  'KOMBINAT', // industrial combine
  'KOLKHOZ', // collective farm
  'SOVKHOZ', // state farm
  'ARTEL', // workers' cooperative
  'SHAKHTA', // mine
  'TSEKH', // workshop
  'DOMNA', // blast furnace
  'KOTLOVAN', // foundation pit
  // Bosses and roles
  'PRORAB', // site foreman
  'BRIGADIR', // brigade leader
  'MASTER', // shop foreman
  'NARKOM', // people's commissar
  'UDARNIK', // shock worker
  'TREST', // industrial trust
  'GLAVK', // chief directorate
  // Planning
  'GOSPLAN', // state planning committee
  'NORMA', // production quota
  'SMENA', // work shift
  'OTDEL', // department
  // Tools and machines
  'MOLOT', // hammer
  'SERP', // sickle
  'TRAKTOR', // tractor
  'TURBINA', // turbine
  'KRAN', // crane
  'STAL', // steel
  'GUDOK', // factory whistle
  // Famous plants
  'MAGNITKA', // Magnitogorsk steelworks
  'URALMASH', // Ural machine works
  'ZIL', // Likhachov automobile plant
  'GAZ', // Gorky automobile plant
  'KAMAZ', // Kama automobile plant
] as const)

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u

/** Pick the first pool name not in use. Pass the names of everything alive that holds one. */
export function pickName(inUse: Iterable<string>): string {
  const used = new Set<string>()
  for (const name of inUse) {
    if (typeof name !== 'string') throw new TypeError('each in-use name must be a string')
    if (CONTROL_OR_FORMAT.test(name)) throw new RangeError('in-use names must not contain control or format characters')
    used.add(name)
  }
  for (const name of namePool) {
    if (!used.has(name)) return name
  }
  throw new Error(`name pool is exhausted (${namePool.length} names)`)
}

/** A spawner's title: `<TAG> <NAME>`, with the name from the pool. */
export function spawnerTitle(tag: string, name: string): string {
  if (typeof tag !== 'string') throw new TypeError('spawner tag must be a string')
  if (CONTROL_OR_FORMAT.test(tag)) throw new RangeError('spawner tag must not contain control or format characters')
  if (!tag || /[\s\p{White_Space}]/u.test(tag)) {
    throw new RangeError('spawner tag must be nonempty and contain no whitespace')
  }
  if (!namePool.some((candidate) => candidate === name)) {
    throw new RangeError('spawner name must be in the pool')
  }
  return `${tag} ${name}`
}
