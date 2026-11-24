export function parseWorkId(input: string): { tag: string; number: number } | null {
  const match = /^([a-z]{3})-([1-9][0-9]*)$/i.exec(input.trim())
  if (!match) return null
  const number = Number(match[2])
  return Number.isSafeInteger(number) ? { tag: match[1]!.toLowerCase(), number } : null
}

export function formatWorkId(tag: string, number: number): string {
  return `${tag.toLowerCase()}-${number}`
}

/**
 * Pure calculation; the caller must reserve the ID on the board by atomically
 * persisting the returned high-water mark before using the ID. Keep the mark
 * even when items are deleted. To recover from a crash between publishing and
 * persisting, read the board's highest published number before allocating again
 * and use the greater of that number and the persisted mark.
 */
export function allocateWorkId(tags: readonly string[], tag: string, highWater: number): {
  id: string
  highWater: number
} {
  if (!tags.includes(tag.toLowerCase())) throw new RangeError('Unknown work tag.')
  if (!Number.isSafeInteger(highWater) || highWater < 0 || highWater === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('The high water mark must be a nonnegative integer with room to advance safely.')
  }
  const next = highWater + 1
  return { id: formatWorkId(tag, next), highWater: next }
}

export function sourceBadge(alias: { source: 'github' | 'linear' | 'beads'; ref: string }): string {
  switch (alias.source) {
    case 'github': return `GH#${alias.ref.replace(/^#/, '')}`
    case 'linear': return `LIN ${alias.ref}`
    case 'beads': return `bd ${alias.ref}`
    default: throw new RangeError('Unknown badge source.')
  }
}
