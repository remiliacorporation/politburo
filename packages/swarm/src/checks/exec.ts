import { execFile } from 'node:child_process'

export type Exec = (argv: string[], options: { cwd: string; timeoutMs: number }) => Promise<{
  stdout: string; exitCode: number | null
}>

export const exec: Exec = ([file, ...args], { cwd, timeoutMs }) => new Promise((done) => {
  const child = execFile(file!, args, { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    done({ stdout, exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0 })
  })
  child.stdin?.end()
})

export class GitError extends Error {}
export function gitAt(cwd: string, run = exec) {
  return async (...args: string[]) => {
    const result = await run(['git', ...args], { cwd, timeoutMs: 120_000 }).catch(() => null)
    if (result?.exitCode !== 0) throw new GitError(`git ${args[0]} failed`)
    return result.stdout
  }
}

export async function readHead(git: ReturnType<typeof gitAt>) {
  const sha = (await git('rev-parse', 'HEAD')).trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new GitError('git did not return a commit sha')
  return sha
}

export async function isClean(git: ReturnType<typeof gitAt>) {
  return (await git('status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none')) === ''
}
