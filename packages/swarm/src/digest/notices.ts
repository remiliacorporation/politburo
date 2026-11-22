import { appendFile, readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { MailPort } from './mail-port.ts'

// The five reader groups in the party config table, keyed by mailbox-map name.
const readerPaths = {
  dispatch: ['tiers.shares', 'tiers.models.core', 'tiers.models.spawner', 'tiers.models.mob', 'tiers.models.sprite', 'limits', 'setup'],
  mail: ['mail', 'secretary', 'tiers.models.adviser', 'tiers.models.classifier'],
  claims: ['claims', 'review'],
  watch: ['heartbeat_minutes', 'trackers'],
  ui: ['party.name', 'party.colour', 'labels', 'names'],
} as const

type Readers = Record<string, string>

export function affectedMailboxes(changed: string[], readers: Readers): string[] {
  const affected = new Set<string>()
  for (const path of changed) {
    const matches = Object.entries(readerPaths).filter(([, prefixes]) =>
      prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))
    if (!matches.length) return [...new Set(Object.values(readers))].sort()
    for (const [reader] of matches) if (Object.hasOwn(readers, reader)) affected.add(readers[reader]!)
  }
  return [...affected].sort()
}

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function changedPaths(previous: unknown, next: unknown): string[] {
  const paths = new Set<string>()
  function visit(left: unknown, right: unknown, path: string) {
    if (isDeepStrictEqual(left, right)) return
    const a = isConfigObject(left) ? left : undefined
    const b = isConfigObject(right) ? right : undefined
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
    if (!keys.size || (!a && left !== undefined) || (!b && right !== undefined)) paths.add(path)
    for (const key of keys) {
      visit(a && Object.hasOwn(a, key) ? a[key] : undefined,
        b && Object.hasOwn(b, key) ? b[key] : undefined, path ? `${path}.${key}` : key)
    }
  }
  visit(previous, next, '')
  return [...paths].sort()
}

export function policyId(mailbox: string, version: number): string {
  return `policy:${mailbox}:v${version}`
}

export async function readSent(path?: string) {
  const ids = new Set<string>()
  let text = ''
  if (path) {
    try { text = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry?.id === 'string' && typeof entry.at === 'string') ids.add(entry.id)
    } catch { /* A torn record is a cache miss; the port still deduplicates. */ }
  }
  return { ids, needsNewline: !!text && !text.endsWith('\n') }
}

export async function policyNotices({ version, previous, next, mailboxes, mail, sentPath, now = () => new Date() }: {
  version: number; previous: unknown; next: unknown; mailboxes: Readers; mail: MailPort
  sentPath?: string; now?: () => Date
}): Promise<{ sent: string[]; skipped: string[] }> {
  const paths = changedPaths(previous, next)
  const recorded = await readSent(sentPath)
  const sent: string[] = [], skipped: string[] = []
  for (const mailbox of affectedMailboxes(paths, mailboxes)) {
    const id = policyId(mailbox, version)
    if (recorded.ids.has(id)) { skipped.push(id); continue }
    const { landed } = await mail.post({
      id, mailbox, class: 'policy', urgency: 'p1',
      block: { schema: 'swarm-policy@1', data: { version, changed_paths: paths } },
      text: `party config v${version} changed: ${paths.join(', ')}. fetch the committed version from the config thread on the party board.`,
    })
    if (sentPath) {
      const line = JSON.stringify({ id, at: now().toISOString() })
      await appendFile(sentPath, `${recorded.needsNewline ? '\n' : ''}${line}\n`, { flush: true })
      recorded.needsNewline = false
    }
    ;(landed === 'new' ? sent : skipped).push(id)
  }
  return { sent, skipped }
}
