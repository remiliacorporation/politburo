import { createHash } from 'node:crypto'

function stableStringify(parts: unknown[]): string {
  return JSON.stringify(parts, (_, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((name) => [name, record[name]]))
  })
}

export function hashKey(...parts: unknown[]): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex')
}
