import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { memberFor, parseMembers, personAuthenticator } from '../src/identity/index.ts'

const teamDomain = 'team.invalid'
const audience = 'stub-app'
const time = 1_900_000_000
const exp = time + 60
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] })
const grants = { 'work/': ['label'], private: [], notes: 'all' }
const entry = (email: string) => ({ email, can: grants })
const email = 'owner.k@example.invalid'
const members = parseMembers({ members: [entry(email.toUpperCase())] })
const signed = (claims: JWTPayload) => new SignJWT({ iss: `https://${teamDomain}`, aud: audience, sub: 'fixture', iat: time, exp, ...claims })
  .setProtectedHeader({ alg: 'RS256' }).sign(privateKey)
const auth = (now = () => new Date(time * 1000)) => personAuthenticator({ teamDomain, audience, keys, now, members })
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

test('a verified owner email changes identity with case or maps to the local owner', async () => {
  for (const claim of [email, email.toUpperCase()]) {
    const token = await signed({ email: claim })
    assert.deepEqual(await authenticate(assertion(token)), {
      id: 'cloudflare:person:owner.k.at.example.invalid', kind: 'person', handle: 'owner.k', expiresAt: new Date(exp * 1000),
    })
  }
  assert.deepEqual(memberFor(members, email), { email, can: grants })
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
  ['a service assertion authenticates as a person', 'unauthorized', () => signed({ common_name: 'stub-service' })],
] as const) {
  test(name, async () => {
    const token = await tokenFor()
    await refused(await authenticate(assertion(token)), 401, code, token)
  })
}

for (const [name, claim] of [
  ['unregistered email', 'stranger@example.invalid'],
  ['trailing whitespace', `${email} `],
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
  ['colliding principal IDs', { members: [entry('a.at.b@c.invalid'), entry('a@b.at.c.invalid')] }],
  ['unknown registry fields', { members: [], owner: email }],
  ['unknown member fields', { members: [{ ...entry(email), owner: true }] }],
  ['unknown fields nested under a grant', { members: [{ email, can: { '*': { read: true } } }] }],
  ['unknown permissions', { members: [{ email, can: { '*': ['admin'] } }] }],
  ['invalid channel patterns', { members: [{ email, can: { 'work/*': ['read'] } }] }],
  ['email local parts too long for a board handle', { members: [entry(`${'x'.repeat(65)}@example.invalid`)] }],
] as const) {
  test(`registry accepts ${name}`, () => assert.throws(() => parseMembers(input), TypeError))
}
