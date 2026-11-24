import type { BoardStore } from '../../src/store/types.ts'
import type { Batch, Fact } from './oracles.ts'
import type { Sim } from './sim.ts'

type Payload = {
  id?: string | number; by?: { principal?: string }; epoch?: number; round?: number; until?: string
  needs?: (string | number)[]; waiting?: boolean; work?: string; to?: string
}

/** Keep a normalized projection: no claim proofs, credentials, or random A2 event IDs. */
function fact(type: string, payload: unknown): Fact {
  const { id, by, epoch, round, until, needs, waiting, work, to } = payload as Payload
  return {
    type,
    // Access log grant IDs are numeric; the public grant handle spells them g<number>.
    ...(id === undefined ? {} : { id: type === 'grant.deleted' ? `g${id}` : String(id) }),
    ...(by?.principal === undefined ? {} : { principal: by.principal }),
    ...(epoch === undefined ? {} : { epoch }),
    ...(round === undefined ? {} : { round }),
    ...(until === undefined ? {} : { until: Date.parse(until) }),
    ...(needs === undefined ? {} : { needs: needs.map(String) }),
    ...(waiting === undefined ? {} : { waiting }),
    ...(work === undefined ? {} : { work }),
    ...(to === undefined ? {} : { to }),
  }
}

const relevant = (type: string) => type.startsWith('task.') || type === 'grant.deleted'

export function recordAppends(store: BoardStore, sim: Sim, beforeAppend?: (facts: readonly Fact[], history: readonly Batch[]) => void) {
  const history: Batch[] = []
  const head = new Map<string, number>()
  const append = store.log.append.bind(store.log)
  store.log.append = async (session, events, options) => {
    const planned = events.filter(({ type }) => relevant(type))
    if (planned.length) {
      await sim.gate(`append:${planned.map(({ type }) => type).join('+')}`)
      beforeAppend?.(planned.map(({ type, payload }) => fact(type, payload)), history)
    }
    const result = await append(session, events, options)
    // Memory appends insert synchronously. Their acknowledgments arrive in insert order,
    // even across sessions. Ignore replayed rows, not just failed conditional appends.
    const fresh = result.events.filter(({ index }) => index > (head.get(session) ?? 0))
    if (fresh.length) head.set(session, fresh.at(-1)!.index)
    const landed = fresh.filter(({ type }) => relevant(type))
    if (landed.length) history.push({ at: landed[0]!.createdAt.getTime(), facts: landed.map(({ type, payload }) => fact(type, payload)) })
    return result
  }
  return history
}
