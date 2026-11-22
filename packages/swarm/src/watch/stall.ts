import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { stallWatcher, type StallBoard, type StallWatcherOptions } from '@remilia/politburo-runtime'
import { WatchError, type AlertSink } from './alerts.ts'

export type WatchBoard = {
  poll(query: Parameters<StallBoard['poll']>[0], signal?: AbortSignal): ReturnType<StallBoard['poll']>
  status(signal?: AbortSignal): ReturnType<StallBoard['status']>
  agents: { list(channel: string, signal?: AbortSignal): ReturnType<StallBoard['agents']['list']> }
}
export type StallOptions = Partial<Pick<StallWatcherOptions, 'channel' | 'quietMinutes' | 'periodMinutes'>>

const token = (value: string) => /^[A-Za-z0-9._-]{1,48}$/.test(value) ? value
  : `agent-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`

export function shadowStall(board: WatchBoard, sink: AlertSink, now: () => number, options: StallOptions = {}) {
  // A late adapter response must not resume an expired check using the next check's signal.
  const scope = new AsyncLocalStorage<AbortSignal>()
  async function read<T>(work: (signal: AbortSignal) => Promise<T> | T) {
    const signal = scope.getStore()!
    signal.throwIfAborted()
    const result = await work(signal)
    signal.throwIfAborted()
    return result
  }
  const watcher = stallWatcher({
    poll: (query) => read((signal) => board.poll(query, signal)),
    status: () => read((signal) => board.status(signal)),
    agents: { async list(channel) {
      const { agents } = await read((signal) => board.agents.list(channel, signal))
      return { agents: agents.map((agent) => ({ ...agent, id: token(agent.id), role: token(agent.role) })) }
    } },
    operationalInbox: {
      async send({ topic, text }) {
        try { await read(() => sink({ at: new Date(now()).toISOString(), kind: 'stall', key: topic, text })) }
        catch { throw new WatchError('shadow stall append failed') }
      },
    },
  }, { ...options, channel: options.channel ?? 'work', now, to: { role: 'operator' } })
  return (signal: AbortSignal) => scope.run(signal, async () => {
    const result = await watcher.check()
    if ('errors' in result && result.errors?.length) throw new WatchError('shadow stall append failed')
  })
}
