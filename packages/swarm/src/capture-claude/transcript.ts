import { count, object, text, utc, type RequestFact } from './facts.ts'

export function parseTranscript(jsonl: string, nativeSession: string): { facts: RequestFact[]; badLines: number } {
  const facts: RequestFact[] = []
  const responses = new Map<string, number>()
  const lines = jsonl.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let badLines = 0
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      badLines++
      continue
    }
    const row = object(parsed)
    if (row?.type !== 'assistant') continue
    const message = object(row.message)
    const model = text(message?.model)
    if (model === '<synthetic>') continue
    const requestId = text(row.requestId)
    const responseId = text(message?.id)
    const usage = object(message?.usage)
    if (!usage && requestId === null && responseId === null) continue
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
    if (requestId !== null || responseId !== null) {
      const key = JSON.stringify([requestId, responseId])
      const index = responses.get(key)
      if (index !== undefined) {
        if ((fact.tokens.output ?? -1) >= (facts[index]!.tokens.output ?? -1)) facts[index] = fact
        continue
      }
      responses.set(key, facts.length)
    }
    facts.push(fact)
  }
  return { facts, badLines }
}
