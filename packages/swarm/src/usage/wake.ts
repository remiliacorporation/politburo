import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validTimestamp } from './guard.ts'

export type WakeState = { resetAt: number; firedAt?: number }

export function readWakeState(path: string): WakeState | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const state: unknown = JSON.parse(text)
  if (state && typeof state === 'object' && 'resetAt' in state && validTimestamp(state.resetAt)) {
    const { resetAt } = state
    if (!('firedAt' in state)) return { resetAt }
    if (validTimestamp(state.firedAt) && state.firedAt >= resetAt) return { resetAt, firedAt: state.firedAt }
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
    pending = undefined
    const time = now()
    if (time >= resetAt) {
      writeState(statePath, { resetAt, firedAt: time })
      await onWake()
      return
    }
    const entry: Pending = { resetAt }
    pending = entry
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
      if (!validTimestamp(resetAt)) throw new RangeError('invalid reset timestamp')
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
