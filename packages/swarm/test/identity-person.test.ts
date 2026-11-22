import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { memberFor, parseMembers, personAuthenticator } from '../src/identity/index.ts'

const teamDomain = 'team.invalid'
const audience = 'stub-app'
const time = Math.floor(Date.now() / 1000)
const exp = time + 3600
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] })
const grants = { 'work/': ['label'], private: [], notes: 'all' }
const entry = (email: string) => ({ email, can: grants })
const email = 'owner.k@example.invalid'
const members = parseMembers({ members: [entry(email.toUpperCase())] })
const signed = (claims: JWTPayload) => new SignJWT({ iss: `https://${teamDomain}`, aud: audience, sub: 'fixture', iat: time, exp, ...claims })
  .setProtectedHeader({ alg: 'RS256' }).sign(privateKey)
const options = { teamDomain, audience, keys, now: () => new Date(time * 1000), members }
const auth = (now = options.now) => personAuthenticator({ ...options, now })
const authenticate = auth()
const assertion = (token: string) => new Headers({ 'Cf-Access-Jwt-Assertion': token })

async function refused(result: Awaited<ReturnType<typeof authenticate>>, status: number, code: string, token: string) {
  assert.ok(result instanceof Response, 'expected a rejection response')
  assert.equal(result.status, status)
  const body = await result.text()
  assert.ok(!token || token.split('.').filter(Boolean).every((part) => !body.includes(part)), 'response contains JWT material')
  const { error } = JSON.parse(body)
  assert.equal(error.code, code)
  assert.ok(typeof error.message === 'string' && error.message.length > 0)
}

test('a signed owner email loses its explicit board grants or inherits the local owner grant', async (t) => {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const url = 'https://board.invalid'
  const tenant = board({ backend, url, authenticate: ({ headers }) => authenticate(headers) })
  const userId = 'owner.k.at.example.invalid'
  await tenant.createGrants([
    { principals: [{ kind: 'user', userId }], can: memberFor(members, email)!.can },
    { principals: [{ kind: 'user', userId: 'owner.k' }], can: { '*': 'all' } },
  ])
  assert.equal((await tenant.revokeGrant('g1', { lockMeOut: true })).revoked, true)
  const headers = assertion(await signed({ email: email.toUpperCase() }))
  const me = await tenant.fetch(new Request(`${url}/me`, { headers }))
  assert.equal(me.status, 200)
  const result = await me.json()
  assert.equal(result.principal, `cloudflare:person:${userId}`)
  assert.equal(result.handle, 'owner.k')
  assert.equal(result.expiresAt, new Date(exp * 1000).toISOString())
  assert.deepEqual(result.can, { 'work/': ['read', 'label'], notes: ['read', 'post', 'react', 'label', 'sync', 'manage'] })
})

test('a registered person with an empty subject is rejected', async () => {
  const result = await authenticate(assertion(await signed({ sub: '', email })))
  assert.ok(result && !(result instanceof Response), 'expected a person principal')
  assert.equal(result.id, 'cloudflare:person:owner.k.at.example.invalid')
})

test('the person authenticator starts with an invalid domain or empty audience', () => {
  for (const invalid of [{ teamDomain: 'team.invalid:443' }, { audience: '' }]) {
    assert.throws(() => personAuthenticator({ ...options, ...invalid }), { reason: 'claims' })
  }
})

test('an assertion can be replayed at or after expiry', async () => {
  let clock = time
  const check = auth(() => new Date(clock * 1000))
  const token = await signed({ email })
  const headers = assertion(token)
  const initial = await check(headers)
  assert.ok(initial && !(initial instanceof Response))
  for (clock of [exp, exp + 1]) await refused(await check(headers), 401, 'expired', token)
})

for (const [name, headers] of [
  ['unsigned email header authenticates', () => new Headers({ 'Cf-Access-Authenticated-User-Email': email })],
  ['forwarded email header authenticates', () => new Headers({ 'X-Forwarded-Email': email })],
  ['a cookie alone authenticates', async () => new Headers({ cookie: `CF_Authorization=${await signed({ email })}` })],
] as const) {
  test(name, async () => assert.ok(await authenticate(await headers()) === null, 'expected no supported credential'))
}

for (const [name, code, tokenFor] of [
  ['an empty assertion header does not return 401', 'missing', () => ''],
  ['garbage in an assertion header does not return 401', 'malformed', () => 'not-a-jwt'],
  ['an empty-subject service assertion authenticates as a person', 'unauthorized', () => signed({ sub: '', common_name: email })],
] as const) {
  test(name, async () => {
    const token = await tokenFor()
    await refused(await authenticate(assertion(token)), 401, code, token)
  })
}

test('two assertions in one header authenticate', async () => {
  const token = await signed({ email })
  const headers = assertion(token)
  headers.append('Cf-Access-Jwt-Assertion', token)
  await refused(await authenticate(headers), 401, 'malformed', token)
})

for (const [name, claim] of [
  ['unregistered email', 'stranger@example.invalid'],
  ['trailing whitespace', `${email} `],
  ['embedded newline', email.replace('@', '\n@')],
  ['embedded NUL', email.replace('@', '\x00@')],
  ['Unicode lookalike', email.replace('k', 'K')],
  ['plus addressing', email.replace('@', '+tag@')],
]) {
  test(`${name} slips past registry admission`, async () => {
    const token = await signed({ email: claim })
    await refused(await authenticate(assertion(token)), 403, 'not_a_member', token)
  })
}

for (const [name, input] of [
  ['duplicate emails after case folding', { members: [entry(email), entry(email.toUpperCase())] }],
  ['a separator overlapping @ from the local part', { members: [entry('x.at@b.c')] }],
  ['a separator overlapping @ from the domain', { members: [entry('a@at.c')] }],
  ['a second separator in the local part', { members: [entry('a.at.b@c.d')] }],
  ['a second separator in the domain', { members: [entry('a@b.at.c')] }],
  ['unknown registry fields', { members: [], owner: email }],
  ['unknown member fields', { members: [{ ...entry(email), owner: true }] }],
  ['unknown fields nested under a grant', { members: [{ email, can: { '*': { read: true } } }] }],
  ['unknown permissions', { members: [{ email, can: { '*': ['admin'] } }] }],
  ['invalid channel patterns', { members: [{ email, can: { 'work/*': ['read'] } }] }],
  ['email local parts too long for a board handle', { members: [entry(`${'x'.repeat(65)}@example.invalid`)] }],
  ['email-derived user IDs longer than the board permits', { members: [entry(`a@${('x'.repeat(50) + '.').repeat(4)}invalid`)] }],
  ['a prototype key in channel grants', { members: [{ email, can: { ['__proto__']: ['read'] } }] }],
] as const) {
  test(`registry accepts ${name}`, () => assert.throws(() => parseMembers(input), TypeError))
}
