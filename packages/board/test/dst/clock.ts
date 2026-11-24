import { vi } from 'vitest'
import { leasesIn, type Batch } from './oracles.ts'

export const START = Date.UTC(2026, 0, 1)

/** Move Date only: board checks and the memory log see the same wall clock. */
export async function withClock<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  try {
    return await run()
  } finally {
    vi.useRealTimers()
  }
}

const offsets = [-1, 0, 1, 1000]

export function jumpToBoundary(history: readonly Batch[], random: () => number) {
  if (random() >= 0.6) return
  const live = leasesIn(history).filter(({ until }) => Date.now() < until)
  if (!live.length) return
  const { until } = live[Math.floor(random() * live.length)]!
  const target = until + offsets[Math.floor(random() * offsets.length)]!
  if (target < Date.now()) return
  vi.setSystemTime(target)
  return `clock=${target}`
}
