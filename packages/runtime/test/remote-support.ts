import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { TestContext } from 'node:test'
import { localGit, type CheckResult, type CodeHost, type DraftPr, type Pr, type ReadyTransition } from '../src/index.ts'

export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    },
  })
}

export async function tempDir(t: TestContext) {
  const dir = await mkdtemp(`${tmpdir()}/politburo-remote-test-`)
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export const identity = { name: 'Fixture Writer', email: 'fixture@example.test' }
export const refsAt = (repoDir: string) => localGit({ repoDir, identity })
export const shaA = 'a'.repeat(40)
export const shaB = 'b'.repeat(40)
export const branch = 'work/fixture'

class MemoryCodeHost implements CodeHost {
  readonly prs = new Map<Pr, { branch: string; draft: boolean }>()
  readonly heads = new Map([[branch, shaA]])
  canOpen = true
  checks: CodeHost['runChecks'] = async (sha) => ({ sha, state: 'pass' })
  beforeReady: () => void = () => {}

  async findPr(branch: string) {
    for (const [pr, entry] of this.prs) if (entry.branch === branch) return pr
    return null
  }
  async openDraftPr({ branch }: DraftPr) {
    if (!this.canOpen) throw new Error('fixture host does not allow PR creation')
    const existing = [...this.prs].find(([, entry]) => entry.branch === branch)
    if (existing) return existing[0]
    const pr = this.prs.size + 1
    this.prs.set(pr, { branch, draft: true })
    return pr
  }
  async headSha(pr: Pr) {
    return this.heads.get(this.prs.get(pr)!.branch)!
  }
  async runChecks(sha: string): Promise<CheckResult> { return this.checks(sha) }
  async markReady(pr: Pr, expectedSha: string): Promise<ReadyTransition> {
    this.beforeReady()
    const entry = this.prs.get(pr)!
    if (this.heads.get(entry.branch) !== expectedSha) return 'head_changed'
    entry.draft = false
    return 'ready'
  }
}

export const memoryHost = () => new MemoryCodeHost()
export async function openDraft() {
  const host = memoryHost()
  const pr = await host.openDraftPr({ branch, title: 'Fixture' })
  return { host, pr, draft: () => host.prs.get(pr)!.draft }
}