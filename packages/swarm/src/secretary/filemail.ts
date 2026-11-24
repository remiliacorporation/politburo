import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import defaults from '../config/defaults.json' with { type: 'json' }
import { parseHeader, type HeaderResult } from './message.ts'
import { redact } from './redact.ts'

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
    const raw = doc.toJS({ maxAliasCount: 0 })
    const result = parseHeader(raw, opts)
    // A rejected file can still claim a sender. This is not authenticated provenance.
    const from: unknown = !result.ok && isMap(doc.contents) && Object.hasOwn(raw, 'from') ? raw.from : undefined
    return !result.ok && typeof from === 'string' && from
      ? { ...result, from: [...redact(from)].slice(0, 200).join('') } : result
  } catch {
    return { ok: false, reason: 'bad_yaml' }
  }
}

function decodeMail(bytes: Uint8Array, opts: { classes: string[] }): HeaderResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'bad_encoding' }
  }
  return parseMail(text, opts)
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
  let realDir: string
  let entries
  try {
    const root = await realpath(mailDir)
    realDir = await realpath(dir)
    const subpath = relative(root, realDir)
    if (!subpath || subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) throw new Error('symlink')
    entries = await readdir(realDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const items: FileMailItem[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    const file = join(dir, entry.name)
    let receivedAt = 0
    let result: HeaderResult = { ok: false, reason: 'symlink' }
    if (entry.isFile()) {
      try {
        const handle = await open(join(realDir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await handle.stat()
          receivedAt = info.mtimeMs
          if (info.isFile()) {
            const bytes = Buffer.alloc(maxBytes + 1)
            let size = 0
            while (size < bytes.length) {
              const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null)
              if (!bytesRead) break
              size += bytesRead
            }
            result = size > maxBytes ? { ok: false, reason: 'oversize' } : decodeMail(bytes.subarray(0, size), opts)
          }
        } finally {
          await handle.close()
        }
      } catch (error) {
        result = { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'symlink' : 'unreadable_file' }
      }
    }
    items.push({ file, receivedAt, result })
  }
  return items.sort(compareReceipt)
}

export function compareReceipt(a: Pick<FileMailItem, 'file' | 'receivedAt'>, b: typeof a): number {
  return a.receivedAt - b.receivedAt || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
}
