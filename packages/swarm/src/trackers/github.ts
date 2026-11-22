import { parseSourceId, TrackerError, type ItemState, type Observation, type Priority, type TrackerAdapter } from './types.ts'
import { commentMarker } from './write.ts'

export type GitHubOptions = {
  source: string
  baseUrl?: string
  token: () => string | undefined
  fetch?: typeof fetch
  now?: () => Date | number | string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function names(values: unknown, field: 'name' | 'login'): string[] {
  if (!Array.isArray(values)) throw new TrackerError('bad_response')
  return values.map((value: unknown) => {
    const name = isObject(value) ? value[field] : field === 'name' ? value : undefined
    if (typeof name !== 'string') throw new TrackerError('bad_response')
    return name
  })
}

function stateOf(state: string, reason: unknown): ItemState {
  if (state === 'open') return 'open'
  if (state !== 'closed') return 'unknown'
  if (reason === 'completed') return 'done'
  if (reason === 'not_planned' || reason === 'duplicate') return 'withdrawn'
  return 'unknown'
}

function priorityOf(labels: string[]): Priority {
  const [level, other] = new Set(labels.filter((label) => /^P[0-4]$/.test(label)))
  const priorities = ['urgent', 'high', 'normal', 'low', 'lowest'] as const
  return level && !other ? priorities[Number(level[1])]! : 'none'
}

function nextPage(link: string, url: string): string | undefined {
  for (const [, target, params] of link.matchAll(/<([^>]+)>([^,]*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;"]+))(?:\s*;|\s*$)/i.exec(params!)
    if (!(rel?.[1] ?? rel?.[2])?.toLowerCase().split(' ').includes('next')) continue
    const page = URL.parse(target!, url)?.searchParams.get('page')
    if (!page || !/^[1-9][0-9]*$/.test(page)) throw new TrackerError('bad_response')
    return page
  }
}

async function json(response: Response): Promise<unknown> {
  if (response.status === 401 || response.status === 403) throw new TrackerError('unauthorized')
  if (!response.ok) throw new TrackerError('bad_response')
  try {
    return await response.json()
  } catch (error) {
    throw new TrackerError(error instanceof TypeError ? 'unavailable' : 'bad_response')
  }
}

export function githubAdapter({ source, token, baseUrl = 'https://api.github.com',
  fetch: send = globalThis.fetch, now = () => new Date(),
}: GitHubOptions): TrackerAdapter {
  const { kind, scope } = parseSourceId(source)
  if (kind !== 'github') throw new TrackerError('bad_source')
  const issues = `${baseUrl.replace(/\/+$/, '')}/repos/${scope}/issues`

  async function request(url: string, body?: string) {
    let credential: string | undefined
    try { credential = token() } catch { throw new TrackerError('no_credential') }
    if (!credential?.trim()) throw new TrackerError('no_credential')
    let response: Response
    try {
      response = await send(url, { method: body === undefined ? 'GET' : 'POST', headers: {
        Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'politburo-swarm',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body, redirect: 'error' as const }) })
    } catch {
      throw new TrackerError('unavailable')
    }
    const { status, headers } = response
    const limited = status === 403 && headers.get('x-ratelimit-remaining') === '0'
    if (status === 429 || limited) throw new TrackerError('rate_limited')
    if (status >= 500) throw new TrackerError('unavailable')
    return response
  }

  function observation(item: Record<string, unknown>): Observation {
    const { node_id, number, html_url, updated_at, title, state, state_reason } = item
    if (typeof node_id !== 'string' || typeof number !== 'number' || !Number.isSafeInteger(number)
      || number < 1 || typeof html_url !== 'string' || typeof title !== 'string' || typeof state !== 'string'
      || typeof updated_at !== 'string' || !Number.isFinite(Date.parse(updated_at))) {
      throw new TrackerError('bad_response')
    }
    const labels = names(item.labels, 'name')
    let observedAt: string
    try { observedAt = new Date(now()).toISOString() } catch { throw new TrackerError('unavailable') }
    return {
      ref: { source, itemId: node_id, displayId: String(number), url: html_url },
      title, rawState: state, state: stateOf(state, state_reason), priority: priorityOf(labels), labels,
      assignees: names(item.assignees, 'login'), updatedAt: updated_at, observedAt,
    }
  }

  return {
    source,
    async scan(cursor = '1') {
      if (!/^[1-9][0-9]*$/.test(cursor)) throw new TrackerError('bad_response')
      const url = `${issues}?state=all&per_page=100&sort=updated&direction=desc&page=${cursor}`
      const response = await request(url)
      const body = await json(response)
      if (!Array.isArray(body)) throw new TrackerError('bad_response')
      const items = body.filter((item: unknown) => {
        if (!isObject(item)) throw new TrackerError('bad_response')
        return !Object.hasOwn(item, 'pull_request')
      }).map(observation)
      const nextCursor = nextPage(response.headers.get('link') ?? '', url)
      return nextCursor ? { items, nextCursor, complete: false } : { items, complete: true }
    },
    async get(ref) {
      if (ref.source !== source || !/^[1-9][0-9]*$/.test(ref.displayId)) throw new TrackerError('bad_source')
      const response = await request(`${issues}/${ref.displayId}`)
      // GitHub also returns 404 for private issues the caller cannot access.
      if ([401, 403, 404].includes(response.status)) return 'inaccessible'
      const item = await json(response)
      if (!isObject(item)) throw new TrackerError('bad_response')
      if (Object.hasOwn(item, 'pull_request')) return 'gone'
      const result = observation(item)
      return result.ref.itemId === ref.itemId ? result : 'gone'
    },
    async comment(ref, body, opId) {
      const marker = commentMarker(body, opId)
      if (ref.source !== source || !/^[1-9][0-9]*$/.test(ref.displayId)
        || !Number.isSafeInteger(Number(ref.displayId))) throw new TrackerError('bad_source')
      const endpoint = `${issues}/${ref.displayId}/comments`
      let page: string | undefined
      for (let count = 0; count < 10; count++) {
        const url: string = `${endpoint}?per_page=100${page ? `&page=${page}` : ''}`
        const response = await request(url)
        const comments = await json(response)
        if (!Array.isArray(comments)) throw new TrackerError('bad_response')
        for (const comment of comments as unknown[]) {
          if (!isObject(comment) || typeof comment.body !== 'string') throw new TrackerError('bad_response')
          if (!comment.body.includes(marker)) continue
          const { id } = comment
          if (!(typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
            && !(typeof id === 'string' && id)) throw new TrackerError('bad_response')
          return { receipt: String(id), alreadyApplied: true }
        }
        page = nextPage(response.headers.get('link') ?? '', url)
        if (!page) break
      }
      if (page) throw new TrackerError('unavailable')
      const created = await json(await request(endpoint, JSON.stringify({ body: `${body}\n${marker}` })))
      if (!isObject(created) || typeof created.node_id !== 'string' || !created.node_id) {
        throw new TrackerError('bad_response')
      }
      return { receipt: created.node_id, alreadyApplied: false }
    },
  }
}
