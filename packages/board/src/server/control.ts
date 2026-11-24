import type { Contract, EventDefs } from 'experimental-a2'
import { createServer, type A2Store } from 'experimental-a2/server'
import type { Protocol } from '../api/protocol.ts'
import { accessContract, ACCESS_SESSION, inboxContract, INBOXES_SESSION, registryContract, REGISTRY_SESSION, schedulesContract, SCHEDULES_SESSION, schemasContract, SCHEMAS_SESSION, workSettingsContract } from '../contract/contract.ts'
import { workReducer, type WorkState } from '../contract/reducers.ts'
import type { BoardSession } from './a2.ts'
import { writerFor } from '../store/single-writer.ts'
import { HttpError } from './errors.ts'

const CONTROL_AUTHOR = { actor: 'board:control', principal: 'board:control', profile: null }
const headMoved = (error: unknown) => (error as { code?: string } | null)?.code === 'LAST_INDEX_MISMATCH'

/** The boot option is applied only once. After that the A2 log alone decides work control. */
export function createControl(log: A2Store, session: BoardSession, initiallyPaused: boolean) {
  const settings = createServer({ contract: workSettingsContract, store: log }).session('work-settings')
  const first = <D extends EventDefs>(contract: Contract<D>, id: string) =>
    createServer({ contract, store: log }).session(id).history({ lte: 1 })
  let boot: Promise<void> | undefined
  async function chooseInitial(): Promise<boolean> {
    const [found] = await settings.history({ lte: 1 })
    if (found) return found.payload.paused
    // A legacy board can have grants or schedules without ever having posted a message.
    const existing = initiallyPaused && (await Promise.all([
      session.history({ lte: 1 }),
      first(schedulesContract, SCHEDULES_SESSION),
      first(accessContract, ACCESS_SESSION),
      first(schemasContract, SCHEMAS_SESSION),
      first(registryContract, REGISTRY_SESSION),
      first(inboxContract, INBOXES_SESSION),
    ])).some((events) => events.length > 0)
    try {
      await settings.append.ifLastIndex(0, { type: 'work.initialized', payload: { paused: initiallyPaused && !existing } })
      return initiallyPaused && !existing
    } catch (error) {
      if (!headMoved(error)) throw error
      return chooseInitial()
    }
  }
  async function initialize(): Promise<void> {
    if (!await chooseInitial() || (await session.history({ lte: 1 })).length > 0) return
    // The decision above survives a restart between choosing it and writing the initial state.
    await session.append.ifLastIndex(0, {
      type: 'work.control',
      payload: { paused: true, pauseEpoch: 0, reason: 'initial configuration', by: CONTROL_AUTHOR },
    }).catch((error: unknown) => { if (!headMoved(error)) throw error })
  }
  const ready = () => (boot ??= writerFor(log).run(initialize).catch((error: unknown) => {
    boot = undefined
    throw error
  }))
  return {
    ready,
    async at(through: number | 'latest' = 'latest') {
      await ready()
      const { state, index } = await session.state(workReducer, { through })
      return { status: state, index }
    },
  }
}

export const publicStatus = ({ paused, pauseEpoch }: WorkState): Protocol['status']['output'] => ({ paused, pauseEpoch })

/** Old requests cannot acquire work after even a very short pause followed by a resume. */
export function workOpen(status: WorkState, epoch?: number): number {
  if (status.paused || (epoch !== undefined && status.pauseEpoch !== epoch))
    throw new HttpError(409, 'board_paused', status.paused ? 'the board is paused' : 'the board paused while work was pending; start a new request')
  return status.pauseEpoch
}
