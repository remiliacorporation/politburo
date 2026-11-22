// fileFormat is the design-doc stand-in for the exact Tigeryard format from WP-104.
// A ref mapping round-trips as canonical JSON; a string round-trips unchanged.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Board } from '@vercel/board'
import { parseDocument, stringify } from 'yaml'
import { createInbox } from './inbox.ts'
import { MAIL_LABELS, MAIL_SCHEMA, MAIL_STATES, MailError, validateMessage, type MailMessage } from './message.ts'
import { sendMail } from './send.ts'

const originLabel = 'swarm.origin'
const schema = { schema: 'core' } as const
const mapping = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype

function canonical(value: unknown): string {
  if (mapping(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return JSON.stringify(value)
}

const fileFormat = {
  extension: '.md',
  parse(text: string) {
    const header = /^[^\r\n]*\r?\n(?:[ \t]*\r?\n)*```yaml[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/m.exec(text)
    if (!header || header.index !== 0) throw new MailError('invalid_header')
    const doc = parseDocument(header[1]!, schema)
    if (doc.errors.length || doc.warnings.length) throw new MailError('invalid_yaml')
    if (doc.get('origin') === 'board') return null
    const data: unknown = doc.toJS({ maxAliasCount: 0 })
    if (!mapping(data)) throw new MailError('invalid_message')
    if (mapping(data.ref)) data.ref = canonical(data.ref)
    return data
  },
  render(message: MailMessage) {
    const summary = message.summary.replace(/[\r\n\u2028\u2029]+/g, ' ')
    return `${summary}\n\`\`\`yaml\n${stringify({ ...message, origin: 'board' }, { ...schema, lineWidth: 0 })}\`\`\`\n`
  },
}

export type BridgeOptions = {
  board: Pick<Board, 'channel' | 'label' | 'post' | 'reply' | 'threads'>
  inbox: string
  outbox: string
  // The caller's board scope. The channels identify the mailbox; imported keys use the file tag.
  scope: string
  dir: string
  tag: string
  now: () => Date
}

type Rejection = { file: string; problems: string[] }

export function isSafeMailSegment(value: string) {
  return !!value && !value.startsWith('.') && !/[^a-zA-Z0-9._-]/.test(value)
}

const hasCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code

async function stat(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (!hasCode(error, 'ENOENT')) throw error
  })
}

async function readRegular(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new MailError('not_regular_file')
    return await file.readFile()
  } finally {
    await file.close()
  }
}

async function publish(dir: string, file: string, content: string) {
  const path = join(dir, file)
  const bytes = Buffer.from(content)
  async function existing() {
    const entry = await stat(path)
    if (!entry) return undefined
    if (!entry.isFile()) return 'conflict'
    try {
      return bytes.equals(await readRegular(path)) ? 'skipped' : 'conflict'
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined
      if (hasCode(error, 'ELOOP') || error instanceof MailError) return 'conflict'
      throw error
    }
  }
  const prior = await existing()
  if (prior) return prior
  const temp = join(dir, `.mail-${randomUUID()}`)
  const ready = `${temp}.ready`
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    await rename(temp, ready)
    // Node's rename replaces the destination. Publish the complete staged file
    // with an atomic no-clobber link instead, even if another writer just won.
    for (;;) {
      try {
        await link(ready, path)
        return 'exported'
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
        const winner = await existing()
        if (winner) return winner
      }
    }
  } finally {
    for (const dotfile of [temp, ready]) {
      await unlink(dotfile).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error
      })
    }
  }
}

export function createBridge({ board, inbox, outbox, dir, tag, now }: BridgeOptions) {
  if (!isSafeMailSegment(tag)) throw new MailError('invalid_tag')
  const service = createInbox({ board, channel: inbox, now })
  const { state } = MAIL_LABELS
  // Land the origin with the root so a lost post response cannot cause an echo.
  const fileSender: Pick<Board, 'post'> = {
    post: (channel, input) => {
      const post = typeof input === 'string' ? { text: input } : input
      return board.post(channel, { ...post, labels: { ...post.labels, [originLabel]: 'file' } })
    },
  }

  async function directory(side: 'in' | 'out') {
    if (side === 'in') await mkdir(dir, { recursive: true })
    let path = await realpath(dir)
    for (const segment of [tag, side]) {
      path = join(path, segment)
      if (side === 'in') {
        await mkdir(path).catch((error: unknown) => {
          if (!hasCode(error, 'EEXIST')) throw error
        })
      }
      // Never follow a symlink from the configured base to a mailbox.
      if (!(await lstat(path)).isDirectory()) throw new MailError('invalid_mail_directory')
    }
    return path
  }

  return {
    async importOnce() {
      const report = { imported: 0, skipped: 0, rejected: [] as Rejection[] }
      const path = await directory('out').catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error
      })
      if (!path) return report
      for (const file of (await readdir(path)).sort()) {
        if (file.startsWith('.') || !file.endsWith(fileFormat.extension)) {
          report.skipped++
          continue
        }
        let data
        try {
          data = fileFormat.parse((await readRegular(join(path, file))).toString('utf8'))
        } catch (error) {
          const reason = error instanceof MailError ? error.reason : 'unreadable_or_invalid_yaml'
          report.rejected.push({ file, problems: [reason] })
          continue
        }
        if (data === null) {
          report.skipped++
          continue
        }
        const problems = validateMessage(data, { now: now() })
        if (problems.length) {
          report.rejected.push({ file, problems })
          continue
        }
        const message = data as MailMessage
        try {
          await sendMail(fileSender, message.to ? outbox : inbox, message, { scope: tag })
          report.imported++
        } catch (error) {
          if (!(error instanceof MailError)) throw error
          report.rejected.push({ file, problems: [error.reason] })
        }
      }
      return report
    },

    async exportOnce() {
      const report = { exported: 0, skipped: 0, conflicts: [] as string[], rejected: [] as Rejection[] }
      const active = await service.readOpen({ limit: Infinity })
      const openIds = new Set(active.map(({ messageId }) => messageId))
      const path = await directory('in')
      const clock = now()
      for (const status of [MAIL_STATES.open, MAIL_STATES.handled]) {
        let before: string | undefined
        for (;;) {
          const page = await board.threads({ channel: inbox, label: { [state]: status }, limit: 100, before })
          for (const { message: root } of page.threads) {
            if (root.deleted || root.labels[originLabel] === 'file' ||
                (status === MAIL_STATES.open && !openIds.has(root.id))) {
              report.skipped++
              continue
            }
            const [entry] = root.blocks
            if (root.blocks.length !== 1 || !entry || `${entry.schema}@${entry.version}` !== MAIL_SCHEMA ||
                Object.hasOwn(entry.data, 'origin') || validateMessage(entry.data, { now: clock }).length) {
              report.skipped++
              continue
            }
            const message = entry.data as MailMessage
            if (!isSafeMailSegment(message.id)) {
              report.rejected.push({ file: message.id, problems: ['unsafe_id'] })
              continue
            }
            const file = `${message.id}${fileFormat.extension}`
            const result = await publish(path, file, fileFormat.render(message))
            if (result === 'conflict') report.conflicts.push(file)
            else report[result]++
          }
          if (!page.older || page.older === before) break
          before = page.older
        }
      }
      return report
    },
  }
}
