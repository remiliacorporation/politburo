import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type JWTPayload } from 'jose'
import { machineAuthenticator, receiver } from '../src/identity/index.ts'

const teamDomain = 'team.invalid'
const audience = 'telemetry-app'
const time = 1_900_000_000
const client = 'Fixture.access'
const claims = { iss: `https://${teamDomain}`, aud: audience, sub: 'fixture', common_name: client, iat: time, exp: time + 60 }
const { publicKey, privateKey } = await generateKeyPair('RS256')
const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] })
const options = { teamDomain, audience, keys, now: () => new Date(time * 1000) }
const auth = (clients: Record<string, string> = { [client]: 'mob-1' }) => machineAuthenticator({ ...options, clients })
const authenticate = auth()
const signed = (changes: JWTPayload = {}) => new SignJWT({ ...claims, ...changes })
  .setProtectedHeader({ alg: 'RS256' }).sign(privateKey)
const valid = await signed()
const record = { event: 'run finished' }
const text = JSON.stringify(record)

function request(token: string | null, { method = 'POST', body = text, mediaType = 'application/json', length }: {
  method?: string; body?: BodyInit; mediaType?: string; length?: number
} = {}) {
  const headers = new Headers({ 'Content-Type': mediaType })
  if (length !== undefined) headers.set('Content-Length', String(length))
  if (token !== null) headers.set('Cf-Access-Jwt-Assertion', token)
  const init = { method, headers, body: ['GET', 'HEAD'].includes(method) ? null : body, duplex: 'half' as const }
  return new Request('https://receiver.invalid/telemetry', init)
}

function guarded(options: { maxBytes?: number; authenticate?: typeof authenticate } = {}) {
  let accepted = false
  const handle = receiver({ authenticate, ...options, accept: () => { accepted = true } })
  return async (req: Request) => {
    const response = await handle(req)
    assert.equal(accepted, false, 'a rejected request reached the accept callback')
    return response
  }
}

async function expectError(response: Response, status: number, code: string, token: string) {
  assert.equal(response.status, status)
  const body = await response.text()
  assert.ok(token.split('.').filter(Boolean).every((part) => !body.includes(part)), 'response contains JWT material')
  const { error } = JSON.parse(body)
  assert.equal(error.code, code)
  assert.ok(typeof error.message === 'string' && error.message.length > 0)
}

test('a service assertion with empty sub fails to deliver a write-only machine and record, or echoes the record', async () => {
  const received: unknown[] = []
  const handle = receiver({ authenticate, accept: (value, machine) => { received.push({ value, machine }) } })
  const response = await handle(request(await signed({ sub: '' }), { mediaType: 'application/json; charset=utf-8' }))
  assert.equal(response.status, 202)
  assert.equal(await response.text(), '')
  assert.deepEqual(received, [{ value: record, machine: {
    kind: 'machine', id: 'cloudflare:machine:mob-1', name: 'mob-1', can: ['write'],
  } }])
})

for (const [name, code, tokenFor] of [
  ['an unsigned assertion reaches the receiver', 'algorithm', () => new UnsecuredJWT(claims).encode()],
  ['garbage in the assertion header is not refused', 'malformed', () => 'not-a-jwt'],
  ['an expired assertion reaches the receiver', 'expired', () => signed({ iat: time - 60, exp: time - 10 })],
  ['an assertion for another app reaches the receiver', 'audience', () => signed({ aud: 'other-app' })],
  ['an assertion from another team reaches the receiver', 'issuer', () => signed({ iss: 'https://other-team.invalid' })],
  ['a person assertion with a registered client id is accepted', 'unauthorized', () =>
    signed({ sub: 'person', email: 'person@example.invalid' })],
  ['an empty email claim is treated as absent', 'unauthorized', () => signed({ email: '' })],
] as const) {
  test(name, async () => {
    const token = await tokenFor()
    await expectError(await guarded()(request(token)), 401, code, token)
  })
}

for (const [name, common_name, clients] of [
  ['an unknown client gets write access', 'stranger', undefined],
  ['a client id with different case gets write access', client.toLowerCase(), undefined],
  ['an inherited client id gets write access', 'inherited', Object.create({ inherited: 'mob-2' }) as Record<string, string>],
] as const) {
  test(name, async () => {
    const token = await signed({ common_name })
    await expectError(await guarded({ authenticate: auth(clients) })(request(token)), 403, 'unknown_client', token)
  })
}

test('machine configuration accepts a name with disallowed characters', () => {
  assert.throws(() => auth({ [client]: 'mob/1' }), { message: 'invalid_machine_name' })
})

test('missing credentials are not treated as absent by auth and refused by the receiver', async () => {
  assert.ok(await authenticate(new Headers()) === null)
  assert.equal((await guarded()(request(null))).status, 401)
})

test('a machine credential can use a non-POST method or get a response body from it', async () => {
  const handle = guarded()
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
    const response = await handle(request(valid, { method }))
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'POST', method)
    assert.equal(await response.text(), '', method)
  }
})

test('an oversized JSON body bypasses the default limit or a smaller streaming byte limit', async () => {
  const body = JSON.stringify('x'.repeat(64 * 1024))
  assert.equal((await guarded()(request(valid, { body, length: body.length }))).status, 413)

  const parts = ['"é', 'é"']
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift()
      if (part === undefined) controller.close()
      else controller.enqueue(new TextEncoder().encode(part))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const streamed = request(valid, { body: stream })
  assert.equal(streamed.headers.has('content-length'), false)
  assert.equal((await guarded({ maxBytes: 5 })(streamed)).status, 413)
  assert.equal(cancelled, true, 'the oversized stream was not stopped before EOF')
})

test('a valid JSON value with a non-JSON content type reaches accept', async () => {
  assert.equal((await guarded()(request(valid, { mediaType: 'text/plain' }))).status, 415)
})

test('invalid JSON reaches accept or returns a status other than 400', async () => {
  assert.equal((await guarded()(request(valid, { body: '{' }))).status, 400)
})

test('a rejected accept callback does not return 500 or leaks its error or record', async () => {
  const message = 'fixture callback failure'
  const handle = receiver({ authenticate, accept: async () => { throw new Error(message) } })
  const response = await handle(request(valid))
  assert.equal(response.status, 500)
  const body = await response.text()
  assert.ok(!body.includes(message) && !body.includes(record.event), 'response leaks callback error or record')
  assert.equal(body, 'could not accept record')
})
