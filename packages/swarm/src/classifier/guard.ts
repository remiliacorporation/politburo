export type State = { excerpt: string; source_kind: string; fields: Record<string, string> }

// A structural floor, not the privacy design: callers send only approved excerpts.
export const unsafeText = /```|~~~|diff --git|^\s*@@ |-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|authorization\s*:\s*bearer\b|\bsk-[\w-]+|api_key\s*=/im
export const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w./:-]{1,200}$/.test(value) && !unsafeText.test(value)

export function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function entries(value: unknown, max: number): [string, unknown][] | undefined {
  if (!plainObject(value)) return
  const keys = Reflect.ownKeys(value)
  if (keys.length > max) return
  const result: [string, unknown][] = []
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return
    result.push([key, descriptor.value])
  }
  return result
}

export function guardState(value: unknown): State | undefined {
  const shape = entries(value, 3)
  if (shape?.length !== 3) return
  const { excerpt, source_kind, fields } = Object.fromEntries(shape)
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !unsafeText.test(v)
  if (!text(excerpt, 600) || !text(source_kind, 80)) return
  const pairs = entries(fields, 8)
  if (!pairs || !pairs.every((pair): pair is [string, string] => text(pair[0], 80) && text(pair[1], 120))) return
  return { excerpt, source_kind, fields: Object.fromEntries(pairs) }
}
