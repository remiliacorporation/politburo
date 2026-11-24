import { createRemoteJWKSet } from 'jose'
import { accessIssuer } from './assertion.ts'

export function accessKeys(teamDomain: string) {
  return createRemoteJWKSet(new URL(`${accessIssuer(teamDomain)}/cdn-cgi/access/certs`), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  })
}
