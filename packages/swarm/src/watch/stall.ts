import { stallWatcher, type StallBoard, type StallWatcherOptions } from '@remilia/politburo-runtime'
import { WatchError, type AlertSink } from './alerts.ts'

export type WatchBoard = Omit<StallBoard, 'operationalInbox'>
export type StallOptions = Partial<Pick<StallWatcherOptions, 'channel' | 'quietMinutes' | 'periodMinutes'>>

export function shadowStall(board: WatchBoard, sink: AlertSink, now: () => number, options: StallOptions = {}) {
  const watcher = stallWatcher({
    poll: (query) => board.poll(query), status: () => board.status(), agents: board.agents,
    operationalInbox: {
      async send({ topic, text }) {
        try { await sink({ at: new Date(now()).toISOString(), kind: 'stall', key: topic, text }) }
        catch { throw new WatchError('shadow stall append failed') }
      },
    },
  }, { ...options, channel: options.channel ?? 'work', now, to: { role: 'operator' } })
  return async () => {
    const result = await watcher.check()
    if ('errors' in result && result.errors?.length) throw new WatchError('shadow stall append failed')
  }
}
