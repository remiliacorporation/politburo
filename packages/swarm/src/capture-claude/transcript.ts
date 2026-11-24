import { count, identifier, object, text, utc, type RequestFact } from './facts.ts'

export function parseTranscript(jsonl: string, nativeSession: string) {
  const facts: RequestFact[] = []
  const gaps: RequestFact[] = []
  const responses = new Map<string, number>()
  const lines = jsonl.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let badLines = 0, foreign = 0, noId = 0, unscoped = 0
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      badLines++
      continue
    }
    const row = object(parsed)
    if (!row || row.sessionId !== nativeSession) {
      if (row?.type === 'assistant' && !Object.hasOwn(row, 'sessionId')) unscoped++
      else if (row && Object.hasOwn(row, 'sessionId')) foreign++
      continue
    }
    if (row.type !== 'assistant') continue
    const message = object(row.message)
    if (message?.model === '<synthetic>') continue
    const model = identifier(message?.model)
    const requestId = identifier(row.requestId)
    const responseId = identifier(message?.id)
    const usage = object(message?.usage)
    const timestamp = text(row.timestamp)
    const fact: RequestFact = {
      source: 'transcript', nativeSession, requestId, responseId, model,
      tokens: {
        input_uncached: count(usage?.input_tokens),
        input_total: null,
        output: count(usage?.output_tokens),
        cache_read: count(usage?.cache_read_input_tokens),
        cache_write: count(usage?.cache_creation_input_tokens),
        reasoning: null,
      },
      occurred: timestamp === null ? null : utc(new Date(timestamp)),
    }
    if (requestId === null && responseId === null) {
      noId++
      gaps.push(fact)
      continue
    }
    const key = JSON.stringify([requestId, responseId])
    const index = responses.get(key)
    if (index !== undefined) {
      if ((fact.tokens.output ?? -1) >= (facts[index]!.tokens.output ?? -1)) facts[index] = fact
      continue
    }
    responses.set(key, facts.length)
    facts.push(fact)
  }
  return { facts, gaps, badLines, foreign, noId, unscoped }
}
