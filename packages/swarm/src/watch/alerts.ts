import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ShadowAlert = { at: string; kind: 'stall' | 'slowdown' | 'pr'; key: string; text: string }
export type AlertSink = (alert: ShadowAlert) => void | Promise<void>

export function jsonlSink(path: string): AlertSink {
  return async ({ at, kind, key, text }) => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify({ at, kind, key, text })}\n`, { mode: 0o600 })
  }
}

export class WatchError extends Error {}

export function errorMessage(error: unknown, fallback: string): string {
  // As in runtime's sendErrorMessage, keep diagnostics bounded and single-line.
  // Only use locally authored messages: remote errors can echo arbitrary secrets.
  if (error instanceof WatchError) {
    return error.message.toWellFormed().replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 256).toWellFormed() || fallback
  }
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (typeof code === 'string' && ['ENOENT', 'EACCES', 'ENOSPC', 'no_agent_ops', 'unauthorized', 'forbidden'].includes(code)) return `${fallback} (${code})`
  } catch { /* an untrusted error can have throwing getters */ }
  return fallback
}
