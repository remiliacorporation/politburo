export const recordCap = 5_000
export const tokenCap = 100_000_000

export function tokenBucket(rate: number, burst: number, now: () => number = Date.now) {
  type Bucket = { tokens: number; at: number; debits: { id: number; remaining: number }[] }
  const buckets = new Map<string, Bucket>()
  let nextDebit = 0
  function refill(bucket: Bucket, at: number) {
    let credit = Math.max(0, at - bucket.at) * rate / 1000
    bucket.at = Math.max(at, bucket.at)
    bucket.tokens = Math.min(burst, bucket.tokens + credit)
    if (bucket.tokens === burst) {
      bucket.debits.length = 0
      return
    }
    // Refill pays the oldest debits first, including partial payments.
    while (credit > 0 && bucket.debits.length) {
      const oldest = bucket.debits[0]!
      if (credit < oldest.remaining) {
        oldest.remaining -= credit
        break
      }
      credit -= oldest.remaining
      bucket.debits.shift()
    }
  }
  function save(key: string, bucket: Bucket) {
    buckets.delete(key)
    buckets.set(key, bucket)
  }
  function take(key: string) {
    const at = now()
    // Remove buckets that have already refilled, oldest first.
    for (const [key, bucket] of buckets) {
      if (at - bucket.at < 1000 * burst / rate) break
      buckets.delete(key)
    }
    const bucket: Bucket = buckets.get(key) ?? { tokens: burst, at, debits: [] }
    refill(bucket, at)
    save(key, bucket)
    if (bucket.tokens < 1) return { retry: Math.ceil((1 - bucket.tokens) / rate) }
    const debit = ++nextDebit
    bucket.tokens -= 1
    bucket.debits.push({ id: debit, remaining: 1 })
    return { retry: 0, debit }
  }
  return Object.assign(take, { refund(key: string, debit?: number) {
    const bucket = buckets.get(key)
    if (!bucket || debit === undefined) return
    refill(bucket, now())
    save(key, bucket)
    const idx = bucket.debits.findIndex(entry => entry.id === debit)
    if (idx < 0) return
    const [entry] = bucket.debits.splice(idx, 1)
    bucket.tokens = Math.min(burst, bucket.tokens + entry!.remaining)
  } })
}