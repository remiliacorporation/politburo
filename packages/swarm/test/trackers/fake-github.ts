import { once } from 'node:events'
import { createServer } from 'node:http'
import type { TestContext } from 'node:test'

const issue = (number: number, state_reason: string | null, levels: string[], day = 2) => ({
  number, node_id: `I_${number}`, html_url: `https://example.invalid/o/r/issues/${number}`,
  title: `issue ${number}`, state: 'closed', state_reason,
  labels: levels.map((name) => ({ name })), assignees: [{ login: '1' }, { login: '2' }],
  updated_at: `2026-01-0${day}T00:00:00Z`,
})
const completed = issue(7, 'completed', ['P1'])
const withdrawn = issue(8, 'not_planned', ['P0', 'P4'])
const unknown = issue(9, null, [])
const pr = { ...issue(10, 'completed', []), pull_request: {} }
export const failures = {
  401: { reason: 'unauthorized', status: 401, body: '{"id":91001}', headers: {} },
  403: { reason: 'rate_limited', status: 403, body: '{"id":91003}', headers: { 'x-ratelimit-remaining': '0' } },
  500: { reason: 'unavailable', status: 500, body: '{"id":91500}', headers: {} },
  200: { reason: 'bad_response', status: 200, body: '{"id":91200', headers: {} },
} as const

export async function fakeGitHub(t: TestContext) {
  const requests: { authorization?: string; elsewhere: string }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const { authorization, ...headers } = req.headers
    requests.push({ authorization, elsewhere: JSON.stringify([req.method, req.url, headers, Buffer.concat(chunks).toString()]) })
    const url = new URL(req.url!, `http://${req.headers.host}`)
    function reply(status: number, body: unknown = { id: status }, headers = {}) {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    const [, , , repo, , number] = url.pathname.split('/')
    if (number === '7') return reply(200, completed)
    if (number === '10') return reply(200, pr)
    if (number === '11') return reply(403)
    const failure = failures[Number(number ?? repo) as keyof typeof failures]
    if (failure) return reply(failure.status, failure.body, failure.headers)
    if (number) return reply(404)
    const page = url.searchParams.get('page')
    if (page === '1') {
      const malformed = /^(labels|assignees)-(missing|scalar)$/.exec(repo ?? '')
      if (malformed) return reply(200, [{ ...completed, [malformed[1]!]: malformed[2] === 'missing' ? undefined : 'invalid' }])
      if (repo === 'tie-forward' || repo === 'tie-reverse') {
        const revisions = [{ ...completed, title: 'Z revision' }, { ...completed, title: 'a revision' }]
        return reply(200, repo === 'tie-forward' ? revisions : revisions.reverse())
      }
      const rel = repo === 'next-first' ? 'next alternate' : repo === 'next-last' ? 'alternate next'
        : repo === 'no-next' ? 'alternate nextish' : 'next'
      const link = `<${url.origin}${url.pathname}?page=1>; rel="first", <${url.origin}${url.pathname}?page=3>; rel="${rel}"`
      return reply(200, repo === '2' ? [issue(12, null, [])] : [completed, pr, withdrawn], { link })
    }
    if (page === '3') return repo === '2' ? reply(500) : reply(200, [unknown,
      issue(7, 'not_planned', ['P3'], 3), issue(8, 'completed', ['P2'], 1)], {
      link: `<${url.origin}${url.pathname}?page=1>; rel="prev"`,
    })
    return reply(404)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests }
}
