import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { board, BoardError, type Board } from '@vercel/board'
import { redactTrace } from './redact.ts'

const usage = 'usage: swarm trace attach <task-id> --kind transcript|log|ci --file PATH [--source URL] [--board URL]'
const kinds = new Set(['transcript', 'log', 'ci'])

function misuse(message: string): number {
  console.error(`error: ${message}`)
  console.error(usage)
  return 2
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

export async function attachCommand(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || (argv[0] === 'attach' && argv[1] === '--help')) {
    console.log(usage)
    return 0
  }
  if (argv[0] !== 'attach') return misuse('expected trace attach')
  let kind: string | undefined
  let file: string | undefined
  let source: string | undefined
  let boardUrl: string | undefined
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        kind: { type: 'string' },
        file: { type: 'string' },
        source: { type: 'string' },
        board: { type: 'string' },
      },
    })
    kind = parsed.values.kind
    file = parsed.values.file
    source = parsed.values.source
    boardUrl = parsed.values.board
    positionals = parsed.positionals
  } catch {
    return misuse('invalid trace attach arguments')
  }
  const id = positionals[0]
  if (positionals.length !== 1 || !id || !/^[1-9][0-9]*$/.test(id)) return misuse('expected a task id')
  if (!kind || !kinds.has(kind)) return misuse('expected --kind transcript|log|ci')
  const path = file?.trim() ?? ''
  if (!path) return misuse('expected --file PATH')
  const url = boardUrl?.trim()
  if (boardUrl !== undefined && (!url || !/^https?:\/\/[^/\s]+/i.test(url))) return misuse('expected --board URL')
  const origin = source?.trim()
  if (source !== undefined && (!origin || origin.length > 256 || !/^https?:\/\/\S+$/i.test(origin))) return misuse('expected --source URL')
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    console.error('error: no such file')
    return 1
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    console.error('error: file is not utf-8 text')
    return 1
  }
  const redacted = redactTrace(text)
  let team: Board
  try {
    team = openBoard(url)
  } catch {
    return misuse('expected --board URL')
  }
  try {
    const thread = await team.thread(id)
    if (!thread.message.task) {
      console.error('error: not a task')
      return 1
    }
    const name = basename(path)
    const attachment = await team.upload({ data: new Uint8Array(Buffer.from(redacted, 'utf8')), name })
    const message = await team.reply(id, {
      text: name,
      labels: { 'trace.kind': kind, ...(origin ? { 'trace.source': origin } : {}) },
      attachments: [attachment],
    })
    console.log(`attached  ${message.id}  ${kind}  ${name}`)
    return 0
  } catch (error) {
    if (error instanceof BoardError && error.status === 404) {
      console.error('error: no such task')
      return 1
    }
    if (error instanceof BoardError) {
      console.error('error: board unavailable')
      return 1
    }
    throw error
  }
}
