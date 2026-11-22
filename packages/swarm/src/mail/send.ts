import { block, type Board } from '@vercel/board'
import { MAIL_SCHEMA, MailError, validateMessage, type MailMessage } from './message.ts'

export async function sendMail(board: Pick<Board, 'post'>, channel: string, message: MailMessage, { scope }: { scope: string }) {
  const problems = validateMessage(message, { now: new Date() })
  if (problems.length) throw new MailError(problems[0]!, problems.join(', '))
  if (!scope.trim() || scope.includes(':') || scope.includes('\0') || !scope.isWellFormed()) {
    throw new MailError('invalid_scope')
  }

  // Scope namespaces sender IDs when mailboxes share a board; reserve ':' as its delimiter.
  const id = `mail:${scope}:${message.id}`
  const landed = await board.post(channel, { id, text: block(MAIL_SCHEMA, message) }).catch((error: unknown) => {
    if (boardConflict(error, 'duplicate_id')) throw new MailError('id_collision')
    throw error
  })
  const [entry] = landed.blocks
  const entries = Object.entries(message)
  if (landed.blocks.length !== 1 || entry?.schema !== 'swarm-message' || entry.version !== 1 ||
      Object.keys(entry.data).length !== entries.length || !entries.every(([key, value]) => entry.data[key] === value)) {
    throw new MailError('id_collision')
  }
  return landed
}

export function boardConflict(error: unknown, code: string) {
  return error !== null && typeof error === 'object' &&
    'status' in error && error.status === 409 && 'code' in error && error.code === code
}
