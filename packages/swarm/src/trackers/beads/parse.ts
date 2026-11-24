type IssueRow = { id: string; title: string; status: string; priority?: number; issue_type?: string }
type Dependency = { issue_id?: string; depends_on_id: string; type: string }
export type BdIssue = IssueRow & {
  parent?: string; assignee?: string; external_ref?: string; defer_until?: string
  closed_at?: string; close_reason?: string; reason?: string; dependencies: Dependency[]
}
export type BdBlocked = IssueRow & { blocked_by: string[]; blocked_by_count?: number }

export class BdParseError extends Error {
  constructor(verb: string) {
    super(`invalid bd ${verb} output`)
    this.name = 'BdParseError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clean(text: string): string {
  return text.replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)*/g, '[redacted]')
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? clean(value) : undefined
}

export const beadId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function identifier(value: unknown, verb: string): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!beadId.test(value)) throw new BdParseError(verb)
  return value
}

function externalRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const url = URL.parse(value)
  if (url?.protocol === 'http:' || url?.protocol === 'https:') return url.origin
  return /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/.test(value) ? value : undefined
}

function rows(stdout: string, verb: string) {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new BdParseError(verb)
  }
  if (!Array.isArray(value)) throw new BdParseError(verb)
  return value.map((row: unknown) => {
    if (!isObject(row) || typeof row.status !== 'string') throw new BdParseError(verb)
    const id = identifier(row.id, verb)
    if (id === undefined) throw new BdParseError(verb)
    const issue: IssueRow = {
      id, status: clean(row.status), title: text(row.title) ?? '',
      priority: typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : undefined,
      issue_type: text(row.issue_type),
    }
    const parent = identifier(row.parent, verb)
    const dependencies: Dependency[] = []
    if (Array.isArray(row.dependencies)) {
      for (const dep of row.dependencies) {
        if (!isObject(dep)) continue
        const issue_id = identifier(dep.issue_id, verb)
        const depends_on_id = identifier(dep.depends_on_id, verb)
        if (depends_on_id !== undefined && typeof dep.type === 'string') {
          dependencies.push({ issue_id, depends_on_id, type: clean(dep.type) })
        }
      }
    }
    const blocked_by: string[] = []
    if (Array.isArray(row.blocked_by)) {
      for (const entry of row.blocked_by) {
        const blocker = identifier(entry, verb)
        if (blocker !== undefined) blocked_by.push(blocker)
      }
    }
    return { row, issue, parent, dependencies, blocked_by }
  })
}

export function parseIssues(stdout: string, verb: 'list' | 'ready' = 'list'): BdIssue[] {
  return rows(stdout, verb).map(({ row, issue, parent, dependencies }) => {
    const assignee = text(row.assignee)
    return {
      ...issue, dependencies, parent,
      assignee: assignee === row.assignee ? assignee : undefined,
      external_ref: externalRef(row.external_ref), defer_until: text(row.defer_until),
      closed_at: text(row.closed_at), close_reason: text(row.close_reason), reason: text(row.reason),
    }
  })
}

export function parseBlocked(stdout: string): BdBlocked[] {
  return rows(stdout, 'blocked').map(({ row, issue, blocked_by }) => ({
    ...issue, blocked_by,
    blocked_by_count: typeof row.blocked_by_count === 'number' ? row.blocked_by_count : undefined,
  }))
}
