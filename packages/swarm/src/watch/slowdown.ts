import type { ShadowAlert } from './alerts.ts'

export type SlowdownOptions = { windowMinutes?: number; fraction?: number; minBaseline?: number }

// Unverified against core-watch.sh: compare each complete window's count to a
// fraction of the median of its six predecessors, with a minimum baseline.
export function slowdownDetector({ windowMinutes = 30, fraction = 0.25, minBaseline = 8 }: SlowdownOptions = {}) {
  const width = windowMinutes * 60_000
  if (!Number.isFinite(width) || width < 1) throw new RangeError('invalid slowdown window')
  const history: number[] = []
  let start: number | undefined
  let bucket = 0, count = 0, inEpisode = false
  function close(at: number): ShadowAlert | undefined {
    const sorted = [...history].sort((a, b) => a - b)
    const median = sorted.length === 6 ? (sorted[2]! + sorted[3]!) / 2 : Infinity
    const below = count < fraction * median
    const alert = !inEpisode && below && Number.isFinite(median) && median >= minBaseline
    if (alert || !below) inEpisode = alert
    const text = `board activity fell to ${count} events per window (median ${median})`
    history.push(count)
    if (history.length > 6) history.shift()
    count = 0
    if (alert) return { at: new Date(at).toISOString(), kind: 'slowdown', key: 'slowdown:board', text }
  }
  return {
    observe(at: number, eventCount: number): ShadowAlert | undefined {
      // Counts are for the interval ending at `at`; a boundary tick closes its window.
      start ??= at
      const current = Math.max(0, Math.ceil((at - start) / width) - 1)
      let alert: ShadowAlert | undefined
      for (const end = Math.min(current, bucket + 8); bucket < end; bucket++) alert = close(at) ?? alert
      bucket = Math.max(bucket, current)
      count += eventCount
      if (at >= start + (bucket + 1) * width) { bucket++; alert = close(at) ?? alert }
      return alert
    },
  }
}
