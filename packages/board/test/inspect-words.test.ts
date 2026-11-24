import { expect, it } from 'vitest'
import { left, shortSha } from '../src/inspect/app/words.ts'

const now = Date.UTC(2026, 0, 1)

it.each([
  [1, '1s left'],
  [59_000, '59s left'],
  [60_000, '1m left'],
  [59 * 60_000, '59m left'],
  [60 * 60_000, '1h left'],
  [23 * 3600_000, '23h left'],
  [24 * 3600_000, '1d left'],
  [0, 'now'],
  [-1000, 'now'],
])('says %i ms remaining as %s', (ms, words) => {
  expect(left(new Date(now + ms).toISOString(), now)).toBe(words)
})

it.each([
  ['40-digit hex', '0123456789abcdef'.repeat(2) + '01234567', '0123456'],
  ['64-digit hex', 'ABCDEF01'.repeat(8), 'ABCDEF0'],
  ['non-hex', 'z'.repeat(40), 'z'.repeat(40)],
  ['short hex', 'abcdef0', 'abcdef0'],
  ['hex of another length', 'deadbeef', 'deadbeef'],
])('formats a %s commit value without abbreviating other IDs', (_kind, value, words) => {
  expect(shortSha(value)).toBe(words)
})
