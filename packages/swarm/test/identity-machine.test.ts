import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { machineAuthenticator, receiver } from '../src/identity/index.ts'

const teamDomain = 'team.invalid'
const audience = 'telemetry-app'
const time = 1_900_000_000
const client = 'Fixture.access'
const assertion = 'Cf-Access-Jwt-Assertion'
const { publicKey, privateKey } = await generateKeyPair('RS256')
const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] })
const options = { teamDomain, audience, keys, now: () => new Date(time * 1000) }
const auth = (clients: Record<string, string> = { [client]: 'mob-1' }) => machineAuthenticator({ ...options, clients })
const authenticate = auth()
const signed = (changes: JWTPayload = {}, key = privateKey) => new SignJWT({
  iss: `https://${teamDomain}`, aud: audience, sub: '', common_name: client, iat: time, exp: time + 60, ...changes,
}).setProtectedHeader({ alg: 'RS256' }).sign(key)
const valid = await signed()
const record = { event: 'run finished' }
const text = JSON.stringify(record)

function request(token: string | null, { method = 'POST', body = text, mediaType = 'application/json' }: {
  method?: string; body?: BodyInit; mediaType?: string
} = {}) {
  const headers = new Headers({ 'Content-Type': mediaType })
  if (token !== null) headers.set(assertion, token)
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

async function expectCode(response: Response, status: number, code: string) {
  assert.equal(response.status, status)
  const payload = await response.json().catch(() => null)
  assert.ok(payload?.error?.code === code && Object.keys(payload.error).length === 1 &&
    Object.keys(payload).length === 1, `expected only error code ${code}`)
}

test('a service assertion loses its write-only identity, changes the record, or echoes it', async () => {
  const received: unknown[] = []
  const handle = receiver({ authenticate, accept: (value, machine) => { received.push({ value, machine }) } })
  const response = await handle(request(valid, { mediaType: 'application/json; charset=utf-8' }))
  assert.equal(response.status, 202)
  assert.ok((await response.text()) === '', 'success response has a body')
  assert.ok(isDeepStrictEqual(received, [{ value: record, machine: {
    kind: 'machine', id: 'cloudflare:machine:mob-1', name: 'mob-1', can: ['write'],
  } }]), 'expected the submitted record and only the write-only machine identity')
})

for (const [name, changes, status, code, clients] of [
  ['a person assertion with a registered client id reaches accept', { sub: 'person', email: 'person@example.invalid' }, 401, 'unauthorized'],
  ['an empty email claim is treated as absent', { email: '' }, 401, 'unauthorized'],
  ['an unknown client gets write access', { common_name: 'stranger' }, 403, 'unknown_client'],
  ['a client id with different case gets write access', { common_name: client.toLowerCase() }, 403, 'unknown_client'],
  ['a client id with a registered prefix gets write access', { common_name: `${client}.other` }, 403, 'unknown_client'],
  ['an inherited client id gets write access', { common_name: 'inherited' }, 403, 'unknown_client',
    Object.create({ inherited: 'mob-2' }) as Record<string, string>],
] as const) {
  test(name, async () => {
    await expectCode(await guarded({ authenticate: auth(clients) })(request(await signed(changes))), status, code)
  })
}

test('a service assertion signed by an untrusted key reaches accept', async () => {
  const token = await signed({}, (await generateKeyPair('RS256')).privateKey)
  await expectCode(await guarded()(request(token)), 401, 'signature')
})

test('duplicate assertions authenticate or expose more than the error code', async () => {
  const req = request(valid)
  req.headers.append(assertion, valid)
  await expectCode(await guarded()(req), 401, 'malformed')
})

test('machine configuration accepts an invalid name or assigns one identity to two clients', () => {
  assert.throws(() => auth({ [client]: 'mob/1' }), { message: 'invalid_machine_name' })
  assert.throws(() => auth({ [client]: 'mob-1', other: 'mob-1' }), { message: 'duplicate_machine_name' })
})

test('missing credentials are treated as present or the receiver reads before authenticating', async () => {
  assert.ok(await authenticate(new Headers()) === null)
  const req = request(null)
  assert.equal((await guarded()(req)).status, 401)
  assert.equal(req.bodyUsed, false)
})

test('a machine can use a non-POST method or get a response body from it', async () => {
  const handle = guarded()
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
    const req = request(valid, { method })
    req.headers.set('X-HTTP-Method-Override', 'POST')
    const response = await handle(req)
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'POST', method)
    assert.equal(await response.text(), '', method)
  }
})

test('a body bypasses the byte cap with a false length or an unbounded default', async () => {
  const req = request(valid, { body: JSON.stringify({ event: 'x'.repeat(64 * 1024) }) })
  req.headers.set('Content-Length', '1')
  assert.equal((await guarded()(req)).status, 413)
})

test('a stream without a length exceeds the byte cap or is not cancelled on overflow', async () => {
  const parts = ['{"event":"é', 'é"}']
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift()
      if (part === undefined) controller.close()
      else controller.enqueue(new TextEncoder().encode(part))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  assert.equal((await guarded({ maxBytes: 14 })(request(valid, { body: stream }))).status, 413)
  assert.equal(cancelled, true)
})

test('a zero byte budget becomes unbounded or a negative or NaN budget starts', async () => {
  assert.equal((await guarded({ maxBytes: 0 })(request(valid))).status, 413)
  for (const maxBytes of [-1, NaN]) assert.throws(() => guarded({ maxBytes }), { message: 'invalid_max_bytes' })
})

test('a non-JSON media type reaches accept', async () => {
  for (const mediaType of ['text/plain', 'application/jsonx']) {
    assert.equal((await guarded()(request(valid, { mediaType }))).status, 415)
  }
})

test('malformed JSON or a non-object JSON value reaches accept', async () => {
  for (const body of ['{', 'null', '[]', '1']) {
    assert.equal((await guarded()(request(valid, { body }))).status, 400)
  }
})

test('an accept failure is ignored or exposes details', async () => {
  const handle = receiver({ authenticate, accept: async () => { throw new Error('fixture callback failure') } })
  await expectCode(await handle(request(valid)), 500, 'accept_failed')
})
