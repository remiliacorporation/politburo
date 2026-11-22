import type { UsageGuard, UsageSource } from '@remilia/politburo-runtime'

export function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= 8.64e15
}

export function stopGuard({ source, stopPercent = 100, now = Date.now }: {
  source: UsageSource
  stopPercent?: number
  now?: () => number
}): UsageGuard {
  if (!Number.isFinite(stopPercent) || stopPercent < 1 || stopPercent > 100) {
    throw new RangeError('limits.usage_stop_percent must be between 1 and 100')
  }
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
      return usedFraction >= stopPercent / 100 && now() < resetAt
        ? { allowed: false, resetAt }
        : { allowed: true }
    },
  }
}
