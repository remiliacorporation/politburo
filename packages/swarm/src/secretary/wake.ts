import { createHash } from 'node:crypto'
import type { CasePacket } from './packet.ts'
import type { Forward } from './route.ts'

export interface Waker {
  // Must be idempotent by wakeId (packet.packetId): restart can retry the same ID before a receipt is recorded.
  wake(packet: CasePacket): Promise<{ delivered: boolean; detail: string }>
}

export const shadowWaker: Waker = {
  async wake() { return { delivered: false, detail: 'shadow: not sent' } },
}

export function wakeId(tag: string, lane: Forward['lane'], ids: readonly string[], generation: string | number): string {
  return createHash('sha256').update(JSON.stringify([tag, lane, [...ids].sort(), generation])).digest('hex')
}
