import type { StallAgent } from '@remilia/politburo-runtime'
import { WatchError, type ShadowAlert } from './alerts.ts'
import { watchService, type WatchOptions } from './service.ts'

// Each frame holds the feed batch since the preceding poll, not cumulative history.
export type Frame = { t: number; events: readonly { createdAt: string }[]; agents: readonly StallAgent[]; paused: boolean }

export async function replay(frames: readonly Frame[], options: WatchOptions = {}): Promise<ShadowAlert[]> {
  if (!Array.isArray(frames) || frames.some((f: Frame, i) => typeof f?.t !== 'number' || !Number.isFinite(new Date(f.t).getTime())
    || (i > 0 && f.t < frames[i - 1]!.t) || typeof f.paused !== 'boolean'
    || !Array.isArray(f.events) || f.events.some((event: Frame['events'][number]) => typeof event?.createdAt !== 'string')
    || !Array.isArray(f.agents) || f.agents.some((a: StallAgent) => typeof a?.id !== 'string' || typeof a.role !== 'string'
      || !['enabled', 'disabled'].includes(a.status) || (a.heartbeatAt !== null && typeof a.heartbeatAt !== 'string')))) {
    throw new WatchError('invalid replay frames')
  }
  const alerts: ShadowAlert[] = []
  if (!frames.length) return alerts
  const controller = new AbortController()
  let index = 0
  const frame = () => frames[index]!
  await watchService({ ...options, signal: controller.signal, now: () => frame().t,
    board: {
      async poll({ after, last }) {
        const events = frames.slice(Number(after ?? (last === undefined ? index + 1 : 0)), index + 1).flatMap((f) => f.events)
        return { cursor: String(index + 1), events: last === undefined ? events : events.slice(-last) }
      },
      agents: { async list() { return { agents: frame().agents } } },
      async status() { return { paused: frame().paused } },
    },
    prs: { async list() { return [] } }, sink: (alert) => { alerts.push(alert) },
    async sleep() { if (++index === frames.length) controller.abort() },
  })
  return alerts
}
