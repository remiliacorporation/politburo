import { AssertionError, assertionIssuer, verifyAssertion, type AssertionOptions } from './assertion.ts'

export { receiver } from './receiver.ts'

export type Machine = { kind: 'machine'; id: string; name: string; can: readonly ['write'] }

function reject(status: 401 | 403, code: string): Response {
  return Response.json({ error: { code } }, { status })
}

export function machineAuthenticator({ clients, ...options }: AssertionOptions & { clients: Record<string, string> }) {
  assertionIssuer(options)
  const names = new Map(Object.entries(clients))
  const seen = new Set<string>()
  for (const name of names.values()) {
    if (typeof name !== 'string' || !name || name.length > 64 || /[^A-Za-z0-9._-]/.test(name)) {
      throw new TypeError('invalid_machine_name')
    }
    if (seen.has(name)) throw new TypeError('duplicate_machine_name')
    seen.add(name)
  }

  return async (headers: Headers): Promise<Machine | Response | null> => {
    const token = headers.get('Cf-Access-Jwt-Assertion')
    if (token === null) return null
    try {
      const { email, commonName } = await verifyAssertion(token, options)
      if (email !== undefined) return reject(401, 'unauthorized')
      const name = commonName ? names.get(commonName) : undefined
      if (name === undefined) return reject(403, 'unknown_client')
      return { kind: 'machine', id: `cloudflare:machine:${name}`, name, can: ['write'] }
    } catch (error) {
      return reject(401, error instanceof AssertionError ? error.reason : 'unauthorized')
    }
  }
}
