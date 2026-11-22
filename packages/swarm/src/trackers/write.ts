import { TrackerError, type SourceRef, type TrackerAdapter } from './types.ts'

export type WriteBack = 'off' | 'comments' | 'transitions'

export function requireWriteBack(writeBack: WriteBack): void {
  // The transitions mode allows comments, but state transitions are not implemented.
  if (writeBack !== 'comments' && writeBack !== 'transitions') throw new TrackerError('write_disabled')
}

export function readCredential(token: () => string | undefined): string {
  let credential: string | undefined
  try { credential = token() } catch { throw new TrackerError('no_credential') }
  if (!credential?.trim()) throw new TrackerError('no_credential')
  return credential
}

export function commentMarker(body: string, opId: string): string {
  if (!body.trim() || body.length > 4000 || /[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(body)
    || body.includes('politburo-op:') || !/^[A-Za-z0-9._:-]{8,100}$/.test(opId)) {
    throw new TrackerError('bad_request')
  }
  return `<!-- politburo-op:${opId} -->`
}

export function commentCredential(token: () => string | undefined, body: string, opId: string): string {
  const credential = readCredential(token)
  if (body.includes(credential) || opId.includes(credential)) throw new TrackerError('bad_request')
  return credential
}

type CommentAttempt = Promise<{ receipt: string; alreadyApplied: boolean }>
const inFlight = new Map<string, CommentAttempt>()

export function coalesceComment(ref: SourceRef, opId: string, apply: () => CommentAttempt): CommentAttempt {
  const key = JSON.stringify([ref.source, ref.itemId, ref.displayId, opId])
  const pending = inFlight.get(key)
  if (pending) return pending
  const attempt = Promise.resolve().then(apply).finally(() => { inFlight.delete(key) })
  inFlight.set(key, attempt)
  return attempt
}

export async function commentOn(adapters: TrackerAdapter[], ref: SourceRef, body: string, opId: string,
  { writeBack = 'off' }: { writeBack?: WriteBack } = {},
) {
  requireWriteBack(writeBack)
  const adapter = adapters.find(({ source }) => source === ref.source)
  if (!adapter) throw new TrackerError('bad_source')
  if (!adapter.comment) throw new TrackerError('write_disabled')
  return adapter.comment(ref, body, opId)
}
