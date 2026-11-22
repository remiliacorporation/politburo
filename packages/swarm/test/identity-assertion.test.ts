import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalJWKSet, exportJWK, exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT, UnsecuredJWT, type JWTPayload } from 'jose'
import { AssertionError, verifyAssertion } from '../src/identity/index.ts'

const teamDomain = 'team.invalid'
const audience = 'stub-app'
const time = 1_900_000_000
const claims = { iss: `https://${teamDomain}`, aud: audience, sub: 'fixture', iat: time, exp: time + 60 }
const issuer = await generateKeyPair('RS256', { extractable: true })
const jwk = await exportJWK(issuer.publicKey)
const publicKeyBytes = new TextEncoder().encode(await exportSPKI(issuer.publicKey))
const options = { teamDomain, audience, keys: createLocalJWKSet({ keys: [jwk] }), now: () => new Date(time * 1000) }

const sign = (changes: JWTPayload = {}, alg = 'RS256', key: CryptoKey | Uint8Array = issuer.privateKey) =>
  new SignJWT({ ...claims, ...changes }).setProtectedHeader({ alg }).sign(key)

const cases = [
  ['a different issuer is accepted', 'issuer', () => sign({ iss: 'https://other-team.invalid' })],
  ['a different audience is accepted', 'audience', () => sign({ aud: 'other-app' })],
  ['a missing expiry is accepted', 'claims', () => sign({ exp: undefined })],
  ['a missing issued-at time is accepted', 'claims', () => sign({ iat: undefined })],
  ['an expired assertion is accepted', 'expired', () => sign({ iat: time - 30, exp: time - 6 })],
  ['a future not-before time is accepted', 'not_yet_valid', () => sign({ nbf: time + 6 })],
  ['a future issued-at time is accepted', 'not_yet_valid', () => sign({ iat: time + 6 })],
  ['a non-string email claim is accepted', 'claims', () => sign({ email: ['owner@example.invalid'] })],
  ['alg none is not refused by the allow-list', 'algorithm', () => new UnsecuredJWT(claims).encode()],
  ['RS384 slips through the RS256 allow-list', 'algorithm', async () =>
    sign({}, 'RS384', await importPKCS8(await exportPKCS8(issuer.privateKey), 'RS384'))],
  ['HS256 using the public key as a secret is not refused by the allow-list', 'algorithm', () =>
    sign({}, 'HS256', publicKeyBytes), () => publicKeyBytes],
  ['a different signing key is accepted', 'signature', async () => sign({}, 'RS256', (await generateKeyPair('RS256')).privateKey)],
  ['a tampered payload is accepted', 'signature', async () => {
    const [header, , signature] = (await sign()).split('.')
    const changed = Buffer.from(JSON.stringify({ ...claims, email: 'owner@example.invalid' })).toString('base64url')
    return `${header}.${changed}.${signature}`
  }],
] as const

for (const [name, reason, tokenFor, keys = options.keys] of cases) {
  test(name, async () => {
    const token = await tokenFor()
    const error = await verifyAssertion(token, { ...options, keys }).then(() => null, (error: unknown) => error)
    assert.ok(error instanceof AssertionError, 'expected a sanitized assertion error')
    assert.equal(error.reason, reason)
    assert.ok(token.split('.').filter(Boolean).every((part) => !error.message.includes(part)), 'error contains JWT material')
    assert.ok(error.cause === undefined, 'error retains an underlying error')
  })
}

test('a team domain with URL syntax or whitespace is accepted as a hostname', async () => {
  for (const domain of ['https://team.invalid', 'team.invalid/path', 'team.invalid:443', 'user@team.invalid', 'team.invalid\n']) {
    const token = await sign({ iss: `https://${domain}` })
    await assert.rejects(verifyAssertion(token, { ...options, teamDomain: domain }), { name: 'AssertionError', reason: 'claims' })
  }
})
