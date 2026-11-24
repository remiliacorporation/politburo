import { it } from 'vitest'
import { leaseRace } from './lease.ts'
import { checkSeeds } from './seeds.ts'

it('E1: lease writes land only before the deadline and under the current epoch', async () => {
  await checkSeeds(leaseRace, 200)
}, 360_000)
