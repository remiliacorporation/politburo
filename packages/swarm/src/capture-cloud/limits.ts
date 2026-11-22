export const recordCap = 5_000
export const tokenCap = 100_000_000

export function tokenBucket(rate: number, burst: number, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number }>()
  return (key: string): number => {
    const at = now()
    const old = buckets.get(key)
    const tokens = old ? Math.min(burst, old.tokens + Math.max(0, at - old.at) * rate / 1000) : burst
    // Remove buckets that have already refilled, oldest first.
    for (const [key, bucket] of buckets) {
      if (at - bucket.at < 1000 * burst / rate) break
      buckets.delete(key)
    }
    buckets.delete(key)
    buckets.set(key, { tokens: tokens >= 1 ? tokens - 1 : tokens, at: Math.max(at, old?.at ?? at) })
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / rate)
  }
}
