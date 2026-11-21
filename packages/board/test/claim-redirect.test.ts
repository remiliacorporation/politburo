import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { board } from '../src/server/index.ts'
import { createBoardClient } from '../src/client/client.ts'
import { bearer, BOARD_URL, personToken, testBoard } from './harness.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)).catch(() => {})))
})

type Seen = { method: string | undefined; url: string | undefined; headers: IncomingMessage['headers']; body: string }

async function listen(handler: (seen: Seen, respond: { redirect(to: string): void; ok(): void; status(code: number): void }) => void) {
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
        status: (code) => void res.writeHead(code).end(),
      })
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const SECRET = 'claim-token-that-must-stay-home'

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
        handoff: () => held.handoff({} as never),
      }[verb]

      await expect(write()).rejects.toMatchObject({ code: 'redirect_refused', origin: 'handle' })

      expect(elsewhere.seen).toEqual([])
      expect(configured.seen).toHaveLength(1)
      expect(configured.seen[0]?.body).toContain(SECRET)
    },
  )

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

  it('a batch whose task carries a token does not send it to a redirect', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.createMany('work', [{ text: 'one', token: SECRET } as never])).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
  })

  it('a 305 is refused with the others, since it names another place to send the request', async () => {
    const configured = await listen((_, respond) => respond.status(305))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.held('task-1', { epoch: 1, token: SECRET }).release()).rejects.toMatchObject({ code: 'redirect_refused' })
  })

  it('a claim that brings no token follows a redirect as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/claim`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    // `token: undefined` is not on the wire: nothing here is a claim's token.
    await client.tasks.create('work', { text: 'a task', claim: true, token: undefined }).catch(() => {})

    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/claim'])
  })

  it('a claim that brings its own token does not send it to a redirect either', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.claim('task-1', { token: SECRET })).rejects.toMatchObject({ code: 'redirect_refused' })
    await expect(client.tasks.create('work', { text: 'a task', claim: true, token: SECRET })).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
  })

  it('a handle on another board over http() refuses it, and the second URL sees nothing', async () => {
    const team = testBoard()
    const token = await personToken('u_julian')
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    let moving = false
    // The board answers everything but a claim's writes once `moving`; those go to a real server that redirects.
    const fetch = bearer(async (input, init) => {
      const request = new Request(input, init)
      const claimWrite = moving && request.method === 'POST' && /\/tasks\/[^/]+\/complete$/.test(new URL(request.url).pathname)
      if (!claimWrite) return team.fetch(request)
      const to = new URL(request.url)
      return globalThis.fetch(`${configured.url}${to.pathname}`, { method: 'POST', headers: request.headers, body: await request.text(), ...(init?.redirect ? { redirect: init.redirect } : {}) })
    }, token)
    const handle = board({ backend: http(BOARD_URL, { fetch }) }).as(null)
    const { task } = await handle.tasks.create('work', 'one task')
    const claim = await handle.tasks.claim(task.id, { lease: 30 })

    moving = true
    await expect(claim.complete()).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
    expect(JSON.stringify(configured.seen)).toContain(claim.token)
  })

  it('a read that is not claim-bearing still follows a redirect, as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/me`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await client.me()

    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/me'])
  })
})
