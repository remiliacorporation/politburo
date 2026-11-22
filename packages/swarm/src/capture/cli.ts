import { parseArgs } from 'node:util'
import { SpriteNotFinished } from './collect.ts'
import { jsonlLedger } from './ledger.ts'
import { defaultSpriteDir, executionId, recordSprite, SpriteLaunchFailed, supervise, validSpriteName } from './supervise.ts'
import type { Envelope } from './types.ts'

const usage = `usage: swarm capture <run|collect> --name NAME --ledger DIR --party ID --session ID --trace ID
  [--repo ID] [--work ID] [--attempt ID] [--parent ID] [--tier TIER]
  [--route ROUTE] [--json]
  run: --task FILE [--execution ID] [--restarts N] [--max-seconds N]
  collect: --execution ID [--dir DIR]`

const text = { type: 'string' } as const
const options = {
  name: text, task: text, ledger: text, party: text, repo: text, work: text,
  attempt: text, parent: text, session: text, trace: text, tier: text, execution: text,
  restarts: text, dir: text, 'max-seconds': text, route: text, json: { type: 'boolean' },
} as const

function misuse(message: string): number {
  console.error(`error: ${message}\n${usage}`)
  return 2
}

function failure(message: string): number {
  console.error(`error: ${message}`)
  return 1
}

function count(value: string | undefined, fallback: number, min: number): number | null {
  if (value === undefined) return fallback
  const n = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(n) && n >= min ? n : null
}

export async function captureMain(args: string[]): Promise<number> {
  const [action, ...flags] = args
  if (action === '--help' && !flags.length) {
    console.log(usage)
    return 0
  }
  if (action !== 'run' && action !== 'collect') return misuse('expected capture run or collect')
  let values
  try {
    ;({ values } = parseArgs({ args: flags, strict: true, options }))
  } catch {
    return misuse('invalid capture flags')
  }
  const { name, task, ledger: ledgerDir, party, session, trace, dir = defaultSpriteDir } = values
  if (!name || !validSpriteName(name)) return misuse('expected a valid --name')
  if (!ledgerDir || !party || !session || !trace) return misuse('--ledger, --party, --session and --trace are required')
  if (action === 'run' && values.dir !== undefined) return misuse('--dir is for collect only')
  if (action === 'run' && !task) return misuse('--task is required for run')
  if (action === 'collect' && !values.execution) return misuse('--execution is required for collect')
  if (action === 'collect' && (task !== undefined || values.restarts !== undefined || values['max-seconds'] !== undefined)) {
    return misuse('--task, --restarts and --max-seconds are for run only')
  }
  if (!dir || values.execution === '') return misuse('--dir and --execution cannot be empty')
  const tier = values.tier ?? 'sprite'
  if (tier !== 'sprite' && (action === 'run' || !['core', 'spawner', 'secretary', 'mob', 'jockey'].includes(tier))) {
    return misuse(action === 'run' ? 'run requires tier sprite' : 'invalid --tier')
  }
  const restarts = count(values.restarts, 0, 0)
  const maxSeconds = count(values['max-seconds'], 2400, 1)
  if (restarts === null || maxSeconds === null) return misuse('invalid --restarts or --max-seconds')

  try {
    const id = values.execution ?? executionId()
    const envelope: Envelope = {
      party, repo: values.repo ?? null, work_id: values.work ?? null, attempt: values.attempt ?? null,
      parent: values.parent ?? null, session, tier: tier as Envelope['tier'], trace: { id: trace, execution_id: id },
    }
    const ledger = jsonlLedger(ledgerDir)
    const opts = { ledger, envelope, name, requested_route: values.route }
    let attempts
    if (action === 'run' && task) {
      ;({ attempts } = await supervise({ ...opts, taskFile: task, cwd: process.cwd(), maxSeconds, restarts }))
    } else {
      await ledger.registerEnvelope(envelope)
      attempts = [await recordSprite(opts, { dir })]
    }
    if (values.json) console.log(JSON.stringify({ attempts }))
    else for (const attempt of attempts) for (const record of attempt.records) {
      const { input_uncached, output, cache_read } = record.tokens
      console.log(`${attempt.name}  ${record.provider ?? 'unknown'}/${record.actual_model ?? 'unknown'}` +
        `  in ${input_uncached ?? 'unknown'} out ${output ?? 'unknown'} cache ${cache_read ?? 'unknown'}` +
        `  ${record.status}  ${record.exit_reason}`)
    }
    const rc = attempts.at(-1)?.rc
    return action === 'run' && rc !== undefined && rc !== 0 ? failure(`sprite exited with code ${rc}`) : 0
  } catch (error) {
    // Child and filesystem errors may include raw output or operator paths.
    if (error instanceof SpriteNotFinished) {
      const message = 'sprite did not finish'
      if (action === 'collect' && values.json) {
        console.log(JSON.stringify({ error: message, reason: 'unfinished' }))
        return 1
      }
      return failure(message)
    }
    if (error instanceof SpriteLaunchFailed) return failure('sprite launch failed')
    return failure('sprite capture failed')
  }
}
