import { buckets, type RequestFact } from './facts.ts'

export type Resolved = {
  fact: RequestFact
  state: 'matched' | 'mismatch' | 'otlp_only' | 'transcript_only'
  quality: 'provider_reported'
}

function conflict(a: RequestFact, b: RequestFact): boolean {
  return buckets.some((key) => a.tokens[key] !== null && b.tokens[key] !== null && a.tokens[key] !== b.tokens[key])
}

function matches(a: RequestFact, b: RequestFact): boolean {
  if (a.nativeSession !== b.nativeSession) return false
  const sharedRequest = a.requestId !== null && b.requestId !== null
  const sharedResponse = a.responseId !== null && b.responseId !== null
  return (sharedRequest || sharedResponse) && (!sharedRequest || a.requestId === b.requestId) &&
    (!sharedResponse || a.responseId === b.responseId)
}

export function reconcile(otlp: RequestFact[], transcript: RequestFact[]) {
  const groups = new Map<string, RequestFact[]>()
  for (const fact of otlp) {
    const key = JSON.stringify([fact.nativeSession, fact.requestId, fact.responseId, fact.gap ?? null])
    const group = groups.get(key)
    if (!group) groups.set(key, [fact])
    else if (!group.some((a) => buckets.every((k) => a.tokens[k] === fact.tokens[k]))) group.push(fact)
  }

  const records: Resolved[] = []
  const counters = { matched: 0, mismatched: 0, transcriptOnly: 0, otlpOnly: 0 }
  const used = new Set<number>()
  const add = (fact: RequestFact, state: Resolved['state']) => records.push({ fact, state, quality: 'provider_reported' })
  for (const group of groups.values()) {
    const fact = group[0]!
    const index = transcript.findIndex((row, i) => !used.has(i) && group.some((a) => matches(a, row)))
    const other = transcript[index]
    if (other) used.add(index)
    const disagrees = other !== undefined && group.some((a) => conflict(a, other))
    // Count a disputed request once, but return its evidence for separate handling.
    if (disagrees || group.some((a, i) => group.slice(i + 1).some((b) => conflict(a, b)))) {
      counters.mismatched++
      for (const row of group) add(row, 'mismatch')
      if (disagrees) add(other, 'mismatch')
    } else if (other) {
      counters.matched++
      add(fact, 'matched')
    } else {
      counters.otlpOnly++
      add(fact, 'otlp_only')
    }
  }
  for (const [index, fact] of transcript.entries()) {
    if (used.has(index)) continue
    counters.transcriptOnly++
    add(fact, 'transcript_only')
  }
  return { records, counters }
}
