// STUB: the ingest sprite replaces this file. It accepts anything so the store compiles alone.
import type { Dispatch, Intent, SpendRecord } from './types.ts'

export const validateDispatch = (input: unknown): Dispatch => input as Dispatch
export const validateIntent = (input: unknown): Intent => input as Intent
export const validateRecord = (input: unknown): SpendRecord => input as SpendRecord
