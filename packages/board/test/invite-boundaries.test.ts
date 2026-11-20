import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { board, type SandboxPolicy } from '../src/server/index.ts'
import { bearer, BOARD_URL, localBoard, localUserToken } from './harness.ts'
import { serve } from './http.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function joined(cleanup: (close: () => Promise<void>) => void) {
  const team = localBoard({ url: BOARD_URL })
  cleanup(() => team.close())
  const remote = (fetch: typeof globalThis.fetch) => board({ backend: http(BOARD_URL, { fetch }) }).as(null)
  const { secret } = await team.createInvite({ name: 'teammate' })
  const { principal, token } = await remote(async (input, init) => team.fetch(new Request(input, init))).join(secret)
  return { team, principal, token, remote }
}

it('accepts a joined bearer only at the configured mount', async ({ onTestFinished }) => {
  const { team, principal, token } = await joined(onTestFinished)
  const at = (url: string) => team.fetch(new Request(`${url}/me`, { headers: { authorization: `Bearer ${token}` } }))
  const home = await at(BOARD_URL)
  expect(home.status).toBe(200)
  expect((await home.json()).principal === principal).toBe(true)
  const sibling = await at(new URL('/api/other-board', BOARD_URL).href)
  expect([401, 404]).toContain(sibling.status)
})

it("keeps a proxy-enforced joined profile from owning the bare member's posts", async ({ onTestFinished }) => {
  const { team, principal, token, remote } = await joined(onTestFinished)
  const send = bearer(async (input, init) => team.fetch(new Request(input, init)), token)
  const member = remote(send)
  const note = await member.post('general', 'member note')
  const agent = remote(async (input, init) => {
    const request = new Request(input, init)
    request.headers.set('x-board-profile', 'helper')
    request.headers.set('x-board-can', '*=read,post')
    return send(request)
  })
  const work = await agent.post('general', 'profile note')
  expect(work.by).toEqual({ actor: `${principal}+helper`, principal, profile: 'helper' })
  await agent.edit(work.id, 'profile note updated')
  await expect(agent.edit(note.id, 'not the owner')).rejects.toMatchObject({ status: 403 })
  expect((await member.thread(note.id)).message.text).toBe('member note')
})

/** The proxy's first matching rule for these bare requests (no query or headers). */
function ruleFor(policy: SandboxPolicy, method: string, path: string) {
  return policy.allow[new URL(BOARD_URL).host]?.find(({ match }) => {
    if (!match) return true
    const { path: where, method: methods, headers, queryString } = match
    return !headers?.length && !queryString?.length && (!methods || methods.includes(method)) &&
      (!where || ('exact' in where ? path === where.exact : new RegExp(where.regex).test(path)))
  })
}

it('denies every invite route in a sandbox policy even with admin credentials and manage scope', async ({ onTestFinished }) => {
  const team = localBoard({ url: BOARD_URL })
  onTestFinished(() => team.close())
  vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', undefined)
  const policy = await team.sandboxPolicy({
    token: await localUserToken(),
    profile: { name: 'helper' },
    can: { '*': ['read', 'manage'] },
  })
  const root = new URL(BOARD_URL).pathname
  const me = ruleFor(policy, 'GET', `${root}/me`)
  expect(!!me && 'transform' in me).toBe(true)
  if (me && 'transform' in me) {
    const headers = new Headers()
    for (const step of me.transform) for (const [key, value] of Object.entries(step.headers)) headers.set(key, value)
    const response = await team.fetch(new Request(`${BOARD_URL}/me`, { headers }))
    expect(response.status).toBe(200)
    expect((await response.json()).can['*']).toContain('manage')
  }

  for (const [method, path] of [['GET', '/invites'], ['POST', '/invites'], ['POST', '/invites/redeem'], ['POST', '/invites/example/revoke']] as const) {
    const rule = ruleFor(policy, method, `${root}${path}`)
    // Never forward the request or print the rule: an allowing rule includes a credential.
    expect(rule && 'response' in rule ? rule.response.statusCode : null, `${method} ${path}`).toBe(403)
  }
})

it.each([
  ['signed out', undefined],
  ['with BOARD_TOKEN set', 'existing-test-token'],
] as const)('redeems from the normal Node SDK without auth or redirects (%s)', async (_label, token) => {
  const home = await mkdtemp(join(tmpdir(), 'board-join-test-'))
  const received: string[] = []
  const server = await serve(async (request) => {
    const { pathname } = new URL(request.url)
    received.push(`${request.method} ${pathname}`)
    if (pathname !== '/api/board/invites/redeem') return new Response(null, { status: 404 })
    return new Response(null, { status: 307, headers: { location: '/elsewhere' } })
  })
  try {
    for (const key of Object.keys(process.env)) if (/^(BOARD_|VERCEL|ACTIONS_ID_TOKEN_)/.test(key)) vi.stubEnv(key, undefined)
    vi.stubEnv('HOME', home)
    vi.stubEnv('XDG_CONFIG_HOME', home)
    const url = `${server.origin}/api/board`
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', token)

    const nativeFetch = globalThis.fetch
    const outbound: { redeem: boolean; auth: boolean; credentials: RequestCredentials; redirect: RequestRedirect }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const redeem = request.url === `${url}/invites/redeem` && request.method === 'POST'
      const auth = ['authorization', 'cookie', 'x-vercel-protection-bypass', 'x-vercel-trusted-oidc-idp-token'].some((key) => request.headers.has(key))
      outbound.push({ redeem, auth, credentials: request.credentials, redirect: request.redirect })
      // Never forward a credential or let an auxiliary discovery request leave the test.
      if (!redeem || auth || request.credentials !== 'omit' || request.redirect !== 'error') throw new Error('unexpected join transport')
      return nativeFetch(request)
    })

    const joined = await board().join(`vbi_${'a'.repeat(43)}`).then(() => true, () => false)
    expect(outbound).toEqual([{ redeem: true, auth: false, credentials: 'omit', redirect: 'error' }])
    expect(received).toEqual(['POST /api/board/invites/redeem'])
    expect(joined).toBe(false)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})
