import { parseSourceId, TrackerError, type ItemState, type Observation, type TrackerAdapter } from './types.ts'

export type LinearOptions = {
  source: string
  baseUrl?: string
  token: () => string | undefined
  fetch?: typeof fetch
  now?: () => Date | number | string
}

const fields = 'id identifier title url priority updatedAt state { name type } labels { nodes { name } pageInfo { hasNextPage } } assignee { id }'
const scanQuery = `query ScanIssues($key: String!, $cursor: String) {
  issues(filter: { team: { key: { eq: $key } } }, first: 100, after: $cursor, orderBy: updatedAt) {
    nodes { ${fields} }
    pageInfo { hasNextPage endCursor }
  }
}`
const getQuery = `query GetIssue($id: String!) { issue(id: $id) { ${fields} } }`
const priorities = ['none', 'urgent', 'high', 'normal', 'low'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stateOf(type: string): ItemState {
  if (type === 'triage' || type === 'backlog' || type === 'unstarted' || type === 'started') return 'open'
  if (type === 'completed') return 'done'
  if (type === 'canceled') return 'withdrawn'
  return 'unknown'
}

function unauthorized(response: Response): boolean {
  return response.status === 401 || response.status === 403
}

async function data(response: Response): Promise<Record<string, unknown>> {
  if (unauthorized(response)) throw new TrackerError('unauthorized')
  if (!response.ok) throw new TrackerError('bad_response')
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new TrackerError(error instanceof TypeError ? 'unavailable' : 'bad_response')
  }
  if (!isObject(body)) throw new TrackerError('bad_response')
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors)) throw new TrackerError('bad_response')
    if (body.errors.some((error: unknown) => isObject(error) && isObject(error.extensions)
      && error.extensions.code === 'RATELIMITED')) throw new TrackerError('rate_limited')
    if (body.errors.length) throw new TrackerError('bad_response')
  }
  if (!isObject(body.data)) throw new TrackerError('bad_response')
  return body.data
}

export function linearAdapter({ source, token, baseUrl = 'https://api.linear.app/graphql',
  fetch: send = globalThis.fetch, now = () => new Date(),
}: LinearOptions): TrackerAdapter {
  const { kind, scope } = parseSourceId(source)
  if (kind !== 'linear') throw new TrackerError('bad_source')
  const teamIdentifier = new RegExp(`^${scope}-[0-9]+$`)

  async function request(query: string, variables: Record<string, string | null>) {
    let credential: string | undefined
    try { credential = token() } catch { throw new TrackerError('no_credential') }
    if (!credential?.trim()) throw new TrackerError('no_credential')
    let response: Response
    try {
      response = await send(baseUrl, { method: 'POST', headers: {
        Authorization: credential, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ query, variables }) })
    } catch {
      throw new TrackerError('unavailable')
    }
    if (response.status === 429) throw new TrackerError('rate_limited')
    if (response.status >= 500) throw new TrackerError('unavailable')
    return response
  }

  function observation(item: unknown): Observation {
    if (!isObject(item)) throw new TrackerError('bad_response')
    const { id, identifier, url, updatedAt, title, state, priority, labels, assignee } = item
    const assigneeId = assignee === null ? null : isObject(assignee) ? assignee.id : undefined
    if (typeof id !== 'string' || !id || typeof identifier !== 'string' || !identifier
      || typeof url !== 'string' || typeof title !== 'string'
      || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))
      || !isObject(state) || typeof state.name !== 'string' || typeof state.type !== 'string'
      || typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 4
      || !isObject(labels) || !Array.isArray(labels.nodes)
      || !isObject(labels.pageInfo) || labels.pageInfo.hasNextPage !== false
      || (assigneeId !== null && (typeof assigneeId !== 'string' || !assigneeId))) {
      throw new TrackerError('bad_response')
    }
    const names = labels.nodes.map((label: unknown) => {
      if (!isObject(label) || typeof label.name !== 'string') throw new TrackerError('bad_response')
      return label.name
    })
    let observedAt: string
    try { observedAt = new Date(now()).toISOString() } catch { throw new TrackerError('unavailable') }
    return {
      ref: { source, itemId: id, displayId: identifier, url },
      title, rawState: state.name, state: stateOf(state.type), priority: priorities[priority]!, labels: names,
      assignees: assigneeId === null ? [] : [assigneeId], updatedAt, observedAt,
    }
  }

  return {
    source,
    async scan(cursor) {
      const { issues } = await data(await request(scanQuery, { key: scope, cursor: cursor ?? null }))
      if (!isObject(issues) || !Array.isArray(issues.nodes) || !isObject(issues.pageInfo)) {
        throw new TrackerError('bad_response')
      }
      const { hasNextPage, endCursor } = issues.pageInfo
      if (typeof hasNextPage !== 'boolean' || (endCursor !== null && typeof endCursor !== 'string')) {
        throw new TrackerError('bad_response')
      }
      const items = issues.nodes.map(observation)
      if (items.some(({ ref }) => !teamIdentifier.test(ref.displayId))) throw new TrackerError('bad_response')
      if (!hasNextPage) return { items, complete: true }
      if (!endCursor) throw new TrackerError('bad_response')
      return { items, nextCursor: endCursor, complete: false }
    },
    async get(ref) {
      if (ref.source !== source || !ref.itemId) throw new TrackerError('bad_source')
      const response = await request(getQuery, { id: ref.itemId })
      if (unauthorized(response)) return 'inaccessible'
      const { issue } = await data(response)
      if (issue === null) return 'gone'
      const result = observation(issue)
      if (result.ref.itemId !== ref.itemId) return 'gone'
      return teamIdentifier.test(result.ref.displayId) ? result : 'inaccessible'
    },
  }
}