import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Failure, WorkSpec } from './harness.ts'
import { checkedMs, processHarness, type Spawn } from './process.ts'

export type PiOptions = {
  /** Resolve the authorized brief. The adapter does not interpret briefRef as a path or URL. */
  readBrief(work: WorkSpec, signal: AbortSignal): string | Uint8Array | Promise<string | Uint8Array>
  command?: string
  /** By default: `pi-task <task-file> [max-seconds]`, with the requested model in PI_MODEL. */
  args?(input: { taskFile: string; model?: string; maxSeconds?: number }): readonly string[]
  maxSeconds?: number
  /** Try these models in order, after Start.model if provided. */
  models?: readonly string[]
  /** Kill a silent attempt, including when it hasn't produced any output yet. */
  idleMs: number
  /** Explicit extra child environment, never drawn from the parent's credentials. */
  env?: Readonly<NodeJS.ProcessEnv>
  /** Retry nonzero exits on the next model only for transient, quota, or provider_access. */
  classifyExit?(exitCode: number): Failure
  spawn?: Spawn
}

/** Launch a trusted pi-task-style command on a pinned brief. No live stdin. POSIX only. */
export function pi({ readBrief, command = 'pi-task', args, maxSeconds, models = [], idleMs, env, classifyExit, spawn }: PiOptions) {
  checkedMs(idleMs, 'idleMs')
  if (maxSeconds !== undefined) checkedMs(maxSeconds, 'maxSeconds')
  const fallback = [...models]
  const explicitEnv = { ...env }
  return processHarness({
    interactive: false,
    idleMs,
    spawn,
    classifyExit: classifyExit ?? (() => 'transient'),
    async prepare(input, dir, signal) {
      const brief = await readBrief(input.work, signal)
      if (createHash('sha256').update(brief).digest('hex') !== input.work.briefSha256) return { outcome: 'failed', failure: 'verification' } as const
      const taskFile = join(dir, 'task.md')
      await writeFile(taskFile, brief, { mode: 0o600, signal })
      const route = [...new Set([...(input.model === undefined ? [] : [input.model]), ...fallback])]
      return (route.length ? route : [undefined]).map((model) => ({
        command,
        args: args?.({ taskFile, model, maxSeconds }) ?? [taskFile, ...(maxSeconds === undefined ? [] : [String(maxSeconds)])],
        env: { ...explicitEnv, PI_MODEL: model },
      }))
    },
  })
}
