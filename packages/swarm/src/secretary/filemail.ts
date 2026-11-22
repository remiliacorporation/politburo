import { constants } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import defaults from '../config/defaults.json' with { type: 'json' }
import { parseHeader, type HeaderResult } from './message.ts'

export type FileMailItem = { file: string; receivedAt: number; result: HeaderResult }

const maxBytes = 64 * 1024

function parseMail(text: string, opts: { classes: string[] }): HeaderResult {
  const header = /^[^\n]+\n(?:[ \t]*\r?\n)*```yaml[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/m
  const match = header.exec(text)
  if (!match || match.index !== 0) return { ok: false, reason: 'no_header' }
  if (/^```yaml[ \t]*\r?$/m.test(text.slice(match[0].length))) return { ok: false, reason: 'bad_yaml' }
  try {
    const doc = parseDocument(match[1]!)
    if (doc.errors.length || doc.warnings.length) return { ok: false, reason: 'bad_yaml' }
    return parseHeader(doc.toJS({ maxAliasCount: 0 }), opts)
  } catch {
    return { ok: false, reason: 'bad_yaml' }
  }
}

// Keep knowledge of the mailbox path layout here.
export function fileMailTag(file: string): string {
  return basename(dirname(file)) === 'inbox' ? basename(dirname(dirname(file))) : 'unknown'
}

export async function readFileMail(
  mailDir: string, tag: string, opts = { classes: defaults.mail.classes },
): Promise<FileMailItem[]> {
  if (!tag || tag !== basename(tag) || tag === '.' || tag === '..') throw new Error('bad_tag')
  const dir = resolve(mailDir, tag, 'inbox')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const items: FileMailItem[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    const file = join(dir, entry.name)
    let receivedAt = 0
    let result: HeaderResult = { ok: false, reason: 'not_a_file' }
    if (entry.isFile()) {
      try {
        const info = await stat(file)
        receivedAt = info.mtimeMs
        if (info.isFile()) {
          if (info.size > maxBytes) {
            result = { ok: false, reason: 'oversize' }
          } else {
            const bytes = await readFile(file, { flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK })
            result = bytes.length > maxBytes
              ? { ok: false, reason: 'oversize' }
              : parseMail(bytes.toString('utf8'), opts)
          }
        }
      } catch {
        result = { ok: false, reason: 'unreadable_file' }
      }
    }
    items.push({ file, receivedAt, result })
  }
  return items.sort(compareReceipt)
}

export function compareReceipt(a: Pick<FileMailItem, 'file' | 'receivedAt'>, b: typeof a): number {
  return a.receivedAt - b.receivedAt || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
}
