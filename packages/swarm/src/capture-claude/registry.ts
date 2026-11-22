import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { identifier, object } from './facts.ts'
import type { Envelope } from './record.ts'

export interface SessionRegistry {
  lookup(nativeSession: string): Envelope | null
  bind(nativeSession: string, envelope: Envelope): void
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function envelopeOf(value: unknown): Envelope | null {
  const entry = object(value)
  if (!entry) return null
  const { party, repo, work_id, attempt, tier, parent, session } = entry
  const trace = object(entry.trace)
  if (typeof party !== 'string' || typeof session !== 'string' ||
    typeof trace?.id !== 'string' || typeof trace.execution_id !== 'string' ||
    !nullableString(repo) || !nullableString(work_id) || !nullableString(attempt) || !nullableString(parent) ||
    (tier !== 'core' && tier !== 'spawner' && tier !== 'secretary' && tier !== 'mob' && tier !== 'sprite' && tier !== 'jockey')) {
    return null
  }
  return { party, repo, work_id, attempt, tier, parent, session, trace: { id: trace.id, execution_id: trace.execution_id } }
}

function readBindings(path: string): Map<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return new Map(Object.entries(object(parsed) ?? {}))
  } catch (error) {
    if (error instanceof SyntaxError || object(error)?.code === 'ENOENT') return new Map()
    throw error
  }
}

export function fileRegistry(path: string): SessionRegistry {
  return {
    lookup: (nativeSession) => identifier(nativeSession) === null ? null : envelopeOf(readBindings(path).get(nativeSession)),
    bind(nativeSession, envelope) {
      if (identifier(nativeSession) === null) throw new Error('invalid native session')
      const next = envelopeOf(envelope)
      if (!next) throw new Error('invalid session envelope')
      // Exclusive temp file serializes read/modify/rename across bind processes.
      // If a binder crashes, remove the abandoned .tmp file before binding again.
      const temp = `${path}.tmp`
      const fd = openSync(temp, 'wx', 0o600)
      let renamed = false
      try {
        const bindings = readBindings(path)
        const current = envelopeOf(bindings.get(nativeSession))
        if (current) {
          if (!isDeepStrictEqual(current, next)) throw new Error('native session already bound')
          return
        }
        bindings.set(nativeSession, next)
        writeFileSync(fd, `${JSON.stringify(Object.fromEntries(bindings))}\n`)
        renameSync(temp, path)
        renamed = true
      } finally {
        closeSync(fd)
        if (!renamed) unlinkSync(temp)
      }
    },
  }
}
