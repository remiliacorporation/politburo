import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const collector = fileURLToPath(new URL('../../../../tools/bench/sprite-usage.mjs', import.meta.url))

// The subset of bench-run@1 used by capture, plus the sidecar exit code.
export interface BenchRecord {
  schema: 'bench-run@1'
  runId: string
  model: { provider: string; name: string } | null
  startedAt: string
  endedAt: string
  turns: number
  tokens: Record<'in' | 'out' | 'reasoning' | 'cached', number | null>
  coverage: { tokens: 'complete' | 'partial' | 'none' }
  outcome: { state: 'done' | 'failed' | 'canceled'; reason: string | null }
  rc: number
}

export type CollectSpriteOptions = { dir: string; collectorPath?: string } & (
  | { worktree: string; base: string }
  | { worktree?: undefined; base?: undefined }
)

export class SpriteNotFinished extends Error {
  override name = 'SpriteNotFinished'
}

async function readExitCode(path: string, name: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SpriteNotFinished(`sprite ${name} has no exit code yet`)
    }
    throw new Error('invalid or unreadable sprite exit code')
  }
}

// `dir` and `collectorPath` are operator configuration and must never come
// from a dispatch or any request input.
export async function collectSprite(name: string, opts: CollectSpriteOptions): Promise<BenchRecord[]> {
  const path = join(opts.dir, `${name}.rc`)
  const before = await readExitCode(path, name)
  const args = [opts.collectorPath ?? collector, name, '--dir', opts.dir]
  if (opts.worktree !== undefined) args.push('--worktree', opts.worktree, '--base', opts.base)
  const result = await exec(process.execPath, args, { env: { PATH: process.env.PATH } }).catch(() => null)
  const after = await readExitCode(path, name)
  if (before !== after) throw new Error('sprite exit code changed during collection')
  if (result === null) throw new Error('sprite collector failed')

  let records: Omit<BenchRecord, 'rc'>[]
  try {
    records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Omit<BenchRecord, 'rc'>)
    if (records.some(row => row?.schema !== 'bench-run@1')) throw new Error()
  } catch {
    throw new Error('invalid bench-run@1 output from sprite collector')
  }

  const raw = after.trim()
  const rc = Number(raw)
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(rc)) {
    throw new Error('invalid or unreadable sprite exit code')
  }

  return records.map(row => ({ ...row, rc }))
}
