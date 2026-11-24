import { isDeepStrictEqual } from 'node:util'
import schema from '../config/schema.json' with { type: 'json' }
import { checkMailbox, InputError, type MailPort } from './mail-port.ts'

// Reader groups from design/swarm-party-config.md, including the field table.
const readerPaths = {
  dispatch: [['tiers', 'models', 'sprite'], ['setup']],
  mail: [['mail'], ['secretary']],
  claims: [['claims'], ['review']],
  watch: [['trackers']],
  ui: [['party', 'name'], ['party', 'colour'], ['names']],
} satisfies Record<string, string[][]>

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

type Shape = { [keyword: string]: unknown; properties?: Record<string, Shape>; $ref?: string; then?: Shape; patternProperties?: object }
type Change = { path: string[]; unknown?: boolean }
const definitions: Record<string, Shape> = schema.definitions

function changes(previous: unknown, next: unknown): Change[] {
  const found: Change[] = []
  function visit(left: unknown, right: unknown, path: string[], shape: Shape, collapsed = false) {
    if (!collapsed && isDeepStrictEqual(left, right)) return
    if (shape.$ref) shape = definitions[shape.$ref.split('/').at(-1)!]!
    const fields = shape.properties ?? shape.then?.properties
    const a = isConfigObject(left) ? left : undefined
    const b = isConfigObject(right) ? right : undefined
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
    if (shape.patternProperties || !keys.size) {
      found.push({ path })
      return
    }
    // Keep the parent path on type changes, but still check the object for unknown keys.
    collapsed ||= (!a && left !== undefined) || (!b && right !== undefined)
    for (const key of keys) {
      const child = /^[a-z][a-z0-9_]*$/.test(key) && fields && Object.hasOwn(fields, key) ? fields[key] : undefined
      const l = a && Object.hasOwn(a, key) ? a[key] : undefined
      const r = b && Object.hasOwn(b, key) ? b[key] : undefined
      if (child) visit(l, r, collapsed ? path : [...path, key], child, collapsed)
      else if (collapsed || !isDeepStrictEqual(l, r)) found.push({ path, unknown: true })
    }
  }
  visit(previous, next, [], schema)
  return found
}

type Readers = Record<string, unknown>
const isPrefix = (prefix: string[], path: string[]) => prefix.every((key, i) => key === path[i])

export function planNotices(previous: unknown, next: unknown, readers: Readers) {
  const entries = Object.entries(readers).map(([reader, mailbox]) => {
    if (!Object.hasOwn(readerPaths, reader)) throw new InputError(`unrecognized reader name ${JSON.stringify(reader)}`)
    checkMailbox(mailbox)
    return [reader, mailbox] as const
  })
  const affected = new Set<string>()
  const paths = new Set<string>()
  for (const { path, unknown } of changes(previous, next)) {
    if (path.length) paths.add(path.join('.'))
    const matches = unknown ? [] : Object.entries(readerPaths).filter(([, prefixes]) =>
      prefixes.some((prefix) => isPrefix(prefix, path) || isPrefix(path, prefix)))
    for (const [reader, mailbox] of entries) {
      if (!matches.length || matches.some(([name]) => name === reader)) affected.add(mailbox)
    }
  }
  return { paths: [...paths].sort(), affected: [...affected].sort() }
}

export function policyId(mailbox: string, version: number, record = 'party'): string {
  return `policy:${mailbox}:${record}:v${version}`
}

export async function policyNotices({ version, record = 'party', previous, next, mailboxes, mail }: {
  version: number; record?: string; previous: unknown; next: unknown; mailboxes: Readers; mail: MailPort
}): Promise<{ sent: string[]; skipped: string[] }> {
  const { paths, affected } = planNotices(previous, next, mailboxes)
  const sent: string[] = [], skipped: string[] = []
  for (const mailbox of affected) {
    const id = policyId(mailbox, version, record)
    const { landed } = await mail.post({
      id, mailbox, class: 'policy', urgency: 'p1',
      block: { schema: 'swarm-policy@1', data: { record, version, changed_paths: paths } },
      text: `config ${record} v${version} changed: ${paths.join(', ') || 'unspecified fields'}. fetch this committed record from the config thread on the party board.`,
    })
    ;(landed === 'new' ? sent : skipped).push(id)
  }
  return { sent, skipped }
}
