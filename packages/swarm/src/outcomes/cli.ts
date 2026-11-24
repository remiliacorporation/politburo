import { parseArgs } from 'node:util'
import { board, BoardError, type Board } from '@vercel/board'
import { completeOutcome, outcomeContract, outcomeWorkId, reviewOutcome, submitOutcome } from './service.ts'

type IO = { log(line: string): void; error(line: string): void; board?: Board; jockeys?: readonly string[] }
const options = {
  submit: ['task', 'kind', 'path', 'sha256', 'party', 'attempt', 'root', 'index'],
  review: ['task', 'decision', 'reason'],
  complete: ['task', 'reviewer', 'validators', 'party', 'attempt', 'root'],
} as const
const required = {
  submit: ['task', 'kind', 'path', 'sha256', 'party', 'attempt'], review: ['task', 'decision'], complete: ['task', 'validators', 'party', 'attempt'],
} as const
const usage = 'usage: swarm outcome <submit|review|complete> --task ID [--json]'

export async function outcomeCommand([action, ...args]: string[], io: IO): Promise<number> {
  const json = args.includes('--json')
  const fail = (reason: string, message: string, code: number) => {
    if (json) io.log(JSON.stringify({ reason, message }))
    else io.error(`error: ${message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`)
    return code
  }
  if ((action === '--help' && !args.length) || (args.length === 1 && args[0] === '--help' && action && Object.hasOwn(options, action))) {
    io.log(action === '--help' ? usage : `usage: swarm outcome ${action} ${options[action as keyof typeof options].map((key) =>
      (required[action as keyof typeof required] as readonly string[]).includes(key) ? `--${key} VALUE` : `[--${key} VALUE]`,
    ).join(' ')} [--json]`)
    return 0
  }
  if (action !== 'submit' && action !== 'review' && action !== 'complete') return fail('usage', 'expected submit, review, or complete', 2)
  let values
  try {
    const flags: Record<string, { type: 'string' | 'boolean' }> = { json: { type: 'boolean' } }
    for (const key of options[action]) flags[key] = { type: 'string' }
    ;({ values } = parseArgs({ args, options: flags }))
  } catch { return fail('usage', 'invalid outcome flags', 2) }
  const value = (key: string) => values[key] as string | undefined
  for (const key of required[action]) if (!value(key)?.trim()) return fail('usage', `--${key} is required`, 2)
  const decision = value('decision')
  if (action === 'review' && ((decision !== 'accept' && decision !== 'reject') || (decision === 'reject' && !value('reason')?.trim()))) {
    return fail('usage', 'expected accept or reject; reject requires --reason', 2)
  }
  const index = value('index')
  if (index !== undefined && (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index)))) return fail('usage', 'invalid outcome index', 2)
  const taskId = value('task')!, root = value('root') ?? process.cwd()
  const say = (data: object, phrase: string, reasons: string[] = []) => {
    if (json) io.log(JSON.stringify(data))
    else if (reasons.length) return fail('outcome_not_satisfied', reasons.join('; '), 1)
    else io.log(phrase)
    return reasons.length ? 1 : 0
  }
  try {
    const team = io.board ?? board()
    if (action === 'review') return say(await reviewOutcome(team, { taskId, decision: decision as 'accept' | 'reject', reason: value('reason') ?? '' }), 'review recorded')
    const { message: task } = await team.thread(taskId)
    if (action === 'submit') {
      const kind = value('kind')!
      const result = await submitOutcome(team, { taskId, outcome: index === undefined ? { kind } : { kind, index: Number(index) },
        evidence: { work_id: outcomeWorkId(task), kind, path: value('path')!, sha256: value('sha256')! },
        root, party: value('party')!, attempt: value('attempt')!, contractRevision: task.revision,
      })
      return say(result, 'outcome recorded', result.reasons)
    }
    const result = await completeOutcome(team, { taskId, root, party: value('party')!, attempt: value('attempt')!,
      validators: value('validators')!.split(',').map((actor) => actor.trim()).filter(Boolean),
      declaredReviewer: value('reviewer') ?? outcomeContract(task).reviewer, jockeys: io.jockeys ?? [],
    })
    return say(result, 'completed', result.reasons)
  } catch (error) {
    if (error instanceof BoardError) {
      if (error.code === 'no_board') return fail('no_board', 'no board to use', 2)
      return fail('board_error', `board refused outcome ${action}`, 1)
    }
    return fail('outcome_error', error instanceof Error && !(error instanceof TypeError) ? error.message : 'outcome operation failed', 1)
  }
}
