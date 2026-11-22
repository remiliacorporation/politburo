import { AssertionError, assertionIssuer, verifyAssertion, type AssertionOptions } from './assertion.ts'

export { receiver } from './receiver.ts'

export type Machine = { kind: 'machine'; id: string; name: string; can: readonly ['write'] }

function reject(status: 401 | 403, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export function machineAuthenticator({ clients, ...options }: AssertionOptions & { clients: Record<string, string> }) {
  assertionIssuer(options)
  const names = new Map(Object.entries(clients))
  for (const name of names.values()) {
    if (typeof name !== 'string' || !name || name.length > 64 || /[^A-Za-z0-9._-]/.test(name)) {
      throw new TypeError('invalid_machine_name')
    }
  }

  return async (headers: Headers): Promise<Machine | Response | null> => {
    const token = headers.get('Cf-Access-Jwt-Assertion')
    if (token === null) return null
    try {
      const { email, commonName } = await verifyAssertion(token, options)
      if (email !== undefined) return reject(401, 'unauthorized', 'a person assertion is not a machine credential')
      const name = commonName ? names.get(commonName) : undefined
      if (name === undefined) return reject(403, 'unknown_client', 'service client is not registered')
      return { kind: 'machine', id: `cloudflare:machine:${name}`, name, can: ['write'] }
    } catch (error) {
      return error instanceof AssertionError
        ? reject(401, error.reason, error.message)
        : reject(401, 'unauthorized', 'could not authenticate assertion')
    }
  }
}
