import { expect } from 'vitest'

function integer(name: string, value: string, min: number) {
  const n = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > 0xffff_ffff)
    throw new Error(`${name} must be an integer from ${min} to 4294967295`)
  return n
}

export function seeds(defaultCount = 100) {
  const { DST_SEED, DST_SEEDS, DST_SEED_START } = process.env
  if (DST_SEED !== undefined) return [integer('DST_SEED', DST_SEED, 0)]
  const start = integer('DST_SEED_START', DST_SEED_START ?? '0', 0)
  return Array.from({ length: integer('DST_SEEDS', DST_SEEDS ?? String(defaultCount), 1) }, (_, seed) => start + seed)
}

export type Run = { violations: string[]; trace: string[] }

export async function checkSeeds(run: (seed: number) => Promise<Run>, defaultCount?: number) {
  const failures: { seed: number; violations: string[]; trace: string[] }[] = []
  for (const seed of seeds(defaultCount)) {
    const { violations, trace } = await run(seed)
    if (violations.length) failures.push({ seed, violations, trace })
  }
  const lines = failures.map(({ seed, violations }) => `DST_SEED=${seed}: ${violations.join('; ')}`)
  const first = failures[0]
  if (first) lines.push(`Trace for DST_SEED=${first.seed}:`, ...first.trace)
  expect(failures.length, lines.join('\n')).toBe(0)
}
