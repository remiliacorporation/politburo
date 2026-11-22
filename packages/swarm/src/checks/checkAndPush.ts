import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PrivacyFinding, PrivacyOptions } from '@remilia/politburo-runtime'
import { exec, gitAt, isClean, readHead, type Exec } from './exec.ts'
import { tryAcquire } from './lock.ts'
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

async function atomicJson(path: string, data: object) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

export async function checkAndPush({
  repo, remote = 'origin', branch, command, lockPath, statusDir, git, run = exec, preflightOptions, statusSink,
}: CheckOptions, { now = () => new Date(), attempt = tryAcquire } = {}): Promise<CheckResult> {
  const [file] = command
  if (!file) throw new Error('missing check command')
  const lock = await attempt(lockPath)
  if (!lock.ok) return { status: 'busy' }
  try {
    const at = gitAt(repo, git)
    if (!await isClean(at)) return { status: 'dirty' }
    const sha = await readHead(at)
    const label = `${basename(file)} (${command.length - 1} args)`
    const target = `refs/heads/${branch}`
    const base = `refs/remotes/${remote}/${branch}`
    await at('fetch', '--no-tags', '--', remote, `+${target}:${base}`)
    const findings = await diffFindings(at, base, sha, preflightOptions)
    if (findings.length) return { status: 'refused_privacy', findings }
    if (!await isClean(at)) return { status: 'dirty' }
    if (await readHead(at) !== sha) return { status: 'head_changed', sha }

    const startedAt = now().toISOString()
    await atomicJson(`${lockPath}.owner`, { pid: process.pid, sha, command: label, startedAt })
    const result = await run(command, { cwd: repo, timeoutMs: 30 * 60_000 }).catch(() => null)
    const exitCode = result?.exitCode ?? null
    const endedAt = now().toISOString()
    // If we cannot corroborate the commit, the check is not proof for it.
    const checkedHead = await readHead(at).catch(() => null)
    const state = checkedHead !== sha || exitCode === null ? 'unknown' : exitCode === 0 ? 'pass' : 'fail'
    await mkdir(statusDir, { recursive: true, mode: 0o700 })
    await atomicJson(join(statusDir, `${sha}.json`), { sha, state, command: label, startedAt, endedAt, exitCode })
    await statusSink?.({ sha, state })
    if (await readHead(at) !== sha || (checkedHead !== null && checkedHead !== sha)) return { status: 'head_changed', sha }
    if (state !== 'pass') return { status: 'check_failed', sha, state, exitCode }
    await at('push', '--no-follow-tags', '--recurse-submodules=no', '--', remote, `${sha}:${target}`)
    return { status: 'pushed', sha }
  } finally {
    await lock.release()
  }
}
