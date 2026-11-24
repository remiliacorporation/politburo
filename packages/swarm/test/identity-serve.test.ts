import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { test, type TestContext } from 'node:test'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
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

async function start(t: TestContext, members: unknown[] = [member, manager], dir?: string, publicHosts = [publicHost]) {
  const keys = createLocalJWKSet({ keys: [await exportJWK((await keypair).publicKey)] })
  const board = await serveBoard({ dir, memory: dir === undefined, tunnelPort: 0, publicHosts,
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

async function tempDir(t: TestContext) {
  const dir = await mkdtemp('test-swarm-board-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function onDisk<T>(dir: string, run: (handle: ReturnType<typeof board>) => Promise<T>) {
  const backend = local({ dir })
  try { return await run(board({ backend })) } finally { await backend.close() }
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000,
  })
  if (result.error) throw result.error
  return result
}

async function serveArgs(dir: string, members: unknown[]) {
  const file = join(dir, 'members.json')
  await writeFile(file, JSON.stringify({ members }))
  return ['serve', '--dir', join(dir, 'board'), '--members', file, '--team-domain', teamDomain, '--audience', audience]
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
  await status(request('/messages/?channel=private', jwt), 403)
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

test('the owner email could impersonate the owner, or a registry downgrade could leave excess access after restart', async (t) => {
  const dir = await tempDir(t)
  const members = [member, manager]
  const first = await start(t, members, dir)
  const ownerGrant = { principals: [{ kind: 'user' as const, userId: 'owner' }], can: { '*': 'all' as const } }
  const { grant } = await first.handle.createGrant(ownerGrant)
  const jwt = await sign()
  const before = await sign({ email: managerEmail })
  try {
    assert.equal((await (await first.request('/me', jwt)).json()).principal, person)
    await status(first.request('/control/pause', jwt, { reason: 'no manage' }), 403)
    await status(first.request('/grants', jwt, ownerGrant), 403)
    await status(first.request('/threads', await sign({ email: 'unknown@company.example' })), 403)
    await status(first.request('/control/pause', before, { reason: 'explicit manage' }), 200)
  } finally { await first.close() }
  const newAdmin = { ...manager, email: 'new@company.example', can: { '*': ['manage'] } }
  const next = await start(t, [{ ...manager, can: { work: ['read'] } }, newAdmin], dir)
  try {
    assert.ok((await next.handle.grants()).some(({ id }) => id === grant.id))
    await status(next.request('/control/resume', await sign({ email: newAdmin.email }), { reason: 'new admin' }), 200)
    await status(next.request('/threads', jwt), 403)
    await status(next.request('/messages?channel=work', before), 200)
    await status(next.request('/messages', before, post), 403)
    await status(next.request('/messages', before, { ...post, channel: 'private' }), 403)
  } finally { await next.close() }
})

test('a member removed from the registry can still read a channel through /messages?channel=', async (t) => {
  const dir = await tempDir(t)
  const jwt = await sign()
  const path = '/messages?channel=work'
  const first = await start(t, [member, manager], dir)
  try {
    await status(first.request('/messages', jwt, post), 201)
    await status(first.request(path, jwt), 200)
  } finally { await first.close() }

  const next = await start(t, [{ ...member, can: { other: ['read'] } }, manager], dir)
  try {
    await status(next.request('/messages?channel=other', jwt), 200)
    await status(next.request(path, jwt), 403)
  } finally { await next.close() }
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

test('an unexpected broad grant can survive startup or member grants are written before refusal', async (t) => {
  const dir = await tempDir(t)
  const args = await serveArgs(dir, [member, manager])
  const path = join(dir, 'board')
  const ids = await onDisk(path, async (handle) => {
    await handle.createGrant({ principals: [{ kind: 'all-users' }], can: { '*': 'all' } })
    return (await handle.grants()).map(({ id }) => id)
  })
  const result = cli(...args, '--tunnel-port', '0', '--public-host', publicHost)
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'error: unexpected_grant\n')
  assert.equal(result.stdout, '')
  assert.deepEqual(await onDisk(path, async (handle) => (await handle.grants()).map(({ id }) => id)), ids)
})

test('an empty registry or one without board-wide manage can strand the board', async (t) => {
  for (const members of [[], [{ ...member, can: { work: ['manage'] } }]]) {
    await assert.rejects(serveBoard({ teamDomain, audience, memory: true, members: parseMembers({ members }) }),
      { message: 'no_administrator' })
  }
  const result = cli(...await serveArgs(await tempDir(t), [member]))
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'error: no_administrator\n')
})

test('a registry whose only administrator has a narrower channel rule can start and cannot resume a paused board', async (t) => {
  const members = [{ ...manager, can: { '*': ['manage'], work: ['read'] } }]
  await assert.rejects(serveBoard({ teamDomain, audience, memory: true, members: parseMembers({ members }) }),
    { message: 'no_administrator' })
  const result = cli(...await serveArgs(await tempDir(t), members))
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'error: no_administrator\n')
})

test('an owner who edited a starting grant in place has it silently revoked', async (t) => {
  const dir = await tempDir(t)
  const edited = await onDisk(dir, async (handle) => [
    await handle.updateGrant('g1', {
      add: [{ kind: 'user', userId: 'guest.at.company.example' }],
      remove: [{ kind: 'all-users' }],
      can: { work: ['read'] },
    }),
    // Even an owner using the reconciliation writer's profile can edit a starting grant.
    await handle.as('swarm-members').updateGrant('g2', {
      add: [{ kind: 'user', userId: 'reviewer.at.company.example' }],
      remove: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }],
      can: { review: ['read', 'post'] },
    }),
  ])
  const running = await serveBoard({ dir, teamDomain, audience, keys: createLocalJWKSet({ keys: [] }),
    members: parseMembers({ members: [manager] }) })
  t.after(running.close)
  const grants = await running.handle.grants()
  for (const { grant } of edited) {
    assert.deepEqual(grants.find(({ id }) => id === grant.id), grant, `edited ${grant.id} must survive startup`)
  }
  assert.equal(grants.some(({ id }) => id === 'g3'), false)
})

test('a customised broad starting grant skips the unexpected-grant check', async (t) => {
  const dir = await tempDir(t)
  const saved = await onDisk(dir, async (handle) => {
    await handle.as('swarm-members').updateGrant('g1', { can: { '*': ['read'] } })
    return await handle.grants()
  })
  await assert.rejects(serveBoard({ dir, teamDomain, audience, keys: createLocalJWKSet({ keys: [] }),
    members: parseMembers({ members: [member, manager] }) }), { message: 'unexpected_grant', reason: 'unexpected_grant' })
  assert.deepEqual(await onDisk(dir, (handle) => handle.grants()), saved)
})

test('a failed replacement write can remove old grants, including the starting grants', async (t) => {
  const dir = await tempDir(t)
  const saved = await onDisk(dir, async (handle) => {
    await handle.as('swarm-members').createGrant({ principals: [{ kind: 'user', userId: 'old' }], can: { '*': 'all' } })
    return (await handle.grants()).map(({ id }) => id)
  })
  const members = new Map(parseMembers({ members: [manager] }))
  members.set(email, { email, can: {} }) // The board rejects an empty grant supplied through the library.
  await assert.rejects(serveBoard({ dir, teamDomain, audience, members }), { code: 'invalid_grant' })
  const grants = await onDisk(dir, (handle) => handle.grants())
  assert.ok(grants.some(({ principals }) => principals.some((p) => p.kind === 'user' && p.userId === 'manager.at.company.example')))
  assert.deepEqual(grants.map(({ id }) => id).filter((id) => saved.includes(id)), saved)
})

test('serve without a tunnel opens or writes the board', async (t) => {
  const dir = await tempDir(t)
  const result = cli(...await serveArgs(dir, [manager]))
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''])
  await assert.rejects(stat(join(dir, 'board')), { code: 'ENOENT' })
})

test('top-level help does not mention serve', () => {
  assert.match(cli('--help').stdout, /swarm serve --help/)
})

test('forwarded board can or legacy scope headers change a signed member’s access', async (t) => {
  const { request } = await start(t)
  const jwt = await sign()
  for (const key of ['x-board-can', 'x-board-scope']) {
    await status(request('/messages', jwt, post, { [key]: 'work=read' }), 201, key)
    await status(request('/messages', jwt, { ...post, channel: 'private' }, { [key]: '*=all' }), 403, key)
  }
})

test('a signed member can redeem a valid invite through the tunnel', async (t) => {
  const { handle, request } = await start(t, undefined, undefined, [])
  const { secret } = await handle.createInvite({ name: 'guest' })
  const response = await request('/invites/redeem/', await sign(), { secret })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error?.code, 'not_on_tunnel')
  assert.equal((await handle.invites())[0]?.state, 'pending')
})

test('a member with manage can change grants through the tunnel', async (t) => {
  const { handle, tunnelUrl } = await start(t)
  const jwt = await sign({ email: managerEmail })
  const memberGrant = (await handle.grants()).find(({ principals }) =>
    principals.some((p) => p.kind === 'user' && p.userId === 'owner.at.company.example'))
  assert.ok(memberGrant)
  const extra = { principals: [{ kind: 'user', userId: 'extra.at.company.example' }], can: { '*': 'all' } }
  for (const [method, path, body] of [
    ['POST', '/grants', extra],
    ['POST', '/grants/batch', { grants: [extra] }],
    ['PATCH', `/grants/${memberGrant.id}`, { can: { '*': 'all' } }],
    ['POST', `/grants/${memberGrant.id}/revoke`, {}],
  ] as const) {
    await t.test(`${method} ${path.replace(memberGrant.id, ':id')}`, async () => {
      const before = await handle.grants()
      const response = await fetch(tunnelUrl + path, {
        method, headers: { 'cf-access-jwt-assertion': jwt, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error?.code, 'not_on_tunnel')
      assert.deepEqual(await handle.grants(), before)
    })
  }
})

test('a board-issued bearer can override a verified Cloudflare person', async (t) => {
  const { handle, request, tunnelUrl } = await start(t, undefined, undefined, [])
  const { secret } = await handle.createInvite({ name: 'guest' })
  const { token, principal } = await handle.join(secret)
  const headers = { authorization: `Bearer ${token}` }
  const direct = await handle.fetch(new Request(`${tunnelUrl}/me`, { headers }))
  assert.equal(direct.status, 200)
  assert.equal((await direct.json()).principal, principal)
  const proxied = await request('/me', await sign(), undefined, headers)
  assert.equal(proxied.status, 200)
  assert.equal((await proxied.json()).principal, person)
})

test('production discovery fails or reports the wrong canonical board URL', async (t) => {
  const previous = process.env.NODE_ENV
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous })
  process.env.NODE_ENV = 'production'
  for (const hosts of [[publicHost, 'alias.example.test'], []]) {
    const { request, tunnelUrl } = await start(t, undefined, undefined, hosts)
    const reply = await request('/', await sign())
    assert.equal(reply.status, 200)
    const expected = hosts.length ? `https://${publicHost}` : tunnelUrl
    const { url, audience } = await reply.json()
    assert.deepEqual([url, audience], [expected, expected])
  }
})

test('unchanged permissions in noncanonical order churn grant IDs across restarts', async (t) => {
  const dir = await tempDir(t)
  const members = [{ ...member, can: { work: ['post', 'read', 'post'] } }, manager]
  const first = await start(t, members, dir)
  const ids = (await first.handle.grants()).map(({ id }) => id)
  await first.close()
  const second = await start(t, members, dir)
  try {
    assert.deepEqual((await second.handle.grants()).map(({ id }) => id), ids)
  } finally { await second.close() }
})

test('the tunnel strips SSE no-transform or fails to stream the first event', async (t) => {
  const { handle, tunnelUrl } = await start(t)
  await handle.post('work', post.text)
  const abort = new AbortController()
  try {
    const reply = await fetch(`${tunnelUrl}/events?after=0&channel=work`, {
      headers: { accept: 'text/event-stream', 'cf-access-jwt-assertion': await sign() },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    })
    assert.equal(reply.status, 200)
    assert.match(reply.headers.get('cache-control') ?? '', /\bno-transform\b/)
    assert.match(reply.headers.get('cache-control') ?? '', /\bno-store\b/)
    const reader = reply.body!.pipeThrough(new TextDecoderStream()).getReader()
    let first = ''
    while (!first.includes(post.text)) {
      const { value, done } = await reader.read()
      if (done) break
      first += value
    }
    assert.match(first, /event: board/)
    assert.ok(first.includes(post.text))
  } finally { abort.abort() }
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