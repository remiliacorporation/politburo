import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Failure, Result, Start } from './harness.ts'
import { finish, ledger } from './ledger.ts'

/** A spawn implementation with piped stdio and POSIX process groups. */
export type Spawn = (command: string, args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  detached: true
  stdio: 'pipe'
  shell: false
}) => ChildProcessWithoutNullStreams

export type Invocation = { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }
type Exit = Pick<Result, 'outcome' | 'exitCode' | 'failure'>

export function checkedMs(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new RangeError(`invalid ${name}`)
  return value
}

export function processHarness(options: {
  interactive: boolean
  idleMs?: number
  spawn?: Spawn
  prepare(input: Start, dir: string, signal: AbortSignal): readonly Invocation[] | Exit | Promise<readonly Invocation[] | Exit>
  classifyExit?(code: number): Failure
}) {
  if (process.platform === 'win32') throw new Error('process harnesses require POSIX process groups')
  const spawnChild = options.spawn ?? spawn
  return ledger((run, input) => {
    let stop: 'cancel' | 'timeout' | undefined
    let child: ChildProcessWithoutNullStreams | undefined
    const preparation = new AbortController()
    function killTree(target: ChildProcessWithoutNullStreams | undefined) {
      if (!target?.pid) return
      try {
        process.kill(-target.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    function requestStop(reason: NonNullable<typeof stop>) {
      if (stop) return
      stop = reason
      run.state = 'stopping'
      preparation.abort()
      killTree(child)
    }
    run.stop = () => requestStop('cancel')
    const wall = setTimeout(() => requestStop('timeout'), input.work.limits.wallMs)
    run.input = (text) => {
      if (!child?.stdin.writable || child.exitCode !== null || child.signalCode !== null) return 'not_running'
      child.stdin.write(text)
      return 'accepted'
    }

    function execute({ command, args, env }: Invocation, dir: string): Promise<Exit> {
      return new Promise((resolve) => {
        const proc = spawnChild(command, [...args], {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env, HOME: dir, TMPDIR: dir },
          detached: true,
          stdio: 'pipe',
          shell: false,
        })
        child = proc
        let idle: NodeJS.Timeout | undefined
        let errored = false
        const activity = () => {
          if (options.idleMs === undefined) return
          clearTimeout(idle)
          idle = setTimeout(() => requestStop('timeout'), options.idleMs)
        }
        proc.once('spawn', () => {
          if (stop) killTree(proc)
          else {
            run.state = 'running'
            activity()
          }
        })
        proc.on('error', () => { errored = true })
        // A child can exit between acceptance and delivery to its pipe.
        proc.stdin.on('error', () => {})
        for (const type of ['stdout', 'stderr'] as const) {
          proc[type].setEncoding('utf8').on('data', (text: string) => {
            if (!stop && proc.exitCode === null && proc.signalCode === null) activity()
            run.events.push({ type, text })
          })
        }
        // Descendants may hold the pipes open even after the leader has exited.
        proc.once('exit', () => {
          clearTimeout(idle)
          killTree(proc)
        })
        proc.once('close', (code) => {
          clearTimeout(idle)
          child = undefined
          resolve(errored || code === null
            ? { outcome: 'failed', failure: 'transient' }
            : { outcome: 'exited', exitCode: code })
        })
      })
    }

    void (async () => {
      let dir: string | undefined
      let result: Exit = { outcome: 'failed', failure: 'transient' }
      try {
        dir = await mkdtemp(join(tmpdir(), 'politburo-run-'))
        if (!stop) {
          const commands = await options.prepare(input, dir, preparation.signal)
          if ('outcome' in commands) result = commands
          for (const command of 'outcome' in commands ? [] : commands) {
            if (stop) break
            run.state = 'starting'
            result = await execute(command, dir)
            if (stop || result.exitCode === 0) break
            if (result.exitCode !== undefined && options.classifyExit) {
              result = { ...result, outcome: 'failed', failure: options.classifyExit(result.exitCode) }
            }
            if (result.failure !== 'transient' && result.failure !== 'quota' && result.failure !== 'provider_access') break
          }
        }
      } catch {
        // Do not expose spawn errors: they can contain operator-supplied arguments.
        result = { outcome: 'failed', failure: 'transient' }
      }
      clearTimeout(wall)
      // Freeze the outcome once there is no more work to stop. Collection waits
      // for cleanup, but cancel must not overwrite an exit during that cleanup.
      const final: Exit = stop === 'cancel' ? { outcome: 'canceled' }
        : stop === 'timeout' ? { outcome: 'failed', failure: 'timeout' } : result
      delete run.stop
      if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {})
      finish(run, final)
    })()
  }, options.interactive)
}
