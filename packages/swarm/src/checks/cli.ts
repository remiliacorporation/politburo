import { parseArgs } from 'node:util'
import { checkAndPush } from './checkAndPush.ts'
import { GitError } from './exec.ts'
import { LockError, lockState, tryAcquire } from './lock.ts'
import { preflightCommand } from './preflight.ts'
import { retireCheck } from './retire.ts'

const usages = {
  lock: 'lock status|try --path FILE',
  run: 'run --repo DIR --branch B --lock FILE --status-dir DIR -- <command...>',
  retire: 'retire --worktree DIR [--worktree DIR]... [--json]',
  preflight: 'preflight --repo DIR --base REF [--json]',
}

class UsageError extends Error {}

function flags(args: string[], required: string[], json = false) {
  const options: NonNullable<Parameters<typeof parseArgs>[0]>['options'] =
    Object.fromEntries(required.map((name) => [name, { type: 'string' }]))
  if (json) options.json = { type: 'boolean' }
  try {
    const { values } = parseArgs({ args, options })
    return required.map((name) => {
      const value = values[name]
      if (typeof value !== 'string' || !value) throw new UsageError(`missing --${name}`)
      return value
    })
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError('invalid check arguments')
  }
}

function printFindings(findings: Awaited<ReturnType<typeof preflightCommand>>, output = console.log) {
  for (const { rule, file, line } of findings) output(`${rule} ${file}:${line}`)
}

export async function run(argv: string[]): Promise<number> {
  const [action, ...args] = argv
  const json = (action === 'retire' || action === 'preflight') && args.includes('--json')
  try {
    switch (action) {
      case 'lock': {
        const [mode, ...rest] = args
        if (mode !== 'status' && mode !== 'try') throw new UsageError('expected lock status or try')
        const [path] = flags(rest, ['path'])
        if (mode === 'status') console.log(await lockState(path!))
        else {
          const lock = await tryAcquire(path!)
          if (!lock.ok) { console.error('error: check lock busy'); return 1 }
          await lock.release()
          console.log('acquired')
        }
        return 0
      }
      case 'run': {
        const split = args.indexOf('--')
        if (split < 0 || !args[split + 1]) throw new UsageError('expected -- followed by a check command')
        const [repo, branch, lockPath, statusDir] = flags(args.slice(0, split), ['repo', 'branch', 'lock', 'status-dir'])
        const result = await checkAndPush({ repo: repo!, branch: branch!, lockPath: lockPath!, statusDir: statusDir!, command: args.slice(split + 1) })
        if (result.status === 'pushed') { console.log('pushed'); return 0 }
        if (result.status === 'refused_privacy') printFindings(result.findings, console.error)
        else console.error(`error: ${{ busy: 'check lock busy', dirty: 'worktree is dirty', head_changed: 'head changed', check_failed: 'check did not pass' }[result.status]}`)
        return 1
      }
      case 'retire': {
        let worktrees: string[] | undefined
        try {
          worktrees = parseArgs({ args, options: { worktree: { type: 'string', multiple: true }, json: { type: 'boolean' } } }).values.worktree
        } catch { throw new UsageError('invalid retire arguments') }
        if (!worktrees?.length || worktrees.some((path) => !path)) throw new UsageError('missing --worktree')
        const result = await retireCheck({ worktrees })
        if (json) console.log(JSON.stringify(result))
        else if (result.ok) console.log('ready to retire')
        else console.error('error: not ready to retire')
        return result.ok ? 0 : 1
      }
      case 'preflight': {
        const [repo, base] = flags(args, ['repo', 'base'], true)
        const findings = await preflightCommand({ repo: repo!, base: base! })
        if (json) console.log(JSON.stringify({ findings }))
        else if (findings.length) printFindings(findings)
        else console.log('no privacy findings')
        return findings.length ? 1 : 0
      }
      default: throw new UsageError('expected lock, run, retire, or preflight')
    }
  } catch (error) {
    const misuse = error instanceof UsageError
    const message = misuse || error instanceof LockError || error instanceof GitError ? error.message : 'check operation failed'
    if (json) console.log(JSON.stringify({ error: message }))
    else {
      console.error(`error: ${message}`)
      if (misuse && action && Object.hasOwn(usages, action)) console.error(`usage: swarm check ${usages[action as keyof typeof usages]}`)
    }
    return misuse ? 2 : 1
  }
}
