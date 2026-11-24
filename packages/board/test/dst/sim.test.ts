import { expect, it } from 'vitest'
import { Sim } from './sim.ts'

it('reports a stall before an operation failure when an actor is still running', async () => {
  const sim = new Sim(0, { settleMs: 20 })
  const started = Promise.withResolvers<void>()
  const operationError = new Error('fixture operation failed')
  await expect(sim.run([
    { name: 'fail', run: async () => {
      // Let the other actor start before throwing, without stalling the driver here.
      sim.block()
      await started.promise
      sim.unblock()
      throw operationError
    } },
    { name: 'hang', run: () => {
      started.resolve()
      return new Promise<never>(() => {})
    } },
  ])).rejects.toMatchObject({ message: expect.stringContaining('stalled'), cause: operationError })
})

it('reports an operation failure when no actor is still running', async () => {
  const sim = new Sim(0, { settleMs: 20 })
  const operationError = new Error('fixture operation failed')
  await expect(sim.run([
    { name: 'fail', run: async () => { throw operationError } },
  ])).rejects.toMatchObject({ message: expect.stringContaining('operation failed'), cause: operationError })
})
