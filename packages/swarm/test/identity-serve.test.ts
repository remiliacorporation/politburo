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
const managerEmail = 'manager@company.example'
const manager = { email: managerEmail, can: { '*': 'all' } }
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
  const headers = { 'x-board-profile': 'reviewer', 'x-board-handle': 'someone-else' }
  const me = await request('/me', jwt, undefined, headers)
  assert.equal(me.status, 200)
  const { actor, principal, kind, handle: name } = await me.json()
  assert.deepEqual({ actor, principal, kind, name }, { actor: person, principal: person, kind: 'person', name: 'owner' })
  assert.equal(await browserPost(jwt, { ...headers, host: publicHost.toUpperCase() }), 201)
  const { messages } = await handle.channel('work').messages()
  assert.deepEqual(messages.map(({ by, text }) => [by.actor, by.principal, text]), [[person, person, post.text]])
  const privateMessage = await handle.post('private', 'not for this member')
  await status(request('/messages?channel=private', jwt), 403)
  await status(request(`/messages/${encodeURIComponent(privateMessage.id)}`, jwt), 404)
})

test('invalid assertions, alternate credentials, or cross-site writes could reach the board or inspector', async (t) => {
  const { request, handle, browserPost, tunnelUrl } = await start(t)
  const jwt = await sign()
  const bearer = { authorization: `Bearer ${jwt}` }
  const unsigned = await request('/')
  assert.equal(unsigned.status, 401)
  assert.deepEqual(await unsigned.json(), { error: { code: 'unauthorized', message: 'Cloudflare Access sign-in required' } })
  await status(request('/inspect'), 401)
  await status(request('/inspect', jwt), 404)
  for (const method of ['HEAD', 'OPTIONS']) await status(fetch(`${tunnelUrl}/me`, { method }), 401, method)
  await status(request('/me', undefined, undefined, bearer), 401)
  for (const headers of [
    { cookie: `CF_Authorization=${jwt}` }, { 'tailscale-user-login': email }, { 'x-board-profile': 'reviewer' },
  ] as Record<string, string>[]) await status(request('/me', undefined, undefined, headers), 401, Object.keys(headers)[0])
  const wrongKey = (await generateKeyPair('RS256')).privateKey
  for (const [reason, assertion] of [
    ['signature', await sign({}, wrongKey)], ['expired', await sign({ exp: iat - 1 })],
    ['audience', await sign({ aud: 'other-board' })], ['issuer', await sign({ iss: 'https://other.example.test' })],
    ['claims', await sign({ exp: undefined })], ['not_yet_valid', await sign({ nbf: iat + 60 })],
    ['not_yet_valid', await sign({ iat: iat + 60 })],
  ] as const) {
    const response = await request('/messages', assertion, post)
    assert.equal(response.status, 401, reason)
    assert.equal((await response.json()).error?.code === reason, true, reason)
  }
  assert.equal(await browserPost(jwt, { host: teamDomain }), 403, 'host')
  assert.equal(await browserPost(jwt, { host: `${publicHost}:443` }), 403, 'unexpected port')
  assert.equal(await browserPost(jwt, { 'sec-fetch-site': 'same-site' }), 403, 'fetch metadata')
  assert.equal(await browserPost(jwt, { origin: 'https://other.example.test' }), 403, 'origin')
  await status(request('/messages', jwt, { ...post, text: 'x'.repeat(8 * 1024 * 1024) }), 413, 'body cap')
  assert.equal((await handle.threads({ channel: 'work' })).threads.length, 0)
})

test('the owner email could impersonate the owner, or removed members could keep their grants after restart', async (t) => {
  const dir = await mkdtemp('test-swarm-board-')
  const members = [member, manager]
  try {
    const first = await start(t, members, dir)
    const ownerGrant = { principals: [{ kind: 'user' as const, userId: 'owner' }], can: { '*': 'all' as const } }
    const { grant } = await first.handle.createGrant(ownerGrant)
    const jwt = await sign()
    try {
      const memberPrincipals = (await first.handle.grants()).filter(({ id }) => id !== grant.id).flatMap(({ principals }) => principals)
      assert.deepEqual(memberPrincipals.map((p) => p.kind === 'user' ? p.userId : p.kind).sort(),
        ['manager.at.company.example', 'owner.at.company.example'])
      assert.equal((await (await first.request('/me', jwt)).json()).principal, person)
      await status(first.request('/control/pause', jwt, { reason: 'no manage' }), 403)
      await status(first.request('/grants', jwt, ownerGrant), 403)
      await status(first.request('/threads', await sign({ email: 'unknown@company.example' })), 403)
      await status(first.request('/control/pause', await sign({ email: managerEmail }), { reason: 'explicit manage' }), 200)
    } finally {
      await first.close()
    }
    const next = await start(t, [{ ...manager, can: { work: ['read'] } }], dir)
    try {
      const grants = await next.handle.grants()
      assert.deepEqual(grants.find(({ id }) => id === grant.id), grant)
      assert.deepEqual(grants.filter(({ id }) => id !== grant.id).map(({ principals, can }) => ({ principals, can })), [
        { principals: [{ kind: 'user', email: null, userId: 'manager.at.company.example' }], can: { work: ['read'] } },
      ])
      await status(next.request('/threads', jwt), 403)
      const retained = await sign({ email: managerEmail })
      await status(next.request('/messages?channel=work', retained), 200)
      await status(next.request('/messages', retained, post), 403)
    } finally {
      await next.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parallel requests can write as the wrong verified colleague', async (t) => {
  const { request, handle } = await start(t, [member, manager])
  const [one, two] = await Promise.all([sign(), sign({ email: managerEmail })])
  await Promise.all([status(request('/messages', one, { ...post, text: 'one' }), 201),
    status(request('/messages', two, { ...post, text: 'two' }), 201)])
  const { messages } = await handle.channel('work').messages()
  assert.deepEqual(messages.map(({ text, by }) => [text, by.actor, by.principal]).sort(), [
    ['one', person, person], ['two', 'cloudflare:person:manager.at.company.example', 'cloudflare:person:manager.at.company.example'],
  ])
})

test('a colleague with read and post but no manage can answer attention', async (t) => {
  const { request, handle } = await start(t, [member, manager])
  const { task } = await handle.tasks.create('work', 'Review this release')
  const path = `/tasks/${task.id}/attention`
  const [ordinary, responder] = await Promise.all([sign(), sign({ email: managerEmail })])
  const commit = 'a'.repeat(40)
  const opened = await request(path, responder, {
    kind: 'awaiting_approval', question: 'Release?', context: 'Release review', commit,
    options: [{ id: 'proceed', label: 'Proceed', consequence: 'Resume work', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Release not approved', next: 'fail' }],
    revision: task.revision, evidence: [{ message: task.id, revision: task.revision }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.equal(opened.status, 201)
  const { attention } = await opened.json()
  const answer = `${path}/${attention.id}/answer`
  await status(request(answer, ordinary, { option: 'proceed', commit }), 403)
  await status(request(answer, responder, { option: 'proceed', commit }), 200)
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
