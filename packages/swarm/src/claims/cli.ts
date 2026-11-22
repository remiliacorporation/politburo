import { parseArgs } from 'node:util'
import { BoardError, board } from '@vercel/board'
import { defaultConfig } from '../config/load.ts'
import { claimStatus, type ClaimStatus } from './admission.ts'

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

export async function claimsMain([action, ...flags]: string[]): Promise<number> {
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
    const handle = board()
    const claims = await claimStatus(handle, values.channel, values.party, defaultConfig().claims, Date.now, (await handle.me()).actor)
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
