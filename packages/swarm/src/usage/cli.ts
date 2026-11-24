import { parseArgs } from 'node:util'
import { localUsage } from '@remilia/politburo-runtime'
import { stopGuard, validTimestamp } from './guard.ts'
import { readWakeState } from './wake.ts'

function misuse(message: string): number {
  console.error(`error: ${message}`)
  return 2
}

export async function run(argv: string[]): Promise<number> {
  const [action, ...args] = argv
  if (action === 'wake') {
    let path: string | undefined
    try {
      path = parseArgs({ args, options: { state: { type: 'string' } } }).values.state
    } catch {
      return misuse('usage: swarm usage wake --state FILE')
    }
    if (!path) return misuse('missing --state file')
    try {
      const state = readWakeState(path)
      console.log(!state ? 'none' : state.firedAt !== undefined ? 'fired'
        : `armed for ${validTimestamp(state.resetAt) ? new Date(state.resetAt).toISOString() : state.resetAt}`)
      return 0
    } catch {
      console.error('error: cannot read reset wake state')
      return 1
    }
  }
  if (action !== 'check') return misuse('usage: swarm usage <check|wake>')

  let guard: ReturnType<typeof stopGuard>
  let json: boolean | undefined
  try {
    const { values } = parseArgs({ args, options: {
      usage: { type: 'string' }, 'stop-percent': { type: 'string' }, json: { type: 'boolean' },
    } })
    if (!values.usage) return misuse('missing --usage file')
    json = values.json
    const percent = values['stop-percent']
    if (percent?.trim() === '') return misuse('missing stop percent')
    guard = stopGuard({ source: localUsage({ file: values.usage }),
      stopPercent: percent === undefined ? 100 : Number(percent) })
  } catch (error) {
    return misuse(error instanceof RangeError ? error.message
      : 'usage: swarm usage check --usage FILE [--stop-percent N] [--json]')
  }

  try {
    const decision = await guard.check()
    console.log(json ? JSON.stringify(decision) : decision.allowed ? 'allowed'
      : `refused until ${new Date(decision.resetAt).toISOString()}`)
    return decision.allowed ? 0 : 1
  } catch {
    const error = 'cannot read usage window'
    if (json) console.log(JSON.stringify({ error }))
    else console.error(`error: ${error}`)
    return 1
  }
}
