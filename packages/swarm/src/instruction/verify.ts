import { parseArgs } from 'node:util'
import { board, BoardError, type Board } from '@vercel/board'

const usage = 'usage: swarm instruction verify <message-id> --from <handle> [--board URL]'

type Authored = {
  id: string
  author: { kind: string; handle: string; verified?: true } | null
}

function misuse(message: string): number {
  console.error(`error: ${message}`)
  console.error(usage)
  return 2
}

function say(reason: string): number {
  console.log(reason)
  return reason === 'verified' ? 0 : 1
}

function openBoard(url: string | undefined): Board {
  if (url === undefined) return board()
  const previous = process.env.BOARD_URL
  process.env.BOARD_URL = url.replace(/\/+$/, '')
  try {
    return board()
  } finally {
    if (previous === undefined) delete process.env.BOARD_URL
    else process.env.BOARD_URL = previous
  }
}

/** Why this message is not an instruction from `from`, or null when its verified author is that person. */
export function instructionReason(message: Authored | null, from: string): string | null {
  if (!message) return 'no such message'
  const author = message.author
  if (!author || author.verified !== true) return 'author is not verified'
  if (author.kind !== 'person') return `author is ${author.kind === 'agent' ? 'an' : 'a'} ${author.kind}, not a person`
  if (author.handle !== from) return `author is ${author.handle}, not ${from}`
  return null
}

function messageIn(thread: { message: Authored; replies: Authored[] }, id: string): Authored | null {
  if (thread.message.id === id) return thread.message
  return thread.replies.find((reply) => reply.id === id) ?? null
}

export async function instructionCommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv
  if (action === '--help' || (action === 'verify' && rest.length === 1 && rest[0] === '--help')) {
    console.log(usage)
    return 0
  }
  if (action !== 'verify') return misuse('expected instruction verify')
  let from: string | undefined
  let boardUrl: string | undefined
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { from: { type: 'string' }, board: { type: 'string' } },
    })
    from = parsed.values.from
    boardUrl = parsed.values.board
    positionals = parsed.positionals
  } catch {
    return misuse('invalid instruction verify arguments')
  }
  const id = positionals[0]
  if (positionals.length !== 1 || !id || !/^[1-9][0-9]*$/.test(id)) return misuse('expected a message id')
  const handle = from?.trim().replace(/^@/, '') ?? ''
  if (!handle || /\s/.test(handle)) return misuse('expected --from <handle>')
  const url = boardUrl?.trim()
  if (boardUrl !== undefined && (!url || !/^https?:\/\/[^/\s]+/i.test(url))) return misuse('expected --board URL')
  let team: Board
  try {
    team = openBoard(url)
  } catch {
    return misuse('expected --board URL')
  }
  try {
    const thread = await team.thread(id)
    const reason = instructionReason(messageIn(thread, id), handle)
    return say(reason ?? 'verified')
  } catch (error) {
    if (error instanceof BoardError && error.status === 404) return say('no such message')
    if (error instanceof BoardError) return say('board unavailable')
    throw error
  }
}
