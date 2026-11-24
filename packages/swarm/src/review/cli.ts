import { parseArgs } from 'node:util'
import { board, BoardError, type Board } from '@vercel/board'
import { recordReview, type ReviewVerdict } from './record.ts'

const usage = 'usage: swarm review record <task-id> <pass|blocked> --head <sha> [--finding TEXT]... [--follow-up] [--board URL]'

function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function misuse(message: string): number {
  console.error(`error: ${safe(message)}`)
  console.error(usage)
  return 2
}

function fail(message: string): number {
  console.error(`error: ${safe(message)}`)
  return 1
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

const shaOf = (value: string | undefined) => {
  const sha = value?.trim().toLowerCase() ?? ''
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null
}

const taskIdOf = (value: string | undefined) => {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? value : null
}

export async function reviewCommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv
  if (action === '--help' || (action === 'record' && rest.length === 1 && rest[0] === '--help')) {
    console.log(usage)
    return 0
  }
  if (action !== 'record') return misuse('expected review record')
  let values: { head?: string; finding?: string[]; 'follow-up'?: boolean; board?: string }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        head: { type: 'string' },
        finding: { type: 'string', multiple: true },
        'follow-up': { type: 'boolean' },
        board: { type: 'string' },
      },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
  }
  if (positionals.length !== 2) return misuse('expected a task id and pass or blocked')
  const taskId = taskIdOf(positionals[0])
  if (taskId === null) return misuse('expected a task id')
  const verdict = positionals[1]
  if (verdict !== 'pass' && verdict !== 'blocked') return misuse('expected pass or blocked')
  const head = shaOf(values.head)
  if (head === null) return misuse('expected --head to be a 40 or 64 character hex sha')
  const findings = values.finding ?? []
  if (findings.some((text) => text.trim() === '' || /[\r\n]/.test(text) || text.length > 4000)) {
    return misuse('a finding is one non-empty line')
  }
  const boardUrl = values.board?.trim()
  if (values.board !== undefined && (boardUrl === undefined || boardUrl === '' || !/^https?:\/\/[^/\s]+/i.test(boardUrl))) {
    return misuse('expected --board URL')
  }
  let team: Board
  try {
    team = openBoard(boardUrl === '' ? undefined : boardUrl)
  } catch (error) {
    if (error instanceof BoardError && error.code === 'no_board') return misuse('no board to use')
    throw error
  }
  try {
    const recorded = await recordReview(team, {
      taskId, verdict: verdict as ReviewVerdict, head, findings, followUp: values['follow-up'] === true,
    })
    const rows: [string, string][] = [['recorded', recorded.verdict], ['head', recorded.head]]
    for (const followUp of recorded.followUps) rows.push(['follow-up', followUp.id])
    const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0)
    for (const [key, value] of rows) console.log(`${key.padEnd(width)}  ${value}`)
    return 0
  } catch (error) {
    if (error instanceof BoardError) {
      if (error.status === 404 || error.code === 'not_found') return fail('no such task')
      if (error.code === 'not_a_task') return fail('not a live task')
      return fail('board refused the review record')
    }
    throw error
  }
}
