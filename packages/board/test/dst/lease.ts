import { existsSync } from 'node:fs'
import type { ClaimedTask } from '../../src/client/client.ts'
import { A2Error } from 'experimental-a2'
import { memory } from '../../src/store/memory.ts'
import { wallTime, writerFor } from '../../src/store/single-writer.ts'
import { personToken } from '../harness.ts'
import { jumpToBoundary, withClock } from './clock.ts'
import { handle, hostBoard, outcome } from './fixture.ts'
import { recordAppends } from './history.ts'
import { checkLeases, leasesIn } from './oracles.ts'
import { Sim } from './sim.ts'

export const hasAppendGuard = existsSync(new URL('../../src/store/single-writer.ts', import.meta.url))
const hasEvidence = existsSync(new URL('../../src/contract/evidence.ts', import.meta.url))
const workEvidence = hasEvidence ? { gates: false, releaseDependencies: true } : undefined
const refusals = ['claim_lost', 'task_claimed', 'task_finished']

export function leaseRace(seed: number, guard: 'product' | 'local' | 'ignore-clock' = 'product') {
  return withClock(async () => {
    const sim = new Sim(seed)
    const store = memory({ clock: { now: () => new Date() } })
    try {
      const writer = writerFor(store.log)
      if (guard !== 'product') writer.guardAppend = (append) => append()
      const run = writer.run
      // The old test-only append guard asks the look to retry with a fresh clock.
      if (guard === 'local') writer.time = wallTime
      writer.run = async (write) => {
        // A parked append may own the queue. Its waiters are not runnable.
        sim.block()
        return run((now) => {
          sim.unblock()
          return write(now)
        })
      }
      const history = recordAppends(store, sim, (facts, history) => {
        if (guard !== 'local' || !facts.some(({ type }) => ['task.renewed', 'task.work_submitted', 'task.completed', 'task.released'].includes(type))) return
        // This fixture has one task. The conditional append still checks the log head independently.
        const [lease] = leasesIn(history)
        // Signal a retry so the request rereads the lease and returns its normal refusal.
        if (!lease || Date.now() >= lease.until) throw new A2Error('LAST_INDEX_MISMATCH', 'lease expired before append')
      })
      const options = { store, ...(workEvidence ? { workEvidence } : {}) }
      const host = hostBoard(options)
      const [worker, successor] = await Promise.all(['u_worker', 'u_successor'].map(async (id) => handle(host, await personToken(id))))
      const { task } = await worker!.tasks.create('work', 'Deliver a patch')
      const claim: ClaimedTask & { submit?: (commit: string, artifact: string) => Promise<unknown> } = await worker!.tasks.claim(task.id, { lease: 30 })
      const submit = workEvidence && claim.submit ? claim.submit.bind(claim) : undefined
      await sim.run([
        { name: 'renew', run: () => outcome(() => claim.renew(60), refusals) },
        { name: submit ? 'submit' : 'complete', run: () => outcome(() => submit ? submit('a'.repeat(40), 'builds/42') : claim.complete(), refusals) },
        { name: 'release', run: () => outcome(() => claim.release(), refusals) },
        { name: 'takeover', run: () => outcome(() => successor!.tasks.claim(task.id), refusals) },
      ], ({ label }, random) => {
        if (label.startsWith('append:')) return jumpToBoundary(history, random)
      })
      return { violations: checkLeases(history), trace: sim.trace, history }
    } finally {
      await store.close()
    }
  })
}
