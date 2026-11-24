import { expect, it } from 'vitest'
import { personToken } from '../harness.ts'
import { withClock } from './clock.ts'
import { outcome } from './fixture.ts'
import { checkPrerequisites } from './oracles.ts'
import { checkSeeds, type Run } from './seeds.ts'
import { Sim } from './sim.ts'
import { hasFence, hasStages, stagedBoard, stagedHandle } from './staged.ts'

const SCOPER = 'vercel:user:u_scoper'

async function reopenRace(seed: number): Promise<Run> {
  return withClock(async () => {
    const sim = new Sim(seed)
    const violations: string[] = []
    await stagedBoard(sim, [SCOPER], async (host, history) => {
      const { tasks: scoper } = stagedHandle(host, await personToken('u_scoper'))
      const { tasks: worker } = stagedHandle(host, await personToken('u_worker'))
      const { task: need } = await worker.create('work', 'Prerequisite')
      const { task: dependent } = await worker.create('work', { text: 'Dependent', needs: [need.id] })
      await scoper.scope(dependent.id, 'Scope the dependent')

      // Finish macro: a legacy complete alone doesn't reach done for staged work.
      await scoper.scope(need.id, 'Scope the prerequisite')
      await (await worker.claim(need.id)).complete()
      let done = need
      for (const stage of ['review', 'qa', 'approved', 'done']) done = await scoper.stage(need.id, stage, 'Advance the prerequisite')
      expect(done.task?.state).toBe('completed')
      expect((await worker.list({ channel: 'work', state: 'ready' })).tasks.map(({ message }) => message.id)).toContain(dependent.id)

      await sim.run([
        { name: 'reopen', run: async () => {
          const reopened = await scoper.reopen(need.id, 'Requirements changed', { ifVersion: done.version })
          expect(reopened.task?.state).not.toBe('completed')
          return 'ok'
        } },
        { name: 'claim dependent', run: () => outcome(() => worker.claim(dependent.id), ['task_waiting']) },
      ])
      violations.push(...checkPrerequisites(history))
    })
    return { violations, trace: sim.trace }
  })
}

const enabled = hasStages && (hasFence || process.env.DST_EXPECT === 'e3')
const title = 'E3: reopening done work never leaves its dependent ready (I4)'
if (!enabled) {
  it.skip(`${title} (needs PR 21 fd0685f staged reopen)`, () => {})
} else {
  it(title, async () => { await checkSeeds(reopenRace) }, 55_000)
}
