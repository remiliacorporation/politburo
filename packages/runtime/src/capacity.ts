import { mkdir, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kinds = ['worker', 'build', 'qa', 'review'] as const
export type CapacityKind = typeof kinds[number]
export type CapacityRequest = Readonly<{ kind: CapacityKind; heavy?: boolean }>

export interface Reservation {
  release(): void | Promise<void>
}

export interface CapacityPolicy {
  /** Return null without waiting for capacity if either limit is full. */
  tryReserve(request: CapacityRequest): Reservation | null | Promise<Reservation | null>
}

export type CapacityOptions = Readonly<{
  limits: Readonly<Record<CapacityKind, number>>
  /** All processes on the machine use the same local directory and slot count. */
  heavy?: Readonly<{ directory: string; slots: number }>
}>

function checkedLimit(limit: number, name: string) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`invalid ${name} limit`)
  return limit
}

/** Per-instance kind limits and an optional cross-process pool for heavy runs. */
export function capacity({ limits, heavy }: CapacityOptions): CapacityPolicy {
  const caps = { ...limits }
  for (const kind of kinds) checkedLimit(caps[kind], kind)
  const directory = heavy && resolve(heavy.directory)
  const slots = heavy ? checkedLimit(heavy.slots, 'heavy slot') : 0
  const taken = { worker: 0, build: 0, qa: 0, review: 0 }

  async function takeSlot() {
    if (directory === undefined || slots === 0) return null
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (let index = 0; index < slots; index++) {
      const slot = join(directory, `slot-${index}`)
      try {
        await mkdir(slot)
        return slot
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    return null
  }

  return {
    async tryReserve({ kind, heavy: needsSlot }) {
      if (taken[kind] >= caps[kind]) return null
      taken[kind]++
      let slot: string | null = null
      try {
        if (needsSlot && !(slot = await takeSlot())) {
          taken[kind]--
          return null
        }
      } catch (error) {
        taken[kind]--
        throw error
      }
      let released: Promise<void> | undefined
      return {
        release: () => released ??= (async () => {
          try {
            if (slot !== null) await rmdir(slot)
          } finally {
            taken[kind]--
          }
        })(),
      }
    },
  }
}
