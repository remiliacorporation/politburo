import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Harness, RunRef, Start } from '../src/harness.ts'

export function fixtureStart(wallMs = 6_000, brief = 'hang'): Start {
  return {
    attemptId: randomUUID(), taskId: 'fixture-task', claimEpoch: 1, provider: 'fixture',
    work: {
      repo: 'acme/web', baseSha: '1'.repeat(40), briefRef: 'test-brief',
      briefSha256: createHash('sha256').update(brief).digest('hex'),
      allowedPaths: [], limits: { wallMs, maxCostMicros: 0 }, requiredCheckIds: [],
    },
  }
}

export async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = performance.now() + 4_000
  do {
    const value = await read()
    if (value !== undefined) return value
    await sleep(10)
  } while (performance.now() < end)
  throw new Error('timed out waiting for fixture')
}

export const terminal = (harness: Harness, run: RunRef) => waitFor(async () => {
  const result = await harness.collect(run)
  return result === 'not_terminal' ? undefined : result
})

export const output = async (harness: Harness, run: RunRef) =>
  (await harness.observe(run, { limit: 100 })).events.map((event) => event.text).join('')
