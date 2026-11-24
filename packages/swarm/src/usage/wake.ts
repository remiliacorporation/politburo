import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type WakeState = { resetAt: number; firedAt?: number }

function wakeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function readWakeState(path: string): WakeState | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const state: unknown = JSON.parse(text)
  if (state && typeof state === 'object' && 'resetAt' in state && wakeTimestamp(state.resetAt) &&
      Object.keys(state).every(key => key === 'resetAt' || key === 'firedAt')) {
    const { resetAt } = state
    if (!('firedAt' in state)) return { resetAt }
    if (wakeTimestamp(state.firedAt)) return { resetAt, firedAt: state.firedAt }
  }
  throw new TypeError('invalid reset wake state')
}

function writeWakeState(path: string, state: WakeState) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { flag: 'wx', mode: 0o600, flush: true })
  try {
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

type Pending = { resetAt: number; cancel?: () => void }
type SetTimer = (callback: () => Promise<void>, delay: number) => unknown
const startTimer: SetTimer = (callback, delay) => {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}

// One owner per state path. On startup, resume restores the persisted wake.
export function resetWake({ statePath, now = Date.now, setTimer = startTimer, onWake,
  readState = readWakeState, writeState = writeWakeState }: {
  statePath: string
  now?: () => number
  // Return a cancellation function if the timer supports cancellation.
  setTimer?: SetTimer
  onWake: () => void | Promise<void>
  readState?: typeof readWakeState
  writeState?: typeof writeWakeState
}) {
  let pending: Pending | undefined

  async function schedule(resetAt: number): Promise<void> {
    if (pending?.resetAt === resetAt) return
    pending?.cancel?.()
    const entry: Pending = { resetAt }
    pending = entry
    const time = now()
    if (time >= resetAt) {
      try {
        // A crash between callback and mark redelivers. The wake only requests a
        // fresh read and a dispatch attempt, so replay is safe (idempotent).
        await onWake()
        if (pending === entry) writeState(statePath, { resetAt, firedAt: now() })
      } finally {
        if (pending === entry) pending = undefined
      }
      return
    }
    try {
      const cancel = setTimer(async () => {
        if (pending !== entry) return
        pending = undefined
        const state = readState(statePath)
        if (state?.resetAt === resetAt && state.firedAt === undefined) await schedule(resetAt)
      }, Math.min(resetAt - time, 2 ** 31 - 1))
      if (typeof cancel === 'function') entry.cancel = () => { cancel() }
    } catch (error) {
      pending = undefined
      throw error
    }
  }

  return {
    async arm(resetAt: number) {
      if (!wakeTimestamp(resetAt)) throw new RangeError('invalid reset timestamp')
      const state = readState(statePath)
      if (state && state.resetAt >= resetAt) return
      writeState(statePath, { resetAt })
      await schedule(resetAt)
    },
    async resume() {
      const state = readState(statePath)
      if (state && state.firedAt === undefined) await schedule(state.resetAt)
    },
  }
}
