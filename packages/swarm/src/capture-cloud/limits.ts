export const recordCap = 5_000
export const tokenCap = 100_000_000

export function tokenBucket(rate: number, burst: number, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number; debits: number[] }>()
  let nextDebit = 0
  function take(key: string) {
    const at = now()
    const old = buckets.get(key)
    const tokens = old ? Math.min(burst, old.tokens + Math.max(0, at - old.at) * rate / 1000) : burst
    // Remove buckets that have already refilled, oldest first.
    for (const [key, bucket] of buckets) {
      if (at - bucket.at < 1000 * burst / rate) break
      buckets.delete(key)
    }
    // Time restore pays the oldest debits; only unrestored debits remain refundable.
    const live = tokens >= burst ? 0 : Math.ceil(burst - tokens)
    const debits = live === 0 ? [] : (old?.debits ?? []).slice(-live)
    buckets.delete(key)
    if (tokens < 1) {
      buckets.set(key, { tokens, at: Math.max(at, old?.at ?? at), debits })
      return { retry: Math.ceil((1 - tokens) / rate) }
    }
    const debit = ++nextDebit
    buckets.set(key, { tokens: tokens - 1, at: Math.max(at, old?.at ?? at), debits: [...debits, debit] })
    return { retry: 0, debit }
  }
  return Object.assign(take, { refund(key: string, debit?: number) {
    const bucket = buckets.get(key)
    if (!bucket || debit === undefined) return
    const idx = bucket.debits.indexOf(debit)
    if (idx < 0) return
    bucket.debits.splice(idx, 1)
    bucket.tokens = Math.min(burst, bucket.tokens + 1)
  } })
}
