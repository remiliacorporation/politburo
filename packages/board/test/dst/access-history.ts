import { AsyncLocalStorage } from 'node:async_hooks'
import { accessContract, ACCESS_SESSION, boardContract, schedulesContract, SCHEDULES_SESSION } from '../../src/contract/contract.ts'
import { BOARD_SESSION } from '../../src/contract/events.ts'
import type { BlobStore } from '../../src/server/blob.ts'
import { writerFor } from '../../src/store/single-writer.ts'
import type { BoardStore } from '../../src/store/types.ts'
import type { Sim } from './sim.ts'

const sessions = new Set([
  `${boardContract.name}\u001f${BOARD_SESSION}`,
  `${accessContract.name}\u001f${ACCESS_SESSION}`,
  `${schedulesContract.name}\u001f${SCHEDULES_SESSION}`,
])

type Landed = { op: number; type: string; principal?: string; grant?: string; paused?: boolean }
type Outcome = { op: number; name: string; status: number; event: string }
type Payload = { id?: number; by?: { principal?: string }; as?: { author?: { principal?: string } }; syncedBy?: string; paused?: boolean }

/** Merge acknowledged inserts in memory-log order, not request completion order. */
export function recordAccess(store: BoardStore, blob: BlobStore, sim: Sim, uploader: string) {
  const history: Landed[] = []
  const writer = writerFor(store.log)
  const observed = new AsyncLocalStorage<boolean>()
  const { run, guardAppend } = writer
  writer.run = async (write) => {
    await sim.gate('writer entry')
    sim.block()
    return run((now) => {
      sim.unblock()
      return write(now)
    })
  }
  writer.guardAppend = async (append, access) => {
    if (!observed.getStore()) return guardAppend(append, access)
    // A conditional append can have yielded its turn at the transport gate.
    sim.block()
    try {
      return await guardAppend(() => {
        sim.unblock()
        return append()
      }, access)
    } finally { sim.unblock() }
  }

  const head = new Map<string, number>()
  const append = store.log.append.bind(store.log)
  store.log.append = async (session, events, options) => {
    // Watch delivery is detached bookkeeping, not an insert by the request.
    if (!sessions.has(session)) return observed.run(false, () => append(session, events, options))
    const op = sim.op
    if (op !== undefined) await sim.gate(`append:${events.map(({ type }) => type).join('+')}`)
    const result = await observed.run(op !== undefined, () => append(session, events, options))
    const fresh = result.events.filter(({ index }) => index > (head.get(session) ?? 0))
    if (fresh.length) head.set(session, fresh.at(-1)!.index)
    if (op !== undefined && fresh.length) {
      sim.trace.push(`${op} landed:${fresh.map(({ type }) => type).join('+')}`)
      for (const { type, payload } of fresh) {
        const { id, by, as, syncedBy, paused } = payload as Payload
        const principal = by?.principal ?? as?.author?.principal ?? syncedBy
        history.push({ op, type, ...(principal === undefined ? {} : { principal }),
          ...(type === 'grant.deleted' ? { grant: `g${id}` } : {}), ...(paused === undefined ? {} : { paused }) })
      }
    }
    return result
  }

  const put = blob.put.bind(blob)
  blob.put = async (key, data, type) => {
    // Uploads have no A2 row. Observe actual persistence, including partial uploads.
    const op = sim.op
    const event = key.endsWith('.json') ? 'attachment.metadata' : 'attachment.bytes'
    if (op !== undefined) await sim.gate(`put:${event}`)
    await put(key, data, type)
    if (op !== undefined) {
      sim.trace.push(`${op} landed:${event}`)
      history.push({ op, type: event, principal: uploader })
    }
  }
  return history
}

/** The caller keeps read access, but has no alternative write grant or regrant. */
export function checkAccess(history: readonly Landed[], outcomes: readonly Outcome[], grant: string, caller: string) {
  const violations: string[] = []
  const writes = new Map(outcomes.map((outcome) => [outcome.op, outcome]))
  let revoked = false
  let paused = false
  for (const { op, type, principal, grant: deleted, paused: control } of history) {
    if (type === 'grant.deleted' && deleted === grant) revoked = true
    if (type === 'work.control') paused = control === true
    const write = writes.get(op)
    const name = write?.name ?? String(op)
    if (revoked && (principal === caller || write !== undefined)) violations.push(`I3 ${name}: ${type} landed after grant.deleted`)
    if (paused && type === 'task.claimed') violations.push(`I3 ${name}: task.claimed landed after pause`)
    if (write?.status === 403 || write?.status === 409) violations.push(`I3 ${name}: ${type} landed despite ${write.status}`)
  }
  if (!revoked || !paused) violations.push('fixture did not land revoke and pause')
  for (const { op, name, status, event } of outcomes) {
    if (status >= 200 && status < 300 && !history.some((row) => row.op === op && row.type === event && row.principal === caller))
      violations.push(`I3 ${name}: ${status} without an attributed ${event}`)
  }
  return violations
}
