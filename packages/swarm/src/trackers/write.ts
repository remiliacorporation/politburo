import { TrackerError, type SourceRef, type TrackerAdapter } from './types.ts'

export function commentMarker(body: string, opId: string): string {
  if (!body.trim() || body.length > 4000 || /[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(body)
    || !/^[A-Za-z0-9._:-]{8,100}$/.test(opId)) {
    throw new TrackerError('bad_request')
  }
  return `<!-- politburo-op:${opId} -->`
}

export async function commentOn(adapters: TrackerAdapter[], ref: SourceRef, body: string, opId: string,
  { writeBack = 'off' }: { writeBack?: 'off' | 'comments' | 'transitions' } = {},
) {
  // The transitions mode allows comments, but state transitions are not implemented.
  if (writeBack !== 'comments' && writeBack !== 'transitions') throw new TrackerError('write_disabled')
  const adapter = adapters.find(({ source }) => source === ref.source)
  if (!adapter) throw new TrackerError('bad_source')
  if (!adapter.comment) throw new TrackerError('write_disabled')
  return adapter.comment(ref, body, opId)
}
