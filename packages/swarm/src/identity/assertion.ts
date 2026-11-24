import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose'

const messages = {
  missing: 'missing assertion',
  malformed: 'malformed assertion',
  algorithm: 'unsupported assertion algorithm',
  signature: 'could not verify assertion signature',
  expired: 'assertion expired',
  not_yet_valid: 'assertion is not yet valid',
  issuer: 'unexpected assertion issuer',
  audience: 'unexpected assertion audience',
  claims: 'invalid assertion claims or configuration',
} as const

type Reason = keyof typeof messages

export class AssertionError extends Error {
  readonly reason: Reason

  constructor(reason: Reason) {
    super(messages[reason])
    this.name = 'AssertionError'
    this.reason = reason
  }
}

export type AssertionClaims = { sub: string; email?: string; commonName?: string; exp: number; iat: number }
export type AssertionOptions = {
  teamDomain: string
  audience: string
  keys: JWTVerifyGetKey
  now?: () => Date
}

const hostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

export function accessIssuer(teamDomain: string): string {
  if (typeof teamDomain !== 'string' || teamDomain.length > 253 || !hostname.test(teamDomain)) {
    throw new AssertionError('claims')
  }
  const issuer = `https://${teamDomain}`
  if (URL.parse(issuer)?.hostname !== teamDomain.toLowerCase()) throw new AssertionError('claims')
  return issuer
}

export function assertionIssuer({ teamDomain, audience }: AssertionOptions): string {
  if (typeof audience !== 'string' || !audience || audience.trim() !== audience) throw new AssertionError('claims')
  return accessIssuer(teamDomain)
}

function reasonFor(error: unknown): Reason {
  if (error instanceof errors.JWTExpired) return 'expired'
  if (error instanceof errors.JOSEAlgNotAllowed) return 'algorithm'
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return 'issuer'
    if (error.claim === 'aud') return 'audience'
    if (error.claim === 'nbf' && error.reason === 'check_failed') return 'not_yet_valid'
    return 'claims'
  }
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid || error instanceof errors.JOSENotSupported) return 'malformed'
  return 'signature'
}

export async function verifyAssertion(token: string | null | undefined, options: AssertionOptions): Promise<AssertionClaims> {
  const issuer = assertionIssuer(options)
  if (token == null || token === '') throw new AssertionError('missing')
  let currentDate: Date
  try {
    currentDate = options.now?.() ?? new Date()
    if (!Number.isFinite(currentDate.getTime())) throw new AssertionError('claims')
  } catch {
    throw new AssertionError('claims')
  }
  const clockTolerance = 5
  const { payload } = await jwtVerify(token, options.keys, {
    algorithms: ['RS256'], issuer, audience: options.audience, currentDate, clockTolerance,
    requiredClaims: ['exp', 'iat'],
  }).catch((error: unknown) => { throw new AssertionError(reasonFor(error)) })
  const { aud, sub, email, common_name: commonName, exp, iat } = payload
  if (Array.isArray(aud) && aud.some((entry) => typeof entry !== 'string')) throw new AssertionError('audience')
  if (typeof sub !== 'string' || typeof exp !== 'number' || typeof iat !== 'number' ||
      !Number.isFinite(new Date(exp * 1000).getTime()) ||
      (email !== undefined && typeof email !== 'string') ||
      (commonName !== undefined && typeof commonName !== 'string')) throw new AssertionError('claims')
  if (exp <= currentDate.getTime() / 1000) throw new AssertionError('expired')
  if (iat > Math.floor(currentDate.getTime() / 1000) + clockTolerance) throw new AssertionError('not_yet_valid')
  return { sub, email, commonName, exp, iat }
}
