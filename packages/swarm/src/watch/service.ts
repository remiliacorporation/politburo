import { setTimeout } from 'node:timers/promises'
import { errorMessage, WatchError, type AlertSink, type ShadowAlert } from './alerts.ts'
import { prLog, type PrSource } from './prlog.ts'
import { slowdownDetector, type SlowdownOptions } from './slowdown.ts'
import { shadowStall, type StallOptions, type WatchBoard } from './stall.ts'

export type WatchOptions = StallOptions & SlowdownOptions

type ServiceOptions = WatchOptions & {
  board: WatchBoard; prs: PrSource; sink: AlertSink; now?: () => number; statePath?: string
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; intervalMs?: number; signal: AbortSignal; deadlineMs?: number
}

export async function watchService({ board, prs, sink, now = Date.now, statePath,
  sleep = (ms, signal) => setTimeout(ms, undefined, { signal }), intervalMs = 5 * 60_000, deadlineMs = 30_000, signal, ...options
}: ServiceOptions): Promise<void> {
  if (signal.aborted) return
  const stall = shadowStall(board, sink, now, options)
  const slowdown = slowdownDetector(options)
  const pr = prLog(prs, sink, { statePath, now })
  let cursor: string | undefined
  const pending: ShadowAlert[] = []
  async function bounded(name: string, work: (signal: AbortSignal) => void | Promise<void>, timed = true) {
    const deadline = new AbortController()
    const partSignal = AbortSignal.any([signal, deadline.signal])
    partSignal.throwIfAborted()
    const timeout = timed ? globalThis.setTimeout(() => deadline.abort(new WatchError(`watch ${name} timed out`)), deadlineMs) : undefined
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(partSignal.reason)
      partSignal.addEventListener('abort', onAbort, { once: true })
    })
    try { await Promise.race([aborted, Promise.resolve().then(() => { partSignal.throwIfAborted(); return work(partSignal) })]) }
    finally { clearTimeout(timeout); partSignal.removeEventListener('abort', onAbort) }
  }
  async function part(name: string, work: (signal: AbortSignal) => Promise<void>) {
    if (signal.aborted) return
    try { await bounded(name, work, name !== 'sleep') } catch (error) {
      if (signal.aborted) return
      try {
        await bounded(name, () => sink({ at: new Date(now()).toISOString(), kind: 'stall', key: `watch:error:${name}`,
          text: errorMessage(error, `watch ${name} failed`) }))
      } catch { /* a broken sink cannot record its own failure */ }
    }
  }
  while (!signal.aborted) {
    await part('stall', stall)
    await part('slowdown', async (signal) => {
      // An independent cursor keeps counting even when the stall check is paused or fails.
      const page = await board.poll({ after: cursor, wait: 0 }, signal)
      signal.throwIfAborted()
      const alert = slowdown.observe(now(), cursor === undefined ? 0 : page.events.length)
      cursor = page.cursor
      if (alert) pending.push(alert)
      while (pending.length) {
        await sink(pending[0]!)
        signal.throwIfAborted()
        pending.shift()
      }
    })
    await part('pr', pr.poll)
    await part('sleep', (signal) => sleep(intervalMs, signal))
  }
}
