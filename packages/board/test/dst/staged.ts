import { existsSync } from 'node:fs'
import type { MessageView } from '../../src/api/routes.ts'
import { boardEvents } from '../../src/contract/events.ts'
import { memory } from '../../src/store/memory.ts'
import { handle, hostBoard } from './fixture.ts'
import { recordAppends } from './history.ts'
import type { Sim } from './sim.ts'

type Fence = {
  access<T>(write: () => Promise<T>): Promise<T>
  guarded<T>(read: () => Promise<number>, expected: number, write: () => Promise<T>): Promise<T>
}

export const hasStages = 'task.stage_changed' in boardEvents
export const hasFence = existsSync(new URL('../../src/store/fence.ts', import.meta.url))

export async function stagedBoard(sim: Sim, scopers: string[], run: (host: ReturnType<typeof hostBoard>, history: ReturnType<typeof recordAppends>) => Promise<void>) {
  const store: ReturnType<typeof memory> & { fence?: Fence } = memory({ clock: { now: () => new Date() } })
  try {
    const fence = store.fence
    if (fence) {
      const entering = <T,>(write: () => Promise<T>) => () => {
        sim.unblock()
        return write()
      }
      store.fence = {
        async access(write) {
          sim.block()
          try { return await fence.access(entering(write)) } finally { sim.unblock() }
        },
        async guarded(read, expected, write) {
          // The expected-head read runs inside the acquired lock, even on mismatch.
          await sim.gate('before access fence')
          sim.block()
          try { return await fence.guarded(entering(read), expected, write) } finally { sim.unblock() }
        },
      }
    }
    const history = recordAppends(store, sim)
    const options = { store, workLifecycle: { scopers } }
    await run(hostBoard(options), history)
  } finally {
    await store.close()
  }
}

// These handle methods are only exercised on checkouts with the staged-work contract.
export function stagedHandle(host: ReturnType<typeof hostBoard>, token: string) {
  const client = handle(host, token)
  const tasks = client.tasks as typeof client.tasks & {
    scope(id: string, reason: string, options?: { ifVersion: MessageView['version'] }): Promise<MessageView>
    stage(id: string, to: string, reason: string, options?: { ifVersion: MessageView['version'] }): Promise<MessageView>
    reopen(id: string, reason: string, options?: { ifVersion: MessageView['version'] }): Promise<MessageView>
  }
  return { client, tasks }
}
