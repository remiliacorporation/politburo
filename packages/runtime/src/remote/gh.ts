import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execCli, isRecord, isSha, parseJson, type CliResult } from './cli.ts'
import { CodeHostError, type CodeHost, type Pr, type ReadyTransition } from './code-host.ts'

export type GhExec = (args: readonly string[]) => Promise<CliResult>

export type GhOptions = {
  repo: string
  base: string
  /** Required GitHub check-run names. A missing or incomplete run is pending. */
  requiredCheckNames: readonly string[]
  token?: string
  exec?: GhExec
  /** Run the entire callback while no writer can change this PR's head. */
  withHeadLock?(pr: Pr, transition: () => Promise<ReadyTransition>): Promise<ReadyTransition>
}

function ghExec(token: string): GhExec {
  return async (args) => {
    const dir = await mkdtemp(join(tmpdir(), 'politburo-gh-'))
    try {
      return await execCli('gh', args, {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GH_CONFIG_DIR: dir,
          GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
        },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

const isPr = (value: unknown): value is Pr =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new CodeHostError('unexpected_response')
  return value
}

function record(value: unknown) {
  if (!isRecord(value)) throw new CodeHostError('unexpected_response')
  return value
}

/** Observe CI by commit SHA. GitHub does not offer a head-conditional ready mutation. */
export function ghCodeHost({ repo, base, requiredCheckNames, token, exec, withHeadLock }: GhOptions): CodeHost {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repo) || /\/\.{1,2}$/u.test(repo) || !base ||
      !requiredCheckNames.length || requiredCheckNames.some((name) => !name) || (!exec && !token)) {
    throw new CodeHostError('invalid_options')
  }
  const required = new Set(requiredCheckNames)
  const invoke = exec ?? ghExec(token!)
  const endpoint = `repos/${repo}`
  const owner = repo.split('/')[0]!
  async function command(args: readonly string[]) {
    const { code, stdout } = await invoke(args)
    if (code !== 0) throw new CodeHostError('gh_failed')
    return stdout
  }
  async function api(path: string, ...args: string[]) {
    return parseJson(await command(['api', '--hostname', 'github.com', path, ...args]))
  }
  async function findPr(branch: string): Promise<Pr | null> {
    const filter = encodeURIComponent(`${owner}:${branch}`)
    const pages = list(await api(`${endpoint}/pulls?state=all&head=${filter}&per_page=100`, '--paginate', '--slurp'))
    const matches = new Set<Pr>()
    for (const page of pages) for (const value of list(page)) {
      const { head, number } = record(value)
      const { ref, repo: headRepo } = record(head)
      if (ref !== branch || headRepo === null) continue
      const { full_name: name } = record(headRepo)
      if (typeof name !== 'string') throw new CodeHostError('unexpected_response')
      if (name.toLowerCase() !== repo.toLowerCase()) continue
      if (!isPr(number)) throw new CodeHostError('unexpected_response')
      matches.add(number)
    }
    if (matches.size > 1) throw new CodeHostError('ambiguous_pr')
    return matches.values().next().value ?? null
  }
  async function headSha(pr: Pr) {
    if (!isPr(pr)) throw new CodeHostError('invalid_target')
    const { sha } = record(record(await api(`${endpoint}/pulls/${pr}`)).head)
    if (!isSha(sha)) throw new CodeHostError('unexpected_response')
    return sha
  }

  return {
    findPr, headSha,
    async openDraftPr({ branch, title, body = '' }) {
      const existing = await findPr(branch)
      if (existing !== null) return existing
      try {
        const { number, draft } = record(await api(`${endpoint}/pulls`, '--method', 'POST',
          '--raw-field', `head=${branch}`, '--raw-field', `base=${base}`, '--raw-field', `title=${title}`,
          '--raw-field', `body=${body}`, '--field', 'draft=true'))
        if (!isPr(number) || draft !== true) throw new CodeHostError('unexpected_response')
        return number
      } catch (error) {
        // GitHub rejects a concurrent duplicate open. Also reconcile a lost create response.
        const opened = await findPr(branch)
        if (opened !== null) return opened
        throw error
      }
    },
    async runChecks(sha) {
      if (!isSha(sha)) throw new CodeHostError('invalid_target')
      const pages = list(await api(`${endpoint}/commits/${sha}/check-runs?filter=latest&per_page=100`, '--paginate', '--slurp'))
      const passed = new Set<string>()
      let failed = false
      let pending = false
      for (const page of pages) for (const value of list(record(page).check_runs)) {
        const check = record(value)
        if (typeof check.name !== 'string') throw new CodeHostError('unexpected_response')
        if (!required.has(check.name)) continue
        if (check.head_sha !== sha) throw new CodeHostError('check_sha_mismatch')
        if (check.status !== 'completed') pending = true
        else if (check.conclusion === 'success') passed.add(check.name)
        else failed = true
      }
      return { sha, state: failed ? 'fail' : pending || passed.size !== required.size ? 'pending' : 'pass' }
    },
    async markReady(pr, expectedSha) {
      if (!isPr(pr) || !isSha(expectedSha)) throw new CodeHostError('invalid_target')
      // A read immediately before `gh pr ready` still races a push. Fail
      // closed unless the caller can actually exclude head updates.
      if (!withHeadLock) return 'readiness_unfenced'
      return withHeadLock(pr, async () => {
        if (await headSha(pr) !== expectedSha) return 'head_changed'
        await command(['pr', 'ready', String(pr), '--repo', `github.com/${repo}`])
        return 'ready'
      })
    },
  }
}
