import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { stallWatcher, type StallAgent, type StallBoard, type StallWatcherOptions } from '@remilia/politburo-runtime'
import { WatchError, type AlertSink } from './alerts.ts'

export type WatchBoard = {
  poll(query: Parameters<StallBoard['poll']>[0], signal?: AbortSignal): ReturnType<StallBoard['poll']>
  status(signal?: AbortSignal): ReturnType<StallBoard['status']>
  agents: { list(channel: string, signal?: AbortSignal): ReturnType<StallBoard['agents']['list']> }
}
export type StallOptions = Partial<Pick<StallWatcherOptions, 'channel' | 'quietMinutes' | 'periodMinutes'>>

const token = (value: string) => /^[A-Za-z0-9._-]{1,48}$/.test(value) ? value
  : `agent-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`

function displayIds(agents: readonly StallAgent[]) {
  const labels = new Map([...new Set(agents.map(({ id }) => id))].sort().map((id) => [id, token(id)]))
  const reserved = new Set(labels.values()), nextSuffix = new Map<string, number>()
  for (const [id, base] of labels) {
    let suffix = nextSuffix.get(base)
    if (suffix === undefined) { nextSuffix.set(base, 2); continue }
    // A suffix must not take another agent's base token.
    let label: string
    do { label = `${base}-${suffix++}` } while (reserved.has(label))
    labels.set(id, label)
    nextSuffix.set(base, suffix)
  }
  return labels
}

export function shadowStall(board: WatchBoard, sink: AlertSink, now: () => number, options: StallOptions = {}) {
  // Runtime escapes and truncates IDs in its dedupe keys. Give it stable, unique
  // tracking IDs indexed by original ID, separate from the display tokens.
  const tracking = new Map<string, string>()
  // Keep each check's display lookup and signal together, including on timeout.
  const scope = new AsyncLocalStorage<{ signal: AbortSignal; fields: Map<string, { agent: StallAgent; label: string }> }>()
  async function read<T>(work: (signal: AbortSignal) => Promise<T> | T) {
    const { signal } = scope.getStore()!
    signal.throwIfAborted()
    const result = await work(signal)
    signal.throwIfAborted()
    return result
  }
  const period = options.periodMinutes
  const watcher = stallWatcher({
    poll: (query) => read((signal) => board.poll(query, signal)),
    status: () => read((signal) => board.status(signal)),
    agents: { async list(channel) {
      const { agents } = await read((signal) => board.agents.list(channel, signal))
      const labels = displayIds(agents), { fields } = scope.getStore()!
      return { agents: agents.map((agent) => {
        const id = tracking.get(agent.id) ?? String(tracking.size)
        tracking.set(agent.id, id)
        fields.set(id, { agent, label: labels.get(agent.id)! })
        return { ...agent, id, role: token(agent.role) }
      }) }
    } },
    operationalInbox: {
      async send({ topic: key, text }) {
        if (key.startsWith('stall:missed:')) {
          const split = key.lastIndexOf(':') + 1
          const id = key.slice(split), prefix = `Agent ${id} (`
          const fields = scope.getStore()!.fields.get(id)
          if (!fields || !text.startsWith(prefix)) throw new WatchError('invalid shadow stall alert')
          key = key.slice(0, split) + fields.label
          text = `Agent ${fields.label} (${text.slice(prefix.length)}`
        }
        try { await read(() => sink({ at: new Date(now()).toISOString(), kind: 'stall', key, text })) }
        catch { throw new WatchError('shadow stall append failed') }
      },
    },
  }, { ...options, channel: options.channel ?? 'work', now, to: { role: 'operator' },
    periodMinutes: typeof period === 'function' ? ({ id }) => period(scope.getStore()!.fields.get(id)!.agent) : period,
  })
  return (signal: AbortSignal) => scope.run({ signal, fields: new Map() }, async () => {
    const result = await watcher.check()
    if ('errors' in result && result.errors?.length) throw new WatchError('shadow stall append failed')
  })
}
