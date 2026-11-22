import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { test, type TestContext } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { parseMembers } from '../src/identity/index.ts'
import { serveBoard } from '../src/identity/serve.ts'

const teamDomain = 'issuer.example.test'
const publicHost = 'board.example.test'
const audience = 'test-board'
const email = 'owner@company.example'
const person = 'cloudflare:person:owner.at.company.example'
const member = { email, can: { work: ['read', 'post'] } }
const keypair = generateKeyPair('RS256')
const now = new Date()
const iat = Math.floor(now.getTime() / 1000)

async function sign(claims: JWTPayload = {}, key?: Awaited<typeof keypair>['privateKey']) {
  return new SignJWT({ sub: 'account', email, iss: `https://${teamDomain}`, aud: audience, iat, exp: iat + 3600, ...claims })
    .setProtectedHeader({ alg: 'RS256' }).sign(key ?? (await keypair).privateKey)
}

async function start(t: TestContext, members: unknown[] = [member], dir?: string) {
  const keys = createLocalJWKSet({ keys: [await exportJWK((await keypair).publicKey)] })
  const board = await serveBoard({ dir, memory: dir === undefined, tunnelPort: 0, publicHosts: [publicHost],
    teamDomain, audience, keys, members: parseMembers({ members }), now: () => now })
  t.after(board.close)
  assert.ok(board.tunnelUrl?.startsWith('http://127.0.0.1:'))
  const request = (path: string, jwt?: string, body?: unknown, headers?: Record<string, string>) => fetch(board.tunnelUrl + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(jwt === undefined ? {} : { 'cf-access-jwt-assertion': jwt }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ...board, request, browserPost: (jwt: string, overrides: Record<string, string | undefined> = {}) =>
    new Promise<number | undefined>((resolve, reject) => {
      const headers = new Headers({ host: publicHost, origin: `https://${publicHost}`, 'sec-fetch-site': 'same-origin',
        'cf-access-jwt-assertion': jwt, 'content-type': 'application/json' })
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) headers.delete(key)
        else headers.set(key, value)
      }
      const req = httpRequest(`${board.tunnelUrl}/messages`, { method: 'POST', headers: Object.fromEntries(headers) }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      req.on('error', reject)
      req.end(JSON.stringify(post))
    }),
  }
}

const post = { channel: 'work', text: 'a colleague wrote this' }

async function status(reply: Promise<Response>, expected: number, label?: string) {
  const res = await reply
  const code = res.status !== expected && res.headers.get('content-type')?.includes('application/json')
    ? (await res.json()).error?.code : undefined
  await res.body?.cancel().catch(() => {})
  assert.equal(res.status, expected, label ?? code ?? '')
}

test('a signed colleague could post as another actor or read outside the registry grant', async (t) => {
  const { request, handle, browserPost } = await start(t)
  const jwt = await sign({ email: email.toUpperCase() })
  const me = await request('/me', jwt)
  assert.equal(me.status, 200)
  const { actor, principal, kind } = await me.json()
  assert.deepEqual({ actor, principal, kind }, { actor: person, principal: person, kind: 'person' })
  assert.equal(await browserPost(jwt), 201)
  const { messages } = await handle.channel('work').messages()
  assert.deepEqual(messages.map(({ by, text }) => [by.actor, by.principal, text]), [[person, person, post.text]])
  const privateMessage = await handle.post('private', 'not for this member')
  await status(request('/messages?channel=private', jwt), 403)
  await status(request(`/messages/${encodeURIComponent(privateMessage.id)}`, jwt), 404)
})

test('invalid assertions, alternate credentials, or cross-site writes could reach the board or inspector', async (t) => {
  const { request, handle, browserPost } = await start(t)
  const jwt = await sign()
  const bearer = { authorization: `Bearer ${jwt}` }
  const unsigned = await request('/')
  assert.equal(unsigned.status, 401)
  assert.deepEqual(await unsigned.json(), { error: { code: 'unauthorized', message: 'Cloudflare Access sign-in required' } })
  await status(request('/inspect'), 401)
  await status(request('/inspect', jwt), 404)
  await status(request('/me', undefined, undefined, bearer), 401)
  await status(request('/me', undefined, undefined, { cookie: `CF_Authorization=${jwt}`, 'tailscale-user-login': email }), 401)
  const wrongKey = (await generateKeyPair('RS256')).privateKey
  for (const [label, assertion] of [
    ['missing', undefined], ['wrong key', await sign({}, wrongKey)], ['expired', await sign({ exp: iat - 1 })],
    ['wrong audience', await sign({ aud: 'other-board' })], ['wrong issuer', await sign({ iss: 'https://other.example.test' })],
  ] as const) await status(request('/messages', assertion, post), 401, label)
  assert.equal(await browserPost(jwt, { host: teamDomain, origin: undefined }), 403, 'host')
  assert.equal(await browserPost(jwt, { 'sec-fetch-site': 'same-site' }), 403, 'fetch metadata')
  assert.equal(await browserPost(jwt, { origin: 'https://other.example.test' }), 403, 'origin')
  assert.equal((await handle.threads({ channel: 'work' })).threads.length, 0)
})

test('the owner email could impersonate the owner, or removed members could keep their grants after restart', async (t) => {
  const dir = await mkdtemp('test-swarm-board-')
  const members = [member, { email: 'manager@company.example', can: { '*': 'all' } }]
  try {
    const first = await start(t, members, dir)
    const ownerGrant = { principals: [{ kind: 'user' as const, userId: 'owner' }], can: { '*': 'all' as const } }
    const { grant } = await first.handle.createGrant(ownerGrant)
    const jwt = await sign()
    const originalGrants = await first.handle.grants()
    try {
      assert.equal((await (await first.request('/me', jwt)).json()).principal, person)
      await status(first.request('/control/pause', jwt, { reason: 'no manage' }), 403)
      await status(first.request('/grants', jwt, ownerGrant), 403)
      await status(first.request('/threads', await sign({ email: 'unknown@company.example' })), 403)
      await status(first.request('/control/pause', await sign({ email: 'manager@company.example' }), { reason: 'explicit manage' }), 200)
    } finally {
      await first.close()
    }
    const unchanged = await start(t, members, dir)
    try {
      assert.deepEqual(await unchanged.handle.grants(), originalGrants)
    } finally {
      await unchanged.close()
    }
    const next = await start(t, [], dir)
    try {
      assert.deepEqual(await next.handle.grants(), [grant])
      await status(next.request('/threads', jwt), 403)
    } finally {
      await next.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a service-token assertion could read or post on the board', async (t) => {
  const { handle, request } = await start(t)
  for (const claims of [{ email: undefined, common_name: 'service-client' }, { common_name: 'service-client' }, { type: 'non_identity' }]) {
    const jwt = await sign(claims)
    await status(request('/threads', jwt), 401)
    await status(request('/messages', jwt, post), 401)
  }
  assert.equal((await handle.threads({ channel: 'work' })).threads.length, 0)
})
