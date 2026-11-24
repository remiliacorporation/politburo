import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { connect } from '../src/client/node.ts'
import { http } from '../src/backend-http/index.ts'
import { inspector } from '../src/inspect/handler.ts'
import { board } from '../src/server/index.ts'
import { bearer, BOARD_URL, personToken, testBoard } from './harness.ts'

const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)).catch(() => {})))
})

/** A listener that records each request's method, path and body, and answers with `answer`. */
async function listen(answer: (res: import('node:http').ServerResponse, one: { method: string | undefined; url: string | undefined }) => void) {
  const seen: { method: string | undefined; url: string | undefined; body: string }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() })
      answer(res, { method: req.method, url: req.url })
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const SECRET = 'file-or-claim-body-that-must-stay-home'

describe('an inspector upload through a handle on another board over http()', () => {
  it('is refused its redirect, and the second URL sees nothing', async () => {
    const team = testBoard()
    const token = await personToken('u_julian')
    const elsewhere = await listen((res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'))
    const configured = await listen((res) => res.writeHead(307, { location: `${elsewhere.url}/stolen` }).end())
    // The board answers all but the upload, which goes to a real server that redirects, through fetch as it follows.
    const fetch = bearer(async (input, init) => {
      const request = new Request(input, init)
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/board/attachments') return team.fetch(request)
      return globalThis.fetch(`${configured.url}/attachments`, { method: 'POST', headers: request.headers, body: await request.text(), ...(init?.redirect ? { redirect: init.redirect } : {}) })
    }, token)
    const handle = board({ backend: http(BOARD_URL, { fetch }) }).as(null)
    const page = inspector({ board: handle, basePath: '/board/' })
    const origin = 'https://factory.example.com'

    const response = await page(
      new Request(`${origin}/board/board/attachments`, {
        method: 'POST',
        headers: { 'x-inspect-token': 'page', 'sec-fetch-site': 'same-origin', origin, 'x-board-profile': 'claude', 'content-type': 'text/plain', 'x-board-filename': 'notes.txt' },
        body: SECRET,
      }),
    )

    expect(response.status).toBe(502)
    expect(elsewhere.seen).toEqual([])
    expect(configured.seen.map((one) => one.body)).toEqual([SECRET])
  })
})

describe("the Node transport, asked for a request's redirect itself", () => {
  const send = async (location: string | null, bodyOf: (url: string) => Response) => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
    const calls: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      calls.push(new Request(input).url)
      return bodyOf(new Request(input).url)
    }) as typeof globalThis.fetch
    const url = 'https://board.example.com/api/board'
    const client = createBoardClient({ url, fetch: connect(url, { token: 'runtime-token', fetch }).fetch })
    const error = await client.tasks.held('task-1', { epoch: 1, token: SECRET }).renew().catch((e: { code?: string }) => e)
    return { calls, error, location }
  }

  it.each([
    ['a redirect to the SSO wall', 'https://vercel.com/sso-api?url=x'],
    ['a Location that is not a URL', 'http://[bad'],
    ['a redirect to another origin', 'https://other.example.com/steal'],
  ])('refuses %s with redirect_refused after one request', async (_name, location) => {
    const { calls, error } = await send(location, () => new Response(null, { status: 307, headers: { location } }))

    expect(error).toMatchObject({ code: 'redirect_refused' })
    expect(calls).toHaveLength(1)
  })

  it('still answers an unflagged GET that is redirected to a Location that is not a URL with that redirect', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
    const fetch = (async () => new Response(null, { status: 307, headers: { location: 'http://[bad' } })) as typeof globalThis.fetch
    const url = 'https://board.example.com/api/board'

    const response = await connect(url, { token: 'runtime-token', fetch }).fetch(`${url}/me`)

    expect(response.status).toBe(307)
  })
})
