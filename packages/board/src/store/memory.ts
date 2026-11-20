import { memory as a2Memory } from 'experimental-a2/store-memory'
import type { Clock } from 'experimental-a2/server'
import { appendGuard } from './append-guard.ts'
import { sqliteDb } from './sqlite-db.ts'
import { sqlTables } from './sql.ts'
import type { BoardStore } from './types.ts'

/**
 * A board that lives in memory, for tests: its log in A2's memory store, its
 * tables in an in-memory SQLite. `clock` sets every stored timestamp.
 */
export function memory(options: { clock?: Clock } = {}): BoardStore {
  const { clock, guardAppend } = appendGuard(options.clock)
  const log = a2Memory({ clock })
  const tables = sqlTables(sqliteDb(':memory:'))
  return { log, guardAppend, tables, close: () => tables.close() }
}
