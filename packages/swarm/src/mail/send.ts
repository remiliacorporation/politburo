import { block, type Board } from '@vercel/board'
import { MAIL_SCHEMA, MailError, validateMessage, type MailMessage } from './message.ts'

export async function sendMail(board: Pick<Board, 'post'>, channel: string, message: MailMessage, { scope }: { scope: string }) {
  const problems = validateMessage(message, { now: new Date() })
  if (problems.length) throw new MailError(problems[0]!, problems.join(', '))
  if (!scope.trim() || scope.includes(':') || scope.includes('\0') || !scope.isWellFormed()) {
    throw new MailError('invalid_scope')
  }

  // Scope namespaces sender IDs when mailboxes share a board; reserve ':' as its delimiter.
  return postMail(board, channel, message, `mail:${scope}:${message.id}`)
}

type MailRoot = Awaited<ReturnType<Board['post']>>

export function mailBlock({ blocks }: Pick<MailRoot, 'blocks'>) {
  const [entry] = blocks
  return blocks.length === 1 && entry?.schema === 'swarm-message' && entry.version === 1 ? entry : undefined
}

export function matchesMailBlock(root: Pick<MailRoot, 'blocks'>, message: MailMessage) {
  const entry = mailBlock(root)
  const entries = Object.entries(message)
  return entry !== undefined && Object.keys(entry.data).length === entries.length &&
    entries.every(([key, value]) => entry.data[key] === value)
}

export async function postMail(
  board: Pick<Board, 'post'>, channel: string, message: MailMessage, id: string, labels?: Record<string, string>,
) {
  const landed = await board.post(channel, { id, text: block(MAIL_SCHEMA, message), ...(labels && { labels }) }).catch((error: unknown) => {
    if (boardConflict(error, 'duplicate_id')) throw new MailError('id_collision')
    throw error
  })
  if (!matchesMailBlock(landed, message)) throw new MailError('id_collision')
  return landed
}

export function boardConflict(error: unknown, code: string) {
  return error !== null && typeof error === 'object' &&
    'status' in error && error.status === 409 && 'code' in error && error.code === code
}
