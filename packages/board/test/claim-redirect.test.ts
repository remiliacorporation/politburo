import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { board } from '../src/server/index.ts'
import { createBoardClient } from '../src/client/client.ts'
import { prepareJoinCredential } from '../src/client/join-config.ts'
import { connect } from '../src/client/node.ts'
import { inspector } from '../src/inspect/handler.ts'
import { startInspector } from '../src/inspect/server.ts'
import { bearer, BOARD_URL, personToken, testBoard } from './harness.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)).catch(() => {})))
})

type Seen = { method: string | undefined; url: string | undefined; headers: IncomingMessage['headers']; body: string }

async function listen(handler: (seen: Seen, respond: { redirect(to: string): void; ok(): void; json(body: unknown): void; status(code: number, to?: string): void }) => void) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const one = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
      seen.push(one)
      handler(one, {
        redirect: (to) => void res.writeHead(307, { location: to }).end(),
        ok: () => void res.writeHead(200, { 'content-type': 'application/json' }).end('{"task":{}}'),
        json: (body) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)),
        status: (code, to) => void res.writeHead(code, to ? { location: to } : {}).end(),
      })
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const SECRET = 'claim-token-that-must-stay-home'
const PACKET = { commit: 'b'.repeat(40), packetPath: 'handoffs/check.md', sha256: 'c'.repeat(64) }

describe('a claim-bearing request that is answered with a redirect', () => {
  it.each(['renew', 'release', 'complete', 'fail', 'priority', 'block', 'handoff'] as const)(
    'a claim\'s %s never sends its token to the URL it redirects to, and says so',
    async (verb) => {
      const elsewhere = await listen((_, respond) => respond.ok())
      const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
      // The default fetch follows redirects: a 307 keeps a POST and its body.
      const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
      const held = client.tasks.held('task-1', { epoch: 1, token: SECRET })
      const write = {
        renew: () => held.renew(),
        release: () => held.release(),
        complete: () => held.complete(),
        fail: () => held.fail('no'),
        priority: () => held.priority('low' as never),
        block: () => held.block('stuck'),
        handoff: () => held.handoff(PACKET),
      }[verb]

      await expect(write()).rejects.toMatchObject({ code: 'redirect_refused', origin: 'handle' })

      expect(elsewhere.seen).toEqual([])
      expect(configured.seen).toHaveLength(1)
      expect(configured.seen[0]?.body).toContain(SECRET)
    },
  )

  it('plain tasks.block refuses redirects when given a claim proof', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/other`))
    const client = createBoardClient({ url: configured.url, fetch: globalThis.fetch })
    const opts = { epoch: 1, token: SECRET, kind: 'needs_input' }

    await expect(client.tasks.block('task-1', 'stuck', opts)).rejects.toMatchObject({ code: 'redirect_refused' })
    expect(elsewhere.seen).toEqual([])
    expect(configured.seen.map(({ body }) => JSON.parse(body))).toMatchObject([{ token: SECRET, epoch: 1 }])
  })

  it('a request for a decision that carries a claim\'s proof does not send it to a redirect', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.ask('task-1', { claim: { epoch: 1, token: SECRET } } as never)).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen[0]?.body).toContain(SECRET)
  })

  it('a claim of the next ready task with its own token does not send it to a redirect', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.claim({ channel: 'work', token: SECRET } as never)).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen[0]?.body).toContain(SECRET)
  })

  it('a 305 is refused with the others, since it names another place to send the request', async () => {
    const configured = await listen((_, respond) => respond.status(305))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.held('task-1', { epoch: 1, token: SECRET }).release()).rejects.toMatchObject({ code: 'redirect_refused' })
  })

  it('a read that is not claim-bearing still follows a redirect, as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/me`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await client.me()

    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/me'])
  })

  it('a flagged request is refused whatever its Content-Type says, or whether it has one', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
    const body = new TextEncoder().encode(JSON.stringify({ claim: { epoch: 1, token: SECRET } }))

    for (const headers of [{ 'Content-Type': 'Application/JSON' }, { 'content-type': 'text/plain' }, {}] as Record<string, string>[]) {
      await expect(client.request('/tasks/task-1/attention', { method: 'POST', body, headers, claim: true })).rejects.toMatchObject({ code: 'redirect_refused' })
    }

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen).toHaveLength(3)
    expect(configured.seen.every((one) => one.body.includes(SECRET))).toBe(true)
  })

  it('a flagged request whose body adds the token when it is serialized is refused', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
    const sneaky = { toJSON: () => ({ claim: { epoch: 1, token: SECRET } }) }

    await expect(client.tasks.handoff('task-1', sneaky as never)).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen[0]?.body).toContain(SECRET)
  })

  it('an unflagged upload of a JSON file with a top-level token field follows a redirect as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.status(302, `${elsewhere.url}/uploaded`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
    const file = new TextEncoder().encode(JSON.stringify({ token: 'an unrelated field of the file' }))

    const response = await client.request('/files', { method: 'POST', body: file, headers: { 'content-type': 'application/json' } })

    expect(response.status).toBe(200)
    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/uploaded'])
  })

  it('a decision request with no claim is not flagged, and follows a redirect as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/asked`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await client.tasks.ask('task-1', { question: 'ship it?' } as never).catch(() => {})

    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/asked'])
  })

  it('a claim that brings no token is not a flagged request, and follows a redirect as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/claim`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await client.tasks.create('work', { text: 'a task', claim: true, token: undefined }).catch(() => {})

    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/claim'])
  })
})

describe('the inspector, which forwards the writes of its page', () => {
  it('refuses a redirect to a write, since the write may carry a claim\'s proof', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    // It says who the app is when asked (a read), and redirects a write.
    const configured = await listen((one, respond) => (one.method === 'GET' ? respond.json({ principal: 'local:user:app', profile: null }) : respond.redirect(`${elsewhere.url}/stolen`)))
    const upstream = createBoardClient({ url: configured.url, token: 't', profile: null, fetch: (input, init) => globalThis.fetch(input, init) })
    const handle = inspector({ board: upstream, basePath: '/board/' })
    const origin = 'https://factory.example.com'

    const response = await handle(
      new Request(`${origin}/board/board/tasks/task-1/renew`, {
        method: 'POST',
        headers: { 'x-inspect-token': 'page', 'sec-fetch-site': 'same-origin', origin, 'x-board-profile': 'claude', 'content-type': 'application/json' },
        body: JSON.stringify({ epoch: 1, token: SECRET }),
      }),
    )

    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).toContain('answered a claim')
    expect(elsewhere.seen).toEqual([])
    expect(configured.seen.filter((one) => one.method === 'POST').map((one) => one.body)).toEqual([JSON.stringify({ epoch: 1, token: SECRET })])
  })
})

it('the local Node inspector refuses a redirect to a page write', async ({ onTestFinished }) => {
  const elsewhere = await listen((_, respond) => respond.ok())
  const configured = await listen((one, respond) => {
    if (one.method === 'GET') respond.json({ principal: 'local:user:app', profile: null })
    else respond.redirect(`${elsewhere.url}/other`)
  })
  const client = createBoardClient({ url: configured.url, token: 'test', fetch: globalThis.fetch })
  const page = await startInspector({ client, port: 0, page: '' })
  onTestFinished(() => page.close())
  const html = await (await fetch(page.url)).text()
  const token = /<meta name="inspect-token" content="([^"]+)">/.exec(html)![1]!
  const body = JSON.stringify({ epoch: 1, token: SECRET })
  const response = await fetch(`${page.url}/board/tasks/task-1/renew`, {
    method: 'POST', headers: { 'x-inspect-token': token, origin: page.url, 'content-type': 'application/json' }, body,
  })

  expect(response.status).toBe(502)
  expect(JSON.stringify(await response.json())).toContain('answered a claim')
  expect(elsewhere.seen).toEqual([])
  expect(configured.seen.filter((one) => one.method === 'POST').map((one) => one.body)).toEqual([body])
})

for (const kind of ['guarded', 'joined']) it(`the ${kind} Node transport returns the board redirect to a claim write`, async ({ onTestFinished }) => {
  const elsewhere = await listen((_, respond) => respond.ok())
  const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/sso-api`))
  onTestFinished(() => { vi.unstubAllEnvs() })
  vi.stubEnv('VERCEL', '1')
  vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
  if (kind === 'joined') {
    const home = await mkdtemp(join(tmpdir(), 'board-claim-redirect-'))
    onTestFinished(() => rm(home, { recursive: true, force: true }))
    vi.stubEnv('XDG_CONFIG_HOME', home)
    vi.stubEnv('BOARD_TOKEN', undefined)
    const credential = await prepareJoinCredential(configured.url)
    await credential.save(`vbj_${'a'.repeat(43)}`)
  }
  const transport = connect(configured.url, kind === 'guarded' ? { token: 'test' } : {})
  const client = createBoardClient({ url: configured.url, fetch: transport.fetch })

  await expect(client.tasks.held('t', { epoch: 1, token: SECRET }).renew())
    .rejects.toMatchObject({ code: 'redirect_refused' })
  expect(elsewhere.seen).toEqual([])
  expect(configured.seen.map(({ body }) => JSON.parse(body))).toMatchObject([{ token: SECRET }])
})

it.each(['tasks.ask', 'tasks.claim next'] as const)('the HTTP handle refuses redirects for %s', async (op) => {
  const team = testBoard()
  const token = await personToken('u_julian')
  const elsewhere = await listen((_, respond) => respond.ok())
  const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/other`))
  let redirecting = false
  const send = bearer(async (input, init) => {
    const request = new Request(input, init)
    if (redirecting && request.method === 'POST') {
      return globalThis.fetch(`${configured.url}${new URL(request.url).pathname}`, init)
    }
    return team.fetch(request)
  }, token)
  const handle = board({ backend: http(BOARD_URL, { fetch: send }) }).as(null)
  const own = 'A'.repeat(43)
  const { task } = await handle.tasks.create('work', 'Check the release')
  const claim = op === 'tasks.ask' ? await handle.tasks.claim(task.id, { token: own }) : undefined
  redirecting = true
  const write = claim ? handle.tasks.ask(task.id, {
    kind: 'awaiting_approval', question: 'Ship it?', context: '', revision: claim.task.revision,
    commit: 'a'.repeat(40), evidence: [{ message: task.id, revision: claim.task.revision }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    options: [
      { id: 'go', label: 'Ship', consequence: 'Release the build', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Keep the build', next: 'fail' },
    ],
    claim: { epoch: claim.epoch, token: own },
  }) : handle.tasks.claim({ channel: 'work', token: own })

  await expect(write).rejects.toMatchObject({ code: 'redirect_refused' })
  expect(elsewhere.seen).toEqual([])
  expect(configured.seen).toHaveLength(1)
  expect(configured.seen[0]?.body).toContain(own)
})

describe('every verb that carries a claim token flags its request', () => {
  /** What each call sent, when the board answers every request with a 307. */
  async function record(run: (client: ReturnType<typeof createBoardClient>) => Promise<unknown>) {
    const sent: string[] = []
    const client = createBoardClient({
      url: 'http://board.invalid',
      fetch: async (_input, init) => {
        sent.push(typeof init?.body === 'string' ? init.body : '')
        // What fetch gives back for `redirect: 'manual'`; one that follows would go on to the Location.
        return init?.redirect === 'manual' ? new Response(null, { status: 307, headers: { location: 'http://elsewhere.invalid/' } }) : Response.json({})
      },
    })
    const outcome = await run(client).then(() => 'resolved', (error: { code?: string }) => error.code)
    return { outcome, sent: sent.filter((body) => body.includes(SECRET)) }
  }

  const verbs: Record<string, (client: ReturnType<typeof createBoardClient>) => Promise<unknown>> = {
    renew: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).renew(),
    release: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).release(),
    complete: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).complete(),
    fail: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).fail('no'),
    priority: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).priority('low' as never),
    block: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).block('stuck'),
    handoff: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).handoff(PACKET),
    'tasks.handoff': (c) => c.tasks.handoff('t', { epoch: 1, token: SECRET } as never),
    'tasks.ask': (c) => c.tasks.ask('t', { claim: { epoch: 1, token: SECRET } } as never),
    'tasks.claim by id': (c) => c.tasks.claim('t', { token: SECRET }),
    'tasks.claim next': (c) => c.tasks.claim({ channel: 'work', token: SECRET } as never),
    'tasks.create': (c) => c.tasks.create('work', { text: 'a task', claim: true, token: SECRET }),
  }

  it.each(Object.keys(verbs))('%s', async (name) => {
    const { outcome, sent } = await record(verbs[name]!)

    expect(outcome).toBe('redirect_refused')
    expect(sent).toHaveLength(1)
  })

  it('through a handle on another board over http(), each claim write is refused its redirect', async () => {
    const team = testBoard()
    const token = await personToken('u_julian')
    let redirecting = false
    const sent: string[] = []
    const fetch = bearer(async (input, init) => {
      const request = new Request(input, init)
      const body = await request.clone().text()
      if (!redirecting || !body.includes('"token"')) return team.fetch(request)
      sent.push(body)
      return new Response(null, { status: 307, headers: { location: 'http://elsewhere.invalid/' } })
    }, token)
    const handle = board({ backend: http(BOARD_URL, { fetch }) }).as(null)
    const writes: Record<string, (claim: NonNullable<Awaited<ReturnType<typeof handle.tasks.claim>>>) => Promise<unknown>> = {
      renew: (claim) => claim.renew(),
      priority: (claim) => claim.priority('low' as never),
      block: (claim) => claim.block('stuck'),
      handoff: (claim) => claim.handoff(PACKET),
      fail: (claim) => claim.fail('no'),
      release: (claim) => claim.release(),
      complete: (claim) => claim.complete(),
    }

    for (const [name, write] of Object.entries(writes)) {
      const { task } = await handle.tasks.create('work', `for ${name}`)
      const claim = await handle.tasks.claim(task.id, { lease: 30 })
      sent.length = 0
      redirecting = true
      await expect(write(claim), name).rejects.toMatchObject({ code: 'redirect_refused' })
      redirecting = false
      expect(sent, name).toHaveLength(1)
    }

    // A claim and a create that bring their own token, and a decision request with a claim's proof.
    const own = 'A'.repeat(43)
    const { task: second } = await handle.tasks.create('work', 'for its own token')
    redirecting = true
    await expect(handle.tasks.claim(second.id, { token: own })).rejects.toMatchObject({ code: 'redirect_refused' })
    await expect(handle.tasks.create('work', { text: 'claimed on creation', claim: true, token: own })).rejects.toMatchObject({ code: 'redirect_refused' })
    expect(sent.filter((body) => body.includes(own))).toHaveLength(2)
  })
})
