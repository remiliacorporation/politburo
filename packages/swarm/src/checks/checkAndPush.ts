import { randomUUID } from 'node:crypto'
import { constants as fs } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { PrivacyFinding, PrivacyOptions } from '@remilia/politburo-runtime'
import { exec, GitError, gitAt, isClean, readHead, type Exec } from './exec.ts'
import { LockError, lockFile, tryAcquire } from './lock.ts'
import { diffFindings } from './preflight.ts'

export type CommitStatus = { sha: string; state: 'pass' | 'fail' | 'unknown' }
export type CheckResult =
  | { status: 'pushed' | 'head_changed'; sha: string }
  | ({ status: 'check_failed'; exitCode: number | null } & CommitStatus)
  | { status: 'dirty' | 'busy' }
  | { status: 'refused_privacy'; findings: PrivacyFinding[] }

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

async function statusInfo(dir: string) {
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (info && (!info.isDirectory() || info.uid !== process.getuid?.())) throw invalidDir()
  return info
}

async function writeStatus<T extends CommitStatus>(dir: string, data: T) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await statusInfo(dir)
  const handle = await open(dir, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (info?.ino !== opened.ino || info.dev !== opened.dev || info.uid !== opened.uid) throw invalidDir()
    // Anchor both operations to the directory we verified, even if its pathname moves.
    const anchor = `/proc/self/fd/${handle.fd}`
    const temp = join(anchor, `.${randomUUID()}.tmp.json`)
    await writeFile(temp, json(data), { flag: 'wx', mode: 0o600 })
    try { await rename(temp, join(anchor, `${data.sha}.json`)) }
    finally { await unlink(temp).catch(() => {}) }
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
  if (inside(path, dir) || (await statusInfo(dir) && inside(await realpath(dirname(path)), await realpath(dir)))) {
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
    await writeFile(`${path}.owner`, json({ pid: process.pid, sha, command: label, startedAt }), {
      flag: fs.O_WRONLY | fs.O_CREAT | fs.O_TRUNC | fs.O_NOFOLLOW | fs.O_NONBLOCK, mode: 0o600,
    })
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
