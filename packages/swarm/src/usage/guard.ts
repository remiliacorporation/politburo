import type { UsageGuard, UsageSource } from '@remilia/politburo-runtime'

export function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= 8.64e15
}

// Decode the shortest round-tripping decimal, including scientific notation.
function decimal(value: number) {
  const [mantissa, exponent = '0'] = String(value).split('e')
  const [whole, fraction = ''] = mantissa!.split('.')
  return { digits: BigInt(whole! + fraction), places: fraction.length - Number(exponent) }
}

export function stopGuard({ source, stopPercent = 100, now = Date.now }: {
  source: UsageSource
  stopPercent?: number
  now?: () => number
}): UsageGuard {
  if (!Number.isFinite(stopPercent) || stopPercent < 0 || stopPercent > 100) {
    throw new RangeError('limits.usage_stop_percent must be between 0 and 100')
  }
  const stop = decimal(stopPercent)
  return {
    async check() {
      const window = await source.read()
      // localUsage validates file reads. Mirror its private validator for injected sources.
      if (!window || typeof window !== 'object' || typeof window.usedFraction !== 'number' ||
          !(window.usedFraction >= 0 && window.usedFraction <= 1) ||
          !validTimestamp(window.resetAt)) {
        throw new TypeError('invalid five-hour usage window')
      }
      // Runtime usageGuard is left as it is; its fixed 95% is not used here.
      const { usedFraction, resetAt } = window
      const used = decimal(usedFraction)
      const places = Math.max(used.places, stop.places)
      return used.digits * 100n * 10n ** BigInt(places - used.places) >=
        stop.digits * 10n ** BigInt(places - stop.places) && now() < resetAt
        ? { allowed: false, resetAt }
        : { allowed: true }
    },
  }
}
