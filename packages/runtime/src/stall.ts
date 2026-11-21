import { createHash } from 'node:crypto'
import timers from 'node:timers/promises'
import type { ControllerRecipient } from './controller/index.ts'

const MINUTE_MS = 60_000
const MAX_TIMER_MS = 2_147_483_647

type BeatSchedule = { everyMinutes: number; offsetMinutes: number }

/** The first slot strictly after `now` (epoch milliseconds). */
export function nextBeat({ everyMinutes, offsetMinutes, now }: BeatSchedule & { now: number }): number {
  if (!Number.isInteger(everyMinutes) || everyMinutes <= 0) throw new RangeError('invalid everyMinutes')
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0) throw new RangeError('invalid offsetMinutes')

  const periodMs = everyMinutes * MINUTE_MS
  const offsetMs = (offsetMinutes % everyMinutes) * MINUTE_MS
  const beat = now - (now % periodMs) + offsetMs
  // The remainder truncates toward zero, so before the epoch an earlier slot can still be ahead.
  const previous = beat - periodMs
  if (previous > now) return previous
  return beat > now ? beat : beat + periodMs
}

export interface HeartbeatBoard {
  agents: {
    heartbeat(id: string, generation: number): Promise<unknown>
  }
}

export type HeartbeatOptions = BeatSchedule & {
  /** Epoch milliseconds. */
  now(): number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  signal: AbortSignal
}

async function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  // Node's timer fires early if its delay exceeds this limit.
  while (ms > MAX_TIMER_MS) {
    await timers.setTimeout(MAX_TIMER_MS, undefined, { signal })
    ms -= MAX_TIMER_MS
  }
  await timers.setTimeout(Math.ceil(ms), undefined, { signal })
}

/** Send beats on the grid until abort. Any board error, including a 409, stops the loop. */
export async function heartbeat(
  handle: HeartbeatBoard,
  { id, generation }: { id: string; generation: number },
  { everyMinutes, offsetMinutes, now, sleep = timerSleep, signal }: HeartbeatOptions,
): Promise<void> {
  while (!signal.aborted) {
    const time = now()
    const delay = nextBeat({ everyMinutes, offsetMinutes, now: time }) - time
    try {
      await sleep(delay, signal)
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
    if (signal.aborted) return
    await handle.agents.heartbeat(id, generation)
  }
}

export type StallAgent = Readonly<{
  id: string
  role: string
  status: 'enabled' | 'disabled'
  heartbeatAt: string | null
  generation?: number
}>

export interface StallBoard {
  poll(query: { after?: string; wait?: 0; last?: number }): Promise<{ events: readonly { createdAt: string }[]; cursor: string }>
  agents: {
    list(channel: string): Promise<{ agents: readonly StallAgent[] }>
  }
  status(): Promise<{ paused: boolean }>
  operationalInbox: {
    send(input: { to: ControllerRecipient; topic: string; text: string }): Promise<unknown>
  }
}

export type StallWatcherOptions = {
  channel: string
  to: ControllerRecipient
  quietMinutes?: number
  /** Defaults to 30. Return undefined for an agent with no expected period. */
  periodMinutes?: number | ((agent: StallAgent) => number | undefined)
  /** Epoch milliseconds, following the board's wall clock. */
  now(): number
}

export type MissedBeat = { id: string; role: string; heartbeatAt: string | null; ageMs: number; limitMs: number }

type StallSendError = { topic: string; error: string }

export type StallResult =
  | { kind: 'ok' }
  | { kind: 'paused'; errors?: StallSendError[] }
  | { kind: 'quiet'; sinceMs: number; quietMinutes: number; missed?: MissedBeat[]; errors?: StallSendError[] }
  | { kind: 'missed'; agents: MissedBeat[]; errors?: StallSendError[] }

// Escape backslashes as \\ and controls, format characters, lone surrogates, and reserved : and ~ as \u{hex}.
function escapeAlertField(value: string): string {
  const maxLength = 64
  const hashLength = 32
  let escaped = ''
  let prefixEnd = 0
  for (const char of value) {
    if (char === '\\') escaped += '\\\\'
    else if (/[:~\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(char)) escaped += `\\u{${char.codePointAt(0)!.toString(16)}}`
    else escaped += char
    if (escaped.length > maxLength) {
      const hash = createHash('sha256').update(value, 'utf16le').digest('hex').slice(0, hashLength)
      return `${escaped.slice(0, prefixEnd)}~${hash}`
    }
    // Leave room for the suffix without cutting an escape or a Unicode code point.
    if (escaped.length <= maxLength - 1 - hashLength) prefixEnd = escaped.length
  }
  return escaped
}

function sendErrorMessage(error: unknown): string {
  const fallback = 'operational inbox send failed'
  try {
    const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined
    const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
    // Removing separators must not join lone surrogates into a format character.
    const clean = String(typeof message === 'string' ? message : error)
      .toWellFormed()
      .replace(unsafe, '')
      .slice(0, 256)
      .toWellFormed()
    if (clean.search(unsafe) !== -1) return fallback
    return clean.trim() && clean !== '[object Object]' ? clean : fallback
  } catch {
    return fallback
  }
}

/**
 * Await each check before calling again. The feed cursor and topic dedupe live
 * only in memory for this watcher instance. A failed send is reported without
 * blocking later alerts. The next check retries it if the issue persists.
 * If a send succeeds but its response is lost, a retry replaces the first
 * message and its receipt is lost.
 */
export function stallWatcher(
  handle: StallBoard,
  { channel, to, quietMinutes = 30, periodMinutes = 30, now }: StallWatcherOptions,
) {
  const startedAt = now()
  const alertChannel = escapeAlertField(channel)
  let activityAt = startedAt
  let after: string | undefined
  const observed = new Map<string, { generation: number | undefined; since: number }>()
  const sent = new Set<string>()

  async function isPaused(): Promise<boolean> {
    try {
      return (await handle.status()).paused
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'no_network_pause') throw error
      return false
    }
  }

  return {
    async check(): Promise<StallResult> {
      if (await isPaused()) return { kind: 'paused' }

      const firstPoll = after === undefined
      const { events, cursor } = await handle.poll(firstPoll ? { last: 25 } : { after, wait: 0 })
      after = cursor
      const time = now()
      for (const { createdAt } of events) {
        const eventAt = Date.parse(createdAt)
        if (!Number.isNaN(eventAt)) activityAt = Math.max(activityAt, Math.min(eventAt, time))
      }

      const { agents } = await handle.agents.list(channel)
      const missed: MissedBeat[] = []
      for (const agent of agents) {
        const { id, role, status, heartbeatAt, generation } = agent
        let observation = observed.get(id)
        if (!observation || observation.generation !== generation) {
          observation = { generation, since: firstPoll && !observation ? startedAt : time }
          observed.set(id, observation)
        }
        if (status !== 'enabled') continue
        const beatAt = heartbeatAt === null ? observation.since : Date.parse(heartbeatAt)
        if (heartbeatAt !== null && beatAt > activityAt) activityAt = beatAt
        const period = typeof periodMinutes === 'function' ? periodMinutes(agent) : periodMinutes
        if (period === undefined) continue
        const ageMs = time - beatAt
        const limitMs = 2 * period * MINUTE_MS
        if (ageMs > limitMs) missed.push({ id, role, heartbeatAt, ageMs, limitMs })
      }

      const idleMs = time - activityAt
      const quiet = idleMs >= quietMinutes * MINUTE_MS
      const alerts = new Map<string, string>()
      if (quiet) alerts.set(`stall:quiet:${alertChannel}`, `No board feed events or heartbeats from enabled agents in ${alertChannel} for ${idleMs} ms.`)
      for (const { id, role, heartbeatAt, ageMs, limitMs } of missed) {
        const alertId = escapeAlertField(id)
        const last = heartbeatAt === null ? `has no heartbeat after ${ageMs} ms of watching` : `last sent a heartbeat ${ageMs} ms ago`
        alerts.set(`stall:missed:${alertChannel}:${alertId}`, `Agent ${alertId} (${escapeAlertField(role)}) ${last}. The limit is ${limitMs} ms.`)
      }
      for (const topic of sent) if (!alerts.has(topic)) sent.delete(topic)
      const errors: StallSendError[] = []
      for (const [topic, text] of alerts) {
        if (sent.has(topic)) continue
        if (await isPaused()) return errors.length ? { kind: 'paused', errors } : { kind: 'paused' }
        try {
          await handle.operationalInbox.send({ to, topic, text })
        } catch (error) {
          errors.push({ topic, error: sendErrorMessage(error) })
          continue
        }
        sent.add(topic)
      }

      const failures = errors.length > 0 ? { errors } : {}
      if (quiet) return { kind: 'quiet', sinceMs: activityAt, quietMinutes, ...(missed.length > 0 ? { missed } : {}), ...failures }
      if (missed.length > 0) return { kind: 'missed', agents: missed, ...failures }
      return { kind: 'ok' }
    },
  }
}
