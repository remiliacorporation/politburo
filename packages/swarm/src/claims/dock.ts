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

type DockOptions = ClaimOptions & { validate?: Validate }

export function dockMisses(options: DockOptions): Promise<void> {
  return scanMisses(options)
}

export function dockTaskMisses(options: ClaimOptions, task: string): Promise<void> {
  return scanMisses(options, task)
}

async function scanMisses({ board, channel, party, config, validate, now = Date.now }: DockOptions, onlyTask?: string): Promise<void> {
  const { actor } = await board.me()
  async function dock(task: string, epoch: number, text: string, holdUntil: string) {
    const hardEnd = Date.parse(holdUntil)
    const checkedAt = now()
    if (checkedAt < hardEnd) return
    const verdict = await validate?.({ task, text, party, epoch, checkedAt })
    if (verdict?.result === 'valid' && verdict.validAt < hardEnd) return
    await writeRecord(board, 'dock', { v: 1, party, task, epoch }, {
      hardEnd, cooldownUntil: hardEnd + config.reclaim_cooldown_minutes * 60_000, points: config.dock.missed_claim,
    })
  }

  // The rule runs before the claiming append, so expiry may not be in the log yet.
  let pendingEpoch: number | undefined
  if (onlyTask !== undefined) {
    const checkedAt = now()
    const { message } = await board.thread(onlyTask, { limit: 1 })
    const task = message.task
    const claim = task?.claim
    if (task?.state === 'claimed' && claim?.actor === actor && claim.holdUntil === claim.until && Date.parse(claim.until) <= checkedAt) {
      await dock(onlyTask, task.epoch, message.text, claim.until)
      pendingEpoch = task.epoch
    }
  }

  const failures: Error[] = []
  for await (const event of history(board, onlyTask === undefined ? { channel } : { re: onlyTask })) {
    if (event.type !== 'task.expired' || event.payload.reason !== 'hold' || event.message?.channel !== channel) continue
    const { id: task, epoch } = event.payload
    if (onlyTask !== undefined && (task !== onlyTask || epoch === pendingEpoch)) continue
    try {
      for await (const started of history(board, { re: task })) {
        if (started.type !== 'task.claimed' || started.payload.id !== task || started.payload.epoch !== epoch) continue
        const { by, holdUntil } = started.payload
        if (by.actor === actor && holdUntil) await dock(task, epoch, event.message.text, holdUntil)
        break
      }
    } catch (cause) {
      failures.push(new Error(`task ${task}, epoch ${epoch}`, { cause }))
    }
  }
  if (failures.length) throw new AggregateError(failures, `could not dock ${party}: ${failures.map(({ message }) => message).join('; ')}`)
}
