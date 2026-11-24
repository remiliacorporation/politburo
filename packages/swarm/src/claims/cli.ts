import { parseArgs } from 'node:util'
import { BoardError, board, type Board } from '@vercel/board'
import { cooldown, readHistory } from './records.ts'
import { claimedTasks } from './rule.ts'

type ClaimStatus = { task: string; party: string; cooldownUntil: number | null } & (
  { state: 'claimed'; epoch: number; hardEnd: number; timeLeftMs: number } | { state: 'cooling' }
)

async function claimStatus(board: Board, channel: string, party: string): Promise<ClaimStatus[]> {
  const { actor } = await board.me()
  const at = Date.now()
  const rows: ClaimStatus[] = []
  const seen = new Set<string>()
  async function scan(id: string, live?: { epoch: number; hardEnd: number }) {
    if (seen.has(id)) return
    seen.add(id)
    const until = cooldown(await readHistory(board, id, party, actor))
    const cooldownUntil = until > at ? until : null
    if (live) rows.push({ task: id, party, state: 'claimed', ...live, timeLeftMs: Math.max(0, live.hardEnd - at), cooldownUntil })
    else if (cooldownUntil !== null) rows.push({ task: id, party, state: 'cooling', cooldownUntil })
  }
  for await (const { id, task } of claimedTasks(board, channel, actor)) {
    if (task?.claim?.holdUntil) await scan(id, { epoch: task.epoch, hardEnd: Date.parse(task.claim.holdUntil) })
  }
  let before: string | undefined
  do {
    const page = await board.threads({ channel, label: { 'swarm.kind': 'dock', 'swarm.party': party }, limit: 100, ...(before ? { before } : {}) })
    for (const { message } of page.threads) {
      if (message.channel === channel && message.task) await scan(message.id)
    }
    before = page.older ?? undefined
  } while (before)
  return rows
}

const usage = 'usage: swarm claims status --channel CHANNEL --party PARTY [--json]'

function misuse(message: string): number {
  console.error(`error: ${message}`)
  console.error(usage)
  return 2
}

function printStatus(claims: ClaimStatus[]) {
  if (!claims.length) {
    console.log('no live claims or cooldowns')
    return
  }
  const date = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')
  const rows = [
    ['task', 'state', 'hard end', 'left', 'cooldown until'],
    ...claims.map((claim) => [
      claim.task.replace(/[\x00-\x1f\x7f-\x9f]/g, '?'), claim.state,
      claim.state === 'claimed' ? date(claim.hardEnd) : '-',
      claim.state === 'claimed' ? `${Math.ceil(claim.timeLeftMs / 1000)}s` : '-',
      claim.cooldownUntil === null ? '-' : date(claim.cooldownUntil),
    ]),
  ]
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd())
}

export async function run([action, ...flags]: string[], connect = () => board()): Promise<number> {
  if ((action === '--help' && flags.length === 0) || (action === 'status' && flags.join(' ') === '--help')) {
    console.log(usage)
    return 0
  }
  if (action !== 'status') return misuse('expected claims status')
  let values
  try {
    ;({ values } = parseArgs({ args: flags, options: {
      channel: { type: 'string' }, party: { type: 'string' }, json: { type: 'boolean' },
    } }))
  } catch {
    return misuse('invalid claims status options')
  }
  if (!values.channel?.trim() || !values.party?.trim()) return misuse('specify --channel and --party')
  try {
    const claims = await claimStatus(connect(), values.channel, values.party)
    if (values.json) console.log(JSON.stringify({ claims }))
    else printStatus(claims)
    return 0
  } catch (error) {
    if (error instanceof BoardError && ['no_board', 'no_token', 'not_logged_in'].includes(error.code)) {
      console.error('error: no board to read; check board configuration and sign-in')
      return 2
    }
    const status = error instanceof BoardError && error.status > 0 ? ` (board status ${error.status})` : ''
    console.error(`error: cannot read claim status${status}`)
    return 1
  }
}
