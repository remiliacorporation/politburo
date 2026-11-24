import { count, identifier, object, text, utc, type RequestFact } from './facts.ts'

export function parseTranscript(jsonl: string, nativeSession: string) {
  const facts: RequestFact[] = []
  const responses = new Map<string, number>()
  const lines = jsonl.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const decoded: ({ row: Record<string, unknown> | undefined } | null)[] = []
  for (const line of lines) {
    try {
      decoded.push({ row: object(JSON.parse(line)) })
    } catch {
      decoded.push(null)
    }
  }
  // A row with no sessionId may belong to this file only when every named row does.
  const mixed = decoded.some((item) => !!item?.row && Object.hasOwn(item.row, 'sessionId') &&
    item.row.sessionId !== nativeSession)
  let badLines = 0, foreign = 0, noId = 0, unscoped = 0
  for (const item of decoded) {
    if (item === null) {
      badLines++
      continue
    }
    const row = item.row
    if (row && Object.hasOwn(row, 'sessionId') && row.sessionId !== nativeSession) {
      foreign++
      continue
    }
    if (mixed && row && !Object.hasOwn(row, 'sessionId')) {
      if (row.type === 'assistant') unscoped++
      continue
    }
    if (row?.type !== 'assistant') continue
    const message = object(row.message)
    if (message?.model === '<synthetic>') continue
    const model = identifier(message?.model)
    const requestId = identifier(row.requestId)
    const responseId = identifier(message?.id)
    const usage = object(message?.usage)
    if (requestId === null && responseId === null) {
      noId++
      continue
    }
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
    const key = JSON.stringify([requestId, responseId])
    const index = responses.get(key)
    if (index !== undefined) {
      if ((fact.tokens.output ?? -1) >= (facts[index]!.tokens.output ?? -1)) facts[index] = fact
      continue
    }
    responses.set(key, facts.length)
    facts.push(fact)
  }
  return { facts, badLines, foreign, noId, unscoped }
}
