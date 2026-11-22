import { once } from 'node:events'
import { createServer } from 'node:http'
import type { TestContext } from 'node:test'

export const linearIssue = (n: number, type: string, priority: number, labels: string[] = []) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, identifier: `KEY-${n}`,
  title: `issue ${n}`, url: `https://example.invalid/issue/${n}`, updatedAt: '2026-01-02T00:00:00Z',
  state: { name: '1', type }, priority,
  labels: { nodes: labels.map((name) => ({ name })), pageInfo: { hasNextPage: false } },
  assignee: n === 7 ? { id: '1' } : null,
})
const first = linearIssue(7, 'triage', 1, ['work:plb-1'])
const pages = [[first, linearIssue(8, 'backlog', 2), linearIssue(9, 'unstarted', 3)],
  [linearIssue(10, 'started', 4), linearIssue(11, 'completed', 0)],
  [linearIssue(12, 'canceled', 0), linearIssue(13, '1', 0)]]

export async function fakeLinear(t: TestContext, options: {
  singleIssue?: Omit<ReturnType<typeof linearIssue>, 'labels'> & {
    labels: { nodes: { name: string }[]; pageInfo?: unknown }
  }
  failure?: 401 | 500 | 'errors' | 'rate' | 'missing-labels'
} = {}) {
  const requests: { authorization?: string; elsewhere: string }[] = []
  const rejected: string[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const { authorization, ...headers } = req.headers
    requests.push({ authorization, elsewhere: JSON.stringify([req.method, req.url, headers, raw]) })
    function reply(status: number, body: unknown = { id: status }) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    let query: string | undefined, variables: Record<string, unknown> | undefined
    try { ({ query, variables } = JSON.parse(raw)) } catch { /* reject below */ }
    // Only accept a single explicit query; collapse nested selection sets before checking.
    let operation = typeof query === 'string' ? query.trim() : ''
    while (/\{[^{}]*\}/.test(operation)) operation = operation.replace(/\{[^{}]*\}/g, '§')
    if (req.method !== 'POST' || !/^query(?:\s+\w+)?\s*(?:\([^{}§]*\)\s*)?§$/.test(operation)) {
      rejected.push(req.method ?? '')
      return reply(405)
    }
    const { failure, singleIssue } = options
    if (typeof failure === 'number') return reply(failure)
    const document = query ?? ''
    const requestsLabelPageInfo = /labels\s*\{\s*nodes\s*\{\s*name\s*\}\s*pageInfo\s*\{\s*hasNextPage\s*\}/.test(document)
    const selectLabels = (issue: NonNullable<typeof singleIssue>) => requestsLabelPageInfo
      ? issue : { ...issue, labels: { nodes: issue.labels.nodes } }
    if (/\{\s*issue\s*\(/.test(document)) {
      const id = variables?.id
      const issue = singleIssue ? (id === singleIssue.id ? singleIssue : null)
        : (id === first.id || id === pages[0]![1]!.id ? first : null)
      return reply(200, { data: { issue: issue && selectLabels(issue) } })
    }
    if (!/\{\s*issues\s*\(/.test(document) || variables?.key !== 'KEY') return reply(400)
    const page = [null, '2', '3'].indexOf(variables.cursor as string | null)
    if (page === -1) return reply(400)
    const nodes = failure === 'missing-labels' ? [{ ...first, labels: undefined }]
      : (singleIssue ? [singleIssue] : pages[page]!).map(selectLabels)
    const result = { issues: { nodes, pageInfo: { hasNextPage: !singleIssue && page < 2, endCursor: String(page + 2) } } }
    if (failure === 'errors') return reply(200, { data: result, errors: [{ message: '1' }] })
    if (failure === 'rate') return reply(200, { errors: [{ message: '2', extensions: { code: 'RATELIMITED' } }] })
    return reply(200, { data: result })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  return { baseUrl: `http://127.0.0.1:${address.port}/graphql`, requests, rejected }
}
