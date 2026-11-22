import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhExec } from '@remilia/politburo-runtime'
import { mirrorKinds, validRepo, type MirrorItem, type MirrorKind, type MirrorRead } from './types.ts'

function gh(token: string): GhExec {
  return async (args) => {
    const cwd = await mkdtemp(join(tmpdir(), 'swarm-mirror-'))
    try {
      return await new Promise((resolve) => {
        const child = execFile('gh', [...args], {
          cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GH_CONFIG_DIR: cwd,
            GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        }, (error, stdout) => resolve({ code: error ? null : 0, stdout }))
        child.stdin?.on('error', () => {})
        child.stdin?.end()
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('unexpected_response')
  return value
}

function item(kind: MirrorKind, repo: string, value: unknown): MirrorItem | null {
  const row = object(value)
  if (!row) throw new Error('unexpected_response')
  if (kind === 'issue' && Object.hasOwn(row, 'pull_request')) {
    if (object(row.pull_request)) return null
    throw new Error('unexpected_response')
  }
  if (kind === 'branch') {
    const ref = text(row.name)
    const sha = text(object(row.commit)?.sha)
    if (!ref || !sha || ref.includes('\0') || !ref.isWellFormed()) throw new Error('unexpected_response')
    return { kind, repo, key: ref, state: 'open', head: { ref, sha } }
  }
  const { number, state, draft, title, user, head, base, updated_at, merged_at } = row
  if (!Number.isSafeInteger(number) || Number(number) <= 0 || (state !== 'open' && state !== 'closed')) {
    throw new Error('unexpected_response')
  }
  const result: MirrorItem = { kind, repo, key: String(number), state }
  if (title !== undefined) result.title = text(title)
  if (user != null) result.author = text(object(user)?.login)
  if (updated_at !== undefined) result.updatedAt = text(updated_at)
  if (kind === 'pr') {
    if (state === 'closed' && merged_at === undefined) throw new Error('unexpected_response')
    if (merged_at != null) {
      if (!text(merged_at) || state !== 'closed') throw new Error('unexpected_response')
      result.state = 'merged'
    }
    if (draft !== undefined) {
      if (typeof draft !== 'boolean') throw new Error('unexpected_response')
      result.draft = draft
    }
    if (head !== undefined) result.head = { ref: text(object(head)?.ref), sha: text(object(head)?.sha) }
    if (base !== undefined) result.base = text(object(base)?.ref)
  }
  return result
}

const endpoints = { pr: 'pulls?state=all&', branch: 'branches?', issue: 'issues?state=all&' }

export async function readRepo({ repo, exec, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, maxPages = 50 }: {
  repo: string; exec?: GhExec; token?: string; maxPages?: number
}): Promise<MirrorRead[]> {
  const invoke = exec ?? (token ? gh(token) : undefined)
  return Promise.all(mirrorKinds.map(async (kind): Promise<MirrorRead> => {
    const items: MirrorItem[] = []
    const partial = (reason: NonNullable<MirrorRead['reason']>): MirrorRead => ({ kind, complete: false, reason, items })
    if (!validRepo(repo) || token && repo.includes(token)) return partial('unexpected_response')
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) return partial('page_limit')
    if (!invoke) return partial('gh_failed')
    let stdout: string
    try {
      const result = await invoke(['api', '--hostname', 'github.com', '--method', 'GET',
        `repos/${repo}/${endpoints[kind]}per_page=100`, '--paginate', '--slurp'])
      if (result.code !== 0) return partial('gh_failed')
      stdout = result.stdout
    } catch { return partial('gh_failed') }
    let pages: unknown
    try { pages = JSON.parse(stdout) } catch { return partial('unexpected_response') }
    if (!Array.isArray(pages) || pages.length === 0) return partial('unexpected_response')
    const keys = new Set<string>()
    let invalid = false
    // gh owns pagination; the slurped page count bounds what we accept as a complete read.
    for (const page of pages.slice(0, maxPages)) {
      if (!Array.isArray(page) || page.length > 100) { invalid = true; continue }
      for (const raw of page) {
        try {
          const row = item(kind, repo, raw)
          if (!row) continue
          const { head, ...fields } = row
          if (keys.has(row.key) || token && [...Object.values(fields), head?.ref, head?.sha]
            .some((field) => typeof field === 'string' && field.includes(token))) {
            invalid = true
            continue
          }
          keys.add(row.key)
          items.push(row)
        } catch { invalid = true }
      }
    }
    if (invalid) return partial('unexpected_response')
    if (pages.length >= maxPages) return partial('page_limit')
    return { kind, complete: true, items }
  }))
}
