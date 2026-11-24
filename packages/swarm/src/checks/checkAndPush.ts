import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fs } from 'node:fs'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { PrivacyOptions } from '@remilia/politburo-runtime'
import { exec, GitError, gitAt, isClean, readHead, type Exec } from './exec.ts'
import { LockError, lockFile, tryAcquire } from './lock.ts'
import { diffFindings, type CheckFinding } from './preflight.ts'

export type CommitStatus = { sha: string; state: 'pass' | 'fail' | 'unknown' }
export type CheckResult =
  | { status: 'pushed' | 'head_changed'; sha: string }
  | ({ status: 'check_failed'; exitCode: number | null } & CommitStatus)
  | { status: 'dirty' | 'busy' }
  | { status: 'refused_privacy'; findings: CheckFinding[] }

export type CheckOptions = {
  repo: string
  remote?: string
  branch: string
  command: string[]
  lockPath: string
  statusDir: string
  git?: Exec
  run?: Exec
  preflightOptions?: PrivacyOptions
  statusSink?: (status: CommitStatus) => void | Promise<void>
}

const json = (data: object) => `${JSON.stringify(data)}\n`
const invalidDir = () => new LockError('check status directory must be a real directory owned by the current user')

async function withStatusDir<T>(dir: string, create: boolean, use: (anchor: FileHandle) => T | Promise<T>) {
  let child: string = sep
  for (const component of dir.split(sep).filter(Boolean)) {
    child = join(child, component)
    let info = await lstat(child).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!info) {
      if (!create) return
      await mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      info = await lstat(child)
    }
    if (!info.isDirectory()) throw invalidDir()
  }
  if (await realpath(dir) !== dir) throw invalidDir()
  const handle = await open(dir, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW)
  try {
    const info = await handle.stat(), named = await lstat(dir)
    if (info.uid !== process.getuid?.() || info.dev !== named.dev || info.ino !== named.ino ||
      await realpath(dir) !== dir) throw invalidDir()
    return await use(handle)
  } finally { await handle.close() }
}

// Perl is already required for the lock. Use fchdir in the child so both writes
// stay relative to the open leaf, without /proc or changing Node's cwd.
const statusScript = `
open(my $dir, '<&=3') or exit 1;
chdir($dir) or exit 1;
my ($temp, $target, $json) = @ARGV;
sysopen(my $file, $temp, O_WRONLY|O_CREAT|O_EXCL, 0600) or exit 1;
my $ok = print {$file} $json;
if (close($file) && $ok && rename($temp, $target)) { exit 0; }
unlink($temp);
exit 1;
`

async function writeStatus<T extends CommitStatus>(dir: string, data: T) {
  // Revalidate the path after running the check, before handing off the leaf.
  await withStatusDir(dir, true, (anchor) => new Promise<void>((done, reject) => {
    const child = spawn('perl', ['-MFcntl=:DEFAULT', '-e', statusScript,
      `.${randomUUID()}.tmp.json`, `${data.sha}.json`, json(data)], { stdio: ['ignore', 'ignore', 'ignore', anchor.fd] })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? done() : reject(new LockError('cannot write check status')))
  }))
}

async function writeOwner(path: string, data: object) {
  const invalidOwner = () => new LockError('check owner file must be a regular file owned by the current user with exactly one link')
  // Do not block on a FIFO before fstat can reject it.
  const handle = await open(path, fs.O_WRONLY | fs.O_CREAT | fs.O_NOFOLLOW | fs.O_NONBLOCK, 0o600)
    .catch(() => { throw invalidOwner() })
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1) throw invalidOwner()
    await handle.truncate(0)
    await handle.writeFile(json(data))
  } finally { await handle.close() }
}

export async function checkAndPush({
  repo, remote = 'origin', branch, command, lockPath, statusDir, git, run = exec, preflightOptions, statusSink,
}: CheckOptions, { now = () => new Date(), attempt = tryAcquire } = {}): Promise<CheckResult> {
  const [file] = command
  if (!file) throw new Error('missing check command')
  const path = lockFile(lockPath)
  const dir = resolve(statusDir)
  const inside = (file: string, folder: string) => file === folder || file.startsWith(join(folder, sep))
  if (inside(path, dir) || await withStatusDir(dir, false, async () => inside(await realpath(dirname(path)), dir))) {
    throw new LockError('check lock path cannot be inside the status directory')
  }
  const lock = await attempt(path)
  if (!lock.ok) return { status: 'busy' }
  try {
    const at = gitAt(repo, git)
    if (!await isClean(at)) return { status: 'dirty' }
    const sha = await readHead(at)
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new GitError('check status requires a 40-character commit sha')
    const label = `check (${command.length - 1} args)`
    const target = `refs/heads/${branch}`
    const base = `refs/remotes/${remote}/${branch}`
    await at('fetch', '--no-tags', '--', remote, `+${target}:${base}`)
    const boundary = (await at('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)).trim()
    const findings = await diffFindings(at, boundary, sha, preflightOptions)
    if (findings.length) return { status: 'refused_privacy', findings }
    if (!await isClean(at)) return { status: 'dirty' }
    if (await readHead(at) !== sha) return { status: 'head_changed', sha }

    const startedAt = now().toISOString()
    await writeOwner(`${path}.owner`, { pid: process.pid, sha, command: label, startedAt })
    const result = await run(command, { cwd: repo, timeoutMs: 30 * 60_000 }).catch(() => null)
    const exitCode = result?.exitCode ?? null
    const endedAt = now().toISOString()
    // If we cannot corroborate the commit, the check is not proof for it.
    const checkedHead = await readHead(at).catch(() => null)
    const state = checkedHead !== sha || exitCode === null ? 'unknown' : exitCode === 0 ? 'pass' : 'fail'
    await writeStatus(dir, { sha, state, command: label, startedAt, endedAt, exitCode })
    await statusSink?.({ sha, state })
    if (await readHead(at) !== sha || (checkedHead !== null && checkedHead !== sha)) return { status: 'head_changed', sha }
    if (state !== 'pass') return { status: 'check_failed', sha, state, exitCode }
    await at('push', '--no-follow-tags', '--recurse-submodules=no', '--', remote, `${sha}:${target}`)
    return { status: 'pushed', sha }
  } finally {
    await lock.release()
  }
}
