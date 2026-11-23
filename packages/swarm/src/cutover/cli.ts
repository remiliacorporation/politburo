import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CommandPorts } from './commands.ts'
import { apply, plan, rollback, type Context } from './cutover.ts'
import { runMail } from './mail-send.ts'
import { currentTag, CutoverError, newTag } from './ports.ts'
import { runQuery } from './queries.ts'

const usage = 'usage: swarm cutover <plan|apply|rollback|soak|acks> <tag> [flags]'

export async function run([action, ...rest]: string[], command = 'cutover'): Promise<number> {
  if (command === 'mail') return runMail(action, rest)
  const [tag, ...args] = rest
  if (action === 'soak' || action === 'acks') return runQuery(action, tag, args)
  if (action === '--help' && tag === undefined) { console.log(usage); return 0 }
  const string = { type: 'string' } as const, boolean = { type: 'boolean' } as const
  const options = { execute: boolean, gate: string, 'rename-to': string, rollback: boolean,
    'budget-seconds': string, 'gate-max-age-days': string, 'state-dir': string, commands: string, json: boolean,
    'allow-stale': boolean }
  let json = false
  const fail = (error: CutoverError, code: number) => {
    if (json) console.log(JSON.stringify({ reason: error.reason, headline: error.headline }))
    else console.error(`error: ${error.headline}`)
    return code
  }
  const controller = new AbortController()
  try {
    const { values: v } = parseArgs({ args, options })
    json = v.json ?? false
    if (!tag || !currentTag.test(tag) || (action !== 'plan' && action !== 'apply' && action !== 'rollback')) {
      return fail(new CutoverError('usage', usage), 2)
    }
    const budgetMs = Number(v['budget-seconds'] ?? 300) * 1000
    const gateMaxAgeDays = Number(v['gate-max-age-days'] ?? 14)
    if (!(budgetMs > 0 && budgetMs <= 2_147_483_647) || !Number.isFinite(gateMaxAgeDays) ||
        gateMaxAgeDays < 0 || v['gate-max-age-days'] === '' || (v.rollback && action !== 'plan') ||
        (v['rename-to'] !== undefined && !newTag.test(v['rename-to'])) ||
        (v['allow-stale'] && (action !== 'rollback' || !v.execute))) {
      return fail(new CutoverError('usage', 'invalid cutover flags'), 2)
    }
    const execute = action !== 'plan' && v.execute
    if (execute && action === 'apply' && !v.gate) throw new CutoverError('gate_missing', 'a gate decision file is required (--gate)')
    if (execute && v.commands === undefined) throw new CutoverError('no_commands', 'execution requires --commands')
    const ctx: Context = { ports: await CommandPorts(tag, v.commands, controller.signal), clock: Date,
      stateDir: v['state-dir'] ?? join(homedir(), '.swarm', 'cutover'), budgetMs, gateMaxAgeDays,
      gateFile: v.gate, renameTo: v['rename-to'], rollback: action === 'rollback' || v.rollback,
      allowStale: v['allow-stale'] }
    if (execute) {
      const result = await (action === 'rollback' ? rollback : apply)(tag, ctx)
      console.log(json ? JSON.stringify(result) : `${result.message}  ${result.elapsedMs} ms`)
    } else {
      const steps = await plan(tag, ctx), dryRun = action !== 'plan'
      if (json) console.log(JSON.stringify({ dryRun, ...(dryRun && { message: 'dry run' }), steps }))
      else {
        if (dryRun) console.log('dry run')
        for (const s of steps) console.log(`${s.do ? 'do  ' : 'skip'}  ${s.step}  ${s.why}`)
      }
    }
    return 0
  } catch (error) {
    if (error instanceof CutoverError) return fail(error, 1)
    return (error as NodeJS.ErrnoException)?.code?.startsWith('ERR_PARSE_ARGS')
      ? fail(new CutoverError('usage', 'invalid cutover flags'), 2)
      : fail(new CutoverError('cutover_failed', 'cutover failed'), 1)
  } finally { controller.abort() }
}
