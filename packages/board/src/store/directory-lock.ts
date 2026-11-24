import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const locks = new Map<string, { db: DatabaseSync; users: number }>()

/** Share ownership among local stores in this process; null means another process owns the directory. */
export function lockDirectory(dir: string): (() => void) | null {
  const key = realpathSync.native(dir)
  let lock = locks.get(key)
  if (!lock) {
    const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    // Use a separate file: the board's WAL database needs both the log and table connections.
    // Never unlink this file. SQLite's OS lock, not the file's presence, signals ownership.
    const db = new Database(join(key, '.lock'))
    try {
      db.exec('pragma busy_timeout = 0; pragma locking_mode = exclusive; begin exclusive; commit')
    } catch (error) {
      db.close()
      // SQLite's primary SQLITE_BUSY code is 5, including extended BUSY codes.
      const { code, errcode } = error as { code?: string; errcode?: number }
      if (code === 'ERR_SQLITE_ERROR' && errcode !== undefined && (errcode & 0xff) === 5) return null
      throw error
    }
    lock = { db, users: 0 }
    locks.set(key, lock)
  }
  const held = lock
  held.users++
  return () => {
    if (--held.users !== 0) return
    held.db.close()
    locks.delete(key)
  }
}
