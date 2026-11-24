// Pull request state for task labels, read from GitHub. A failed or partial read is omitted.

export const prStates = ['draft', 'open', 'merged', 'closed'] as const
export const prChecks = ['pass', 'fail', 'pending', 'none'] as const
export type PrState = (typeof prStates)[number]
export type PrChecks = (typeof prChecks)[number]
export type PullFact = { number: number; state: PrState; checks: PrChecks; head: string }

const GITHUB = 'https://api.github.com'
const FAIL = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])
const PASS = new Set(['success', 'neutral', 'skipped'])

export type GithubSend = (url: string) => Promise<Response>

export function githubPullSend(env: NodeJS.ProcessEnv = process.env): GithubSend {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || ''
  return async (url) => {
    const target = new URL(url)
    if (target.origin !== GITHUB) throw new Error('refused')
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'politburo-swarm',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(url, { headers })
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function nextLink(header: string | null, current: string): string | undefined | false {
  if (!header) return undefined
  let found: string | undefined
  for (const match of header.matchAll(/<([^>]+)>([^,]*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;"]+))/i.exec(match[2] ?? '')
    const value = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase()
    if (!value.split(/\s+/).includes('next')) continue
    const target = URL.parse(match[1] ?? '', current)
    if (!target || target.origin !== GITHUB) return false
    found = target.toString()
  }
  return found
}

async function readJson(send: GithubSend, url: string): Promise<{ body: unknown; next?: string } | undefined> {
  let response: Response
  try { response = await send(url) } catch { return undefined }
  if (!response.ok) return undefined
  let body: unknown
  try { body = await response.json() } catch { return undefined }
  const next = nextLink(response.headers.get('link'), url)
  if (next === false) return undefined
  return next ? { body, next } : { body }
}

function fromRun(status: unknown, conclusion: unknown): PrChecks | undefined {
  if (typeof status !== 'string') return undefined
  if (status !== 'completed') return 'pending'
  if (typeof conclusion === 'string' && PASS.has(conclusion)) return 'pass'
  if (typeof conclusion === 'string' && FAIL.has(conclusion)) return 'fail'
  return 'pending'
}

function fromStatus(state: unknown): PrChecks | undefined {
  if (state === 'success') return 'pass'
  if (state === 'failure' || state === 'error') return 'fail'
  if (state === 'pending') return 'pending'
  return undefined
}

function checksOf(parts: readonly PrChecks[]): PrChecks {
  if (parts.length === 0) return 'none'
  if (parts.includes('fail')) return 'fail'
  if (parts.includes('pending')) return 'pending'
  return 'pass'
}

function factOf(number: number, body: unknown, runs: readonly unknown[], statuses: readonly unknown[]): PullFact | undefined {
  const row = object(body)
  const head = object(row?.head)
  const sha = head?.sha
  if (!row || row.number !== number || (row.state !== 'open' && row.state !== 'closed')) return undefined
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) return undefined
  if (row.draft !== undefined && typeof row.draft !== 'boolean') return undefined
  const merged = row.merged === true || (typeof row.merged_at === 'string' && row.merged_at.length > 0)
  if (merged && row.state !== 'closed') return undefined
  const state: PrState = merged ? 'merged' : row.state === 'closed' ? 'closed' : row.draft === true ? 'draft' : 'open'
  const parts: PrChecks[] = []
  for (const run of runs) {
    const item = object(run)
    const one = item && fromRun(item.status, item.conclusion)
    if (!one) return undefined
    parts.push(one)
  }
  for (const status of statuses) {
    const item = object(status)
    const one = item && fromStatus(item.state)
    if (!one) return undefined
    parts.push(one)
  }
  return { number, state, checks: checksOf(parts), head: sha.slice(0, 7).toLowerCase() }
}

async function readRuns(send: GithubSend, root: string, sha: string): Promise<unknown[] | undefined> {
  const runs: unknown[] = []
  let url: string | undefined = `${root}/commits/${sha}/check-runs?per_page=100`
  let total: number | undefined
  for (let page = 0; page < 10 && url; page++) {
    const read = await readJson(send, url)
    const body = object(read?.body)
    const batch = body?.check_runs
    if (!read || !body || !Array.isArray(batch) || !Number.isSafeInteger(body.total_count) || batch.length > 100) return undefined
    if (total === undefined) total = body.total_count as number
    else if (total !== body.total_count) return undefined
    runs.push(...batch)
    url = read.next
  }
  if (url || total !== runs.length) return undefined
  return runs
}

async function readStatuses(send: GithubSend, root: string, sha: string): Promise<unknown[] | undefined> {
  const read = await readJson(send, `${root}/commits/${sha}/status`)
  const body = object(read?.body)
  if (!read || read.next || !body || !Array.isArray(body.statuses)) return undefined
  if (Number.isSafeInteger(body.total_count) && body.total_count !== body.statuses.length) return undefined
  return body.statuses
}

/** One fact per pull request GitHub answered completely. Missing numbers were not read. */
export async function readPulls(repo: string, numbers: readonly number[], send: GithubSend): Promise<Map<number, PullFact>> {
  const [owner, name] = repo.split('/')
  const root = `${GITHUB}/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`
  const facts = new Map<number, PullFact>()
  for (const number of numbers) {
    const read = await readJson(send, `${root}/pulls/${number}`)
    const sha = object(object(read?.body)?.head)?.sha
    if (!read || read.next || typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) continue
    const [runs, statuses] = await Promise.all([readRuns(send, root, sha), readStatuses(send, root, sha)])
    if (!runs || !statuses) continue
    const fact = factOf(number, read.body, runs, statuses)
    if (fact) facts.set(number, fact)
  }
  return facts
}
