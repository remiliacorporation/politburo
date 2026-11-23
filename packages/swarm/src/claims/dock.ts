import type { Board } from '@vercel/board'
import { writeRecord } from './records.ts'
import type { ClaimOptions } from './rule.ts'

// A validator may check retrospectively, but must timestamp when the proof was valid.
export type Validate = (input: { task: string; text: string; party: string; epoch: number; checkedAt: number }) =>
  Promise<{ result: 'valid'; validAt: number } | { result: 'invalid' | 'unverifiable' }>

async function* history(board: Board, filter: { channel: string } | { re: string }) {
  let after = '0'
  for (;;) {
    const page = await board.poll({ ...filter, all: true, after, wait: 0 })
    yield* page.events
    // A page with no matching events can still have scanned part of the log.
    if (page.cursor === after) return
    after = page.cursor
  }
}

export async function dockMisses({ board, channel, party, config, validate, now = Date.now }: ClaimOptions & { validate?: Validate }): Promise<void> {
  const { actor } = await board.me()
  for await (const event of history(board, { channel })) {
    if (event.type !== 'task.expired' || event.payload.reason !== 'hold' || event.message?.channel !== channel) continue
    const { id: task, epoch } = event.payload
    for await (const started of history(board, { re: task })) {
      if (started.type !== 'task.claimed' || started.payload.id !== task || started.payload.epoch !== epoch) continue
      const { by, holdUntil } = started.payload
      if (by.actor !== actor || !holdUntil) break
      const hardEnd = Date.parse(holdUntil)
      const checkedAt = now()
      if (checkedAt < hardEnd) break
      const verdict = await validate?.({ task, text: event.message.text, party, epoch, checkedAt })
      if (verdict?.result === 'valid' && verdict.validAt < hardEnd) break
      await writeRecord(board, 'dock', { v: 1, party, task, epoch }, {
        hardEnd, cooldownUntil: hardEnd + config.reclaim_cooldown_minutes * 60_000, points: config.dock.missed_claim,
      })
      break
    }
  }
}
