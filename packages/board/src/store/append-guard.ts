import { AsyncLocalStorage } from 'node:async_hooks'
import type { Clock } from 'experimental-a2/server'
import type { AppendGuard } from './types.ts'

type Attempt = { check: (() => void) | null; rejected?: { error: unknown } }

/** A2 samples the append timestamp after checking the head, inside the SQLite write transaction or synchronous memory append. */
export function appendGuard(clock: Clock = { now: () => new Date() }): { clock: Clock; guardAppend: AppendGuard } {
  const current = new AsyncLocalStorage<Attempt>()
  return {
    clock: {
      now() {
        const now = clock.now()
        const attempt = current.getStore()
        if (attempt?.check) {
          const { check } = attempt
          attempt.check = null // A2's consumers can inherit this context, but not the guard.
          try {
            check()
          } catch (error) {
            attempt.rejected = { error }
            throw error // Abort the append (and roll back the SQLite transaction).
          }
        }
        return now
      },
    },
    async guardAppend(check, append) {
      const attempt: Attempt = { check }
      try {
        return await current.run(attempt, append)
      } catch (error) {
        // The adapter wraps storage failures; a refused write is still the board's own error.
        if (attempt.rejected) throw attempt.rejected.error
        throw error
      }
    },
  }
}
