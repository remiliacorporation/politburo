import { parseArgs } from 'node:util'
import { board, BoardError, type Board } from '@vercel/board'
import { checksReason, selectTask, verdictReason, type CheckRun, type GateTask } from './decide.ts'

const usage = 'usage: swarm gate check <pr-number> --board URL'

function misuse(message: string): number {
  console.error(`error: ${message}`)
  console.error(usage)
  return 2
}

function say(reason: string): number {
  console.log(reason)
  return reason === 'pass' ? 0 : 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function githubToken(): string | undefined {
  const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
  return token || undefined
}

function githubBase(): string | null {
  const raw = (process.env.SWARM_GITHUB_API_URL || 'https://api.github.com').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^/\s]+/i.test(raw) ? raw : null
}

function openBoard(url: string): Board {
  const previous = process.env.BOARD_URL
  process.env.BOARD_URL = url.replace(/\/+$/, '')
  try {
    return board()
  } finally {
    if (previous === undefined) delete process.env.BOARD_URL
    else process.env.BOARD_URL = previous
  }
}

async function listedTasks(team: Board): Promise<GateTask[]> {
  const tasks: GateTask[] = []
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = await team.tasks.list({
      state: 'all', label: ['work.id'], limit: 100, ...(after ? { after } : {}),
    })
    for (const { message } of page.tasks) {
      tasks.push({
        state: message.task?.state ?? '',
        labels: message.labels,
        result: message.task?.result ?? null,
      })
    }
    if (page.tasks.length < 100) break
    if (seen.has(page.cursor)) break
    seen.add(page.cursor)
    after = page.cursor
  }
  return tasks
}

async function githubJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'politburo-swarm',
    },
  })
  if (!response.ok) throw new Error('github')
  return await response.json() as unknown
}

function parseHead(body: unknown, pr: number): string | null {
  if (!isRecord(body) || body.number !== pr || !isRecord(body.head) || typeof body.head.sha !== 'string') return null
  const sha = body.head.sha.toLowerCase()
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null
}

function parseRuns(body: unknown): { total: number; runs: CheckRun[] } | null {
  if (!isRecord(body) || !Array.isArray(body.check_runs)) return null
  const total = body.total_count
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return null
  const runs: CheckRun[] = []
  for (const row of body.check_runs) {
    if (!isRecord(row) || typeof row.status !== 'string') return null
    if (row.conclusion !== null && typeof row.conclusion !== 'string') return null
    const headSha = typeof row.head_sha === 'string' ? row.head_sha.toLowerCase() : ''
    runs.push({ status: row.status, conclusion: row.conclusion, headSha })
  }
  return { total, runs }
}

async function githubGet(repo: string, pr: number, path: string): Promise<unknown | null> {
  const base = githubBase()
  const token = githubToken()
  if (!base || !token) return null
  const root = `${base}/repos/${repo.split('/').map(encodeURIComponent).join('/')}`
  try {
    return await githubJson(`${root}${path}`, token)
  } catch {
    return null
  }
}

async function checkRuns(repo: string, pr: number, head: string): Promise<{ checks: CheckRun[]; complete: boolean } | null> {
  const checks: CheckRun[] = []
  let total = -1
  for (let page = 1; page <= 10; page++) {
    const parsed = parseRuns(await githubGet(repo, pr, `/commits/${head}/check-runs?per_page=100&page=${page}`))
    if (!parsed) return null
    if (page === 1) total = parsed.total
    else if (parsed.total !== total) return null
    checks.push(...parsed.runs)
    if (checks.length >= total || parsed.runs.length === 0) break
  }
  if (total < 0) return null
  return { checks, complete: checks.length === total }
}

export async function gateCommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv
  if (action === '--help' || (action === 'check' && rest.length === 1 && rest[0] === '--help')) {
    console.log(usage)
    return 0
  }
  if (action !== 'check') return misuse('expected gate check')
  let values: { board?: string }
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: rest, allowPositionals: true, options: { board: { type: 'string' } } })
    values = parsed.values
    positionals = parsed.positionals
  } catch {
    return misuse('invalid gate check arguments')
  }
  const prText = positionals[0]
  const boardUrl = values.board?.trim()
  if (positionals.length !== 1 || !prText || !/^[1-9][0-9]*$/.test(prText) || !Number.isSafeInteger(Number(prText))) {
    return misuse('expected a pull request number')
  }
  if (!boardUrl || !/^https?:\/\/[^/\s]+/i.test(boardUrl)) return misuse('expected --board URL')
  const pr = Number(prText)
  let team: Board
  try {
    team = openBoard(boardUrl)
  } catch {
    return misuse('expected --board URL')
  }
  try {
    const selected = selectTask(await listedTasks(team), pr)
    if (!selected.ok) return say(selected.reason)
    const head = parseHead(await githubGet(selected.repo, pr, `/pulls/${pr}`), pr)
    if (!head) return say('github unavailable')
    const verdict = verdictReason(selected.task, head)
    if (verdict) return say(verdict)
    const checks = await checkRuns(selected.repo, pr, head)
    if (!checks) return say('github unavailable')
    return say(checksReason(head, checks.checks, checks.complete))
  } catch (error) {
    if (error instanceof BoardError) return say('board unavailable')
    throw error
  }
}
