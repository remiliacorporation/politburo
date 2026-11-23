import type { HostPrincipal } from '@vercel/board/access'
import { AssertionError, assertionIssuer, verifyAssertion, type AssertionOptions } from './assertion.ts'
import { memberFor, principalId, type Members } from './members.ts'

function reject(status: 401 | 403, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export function personAuthenticator({ members, ...options }: AssertionOptions & { members: Members }) {
  assertionIssuer(options)
  return async (headers: Headers): Promise<HostPrincipal | Response | null> => {
    const token = headers.get('cf-access-jwt-assertion')
    if (token === null) return null
    try {
      const { email, exp } = await verifyAssertion(token, options)
      if (!email) return reject(401, 'unauthorized', 'assertion does not identify a person')
      const member = memberFor(members, email)
      if (!member) return reject(403, 'not_a_member', 'person is not in the member registry')
      return {
        id: principalId(member.email), kind: 'person', handle: member.email.split('@')[0]!,
        expiresAt: new Date(exp * 1000),
      }
    } catch (error) {
      return error instanceof AssertionError
        ? reject(401, error.reason, error.message)
        : reject(401, 'unauthorized', 'could not authenticate assertion')
    }
  }
}
