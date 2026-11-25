import { request } from 'node:http'
import { Window } from 'happy-dom'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { startInspector, type Inspector } from '../src/inspect/server.ts'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'

let server: Awaited<ReturnType<typeof serve>>
let inspector: Inspector
let ada: string
let bo: string
const boardUrl = () => `${server.origin}/api/board`

beforeAll(async () => {
  server = await serve(testBoard({ url: undefined }).fetch)
  const url = boardUrl()
  ada = await personToken('u_ada', url)
  bo = await personToken('u_bo', url)
  const julian = await personToken('u_julian', url)
  inspector = await startInspector({
    client: createBoardClient({ url, token: julian }),
    port: 0,
    page: '/* inspector bundle */',
    signIn: { acting: (credential) => createBoardClient({ url, token: credential }) },
  })
})
afterAll(async () => {
  await inspector.close()
  server.close()
})

function cookiePair(header: string | null): string {
  return (header ?? '').split(';')[0]!
}

function sign(token: string, origin = inspector.url) {
  return fetch(`${inspector.url}/sign-in`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  })
}

async function session(token: string) {
  const signed = await sign(token)
  expect(signed.status).toBe(303)
  const set = signed.headers.get('set-cookie') ?? ''
  const flags = set.split(';').slice(1).map((part) => part.trim())
  expect(flags).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/']))
  const cookie = cookiePair(set)
  const home = await fetch(inspector.url, { headers: { cookie } })
  const html = await home.text()
  const pageToken = /<meta name="inspect-token" content="([^"]+)">/.exec(html)?.[1] ?? ''
  return { cookie, html, pageToken }
}

it('asks a viewer with no token or a bad one to sign in, and books nothing as the operator', async () => {
  const page = await fetch(inspector.url)
  const html = await page.text()
  expect(page.status).toBe(200)
  expect(html).toContain('<h1>Sign in</h1>')
  expect(html).not.toContain('inspect-token')
  expect((await fetch(`${inspector.url}/board/me`)).status).toBe(401)
  expect((await fetch(`${inspector.url}/app.js`)).status).toBe(401)
  const refused = await sign('not-a-token')
  expect(refused.status).toBe(401)
  expect(refused.headers.get('set-cookie')).toBeNull()
  const refusal = await refused.text()
  expect(refusal).toContain('That token was refused.')
  expect(refusal.includes('not-a-token')).toBe(false)
})

it('forwards the proxy as the viewer who signed in, and sign-out clears the cookie', async () => {
  const first = await session(ada)
  expect(first.html.includes(ada)).toBe(false)
  const asAda = await fetch(`${inspector.url}/board/me`, {
    headers: { cookie: first.cookie, 'x-inspect-token': first.pageToken, origin: inspector.url },
  })
  expect(await asAda.json()).toMatchObject({ actor: 'vercel:user:u_ada' })
  const second = await session(bo)
  const asBo = await fetch(`${inspector.url}/board/me`, {
    headers: { cookie: second.cookie, 'x-inspect-token': second.pageToken },
  })
  expect(await asBo.json()).toMatchObject({ actor: 'vercel:user:u_bo' })
  expect((await fetch(`${inspector.url}/board/me`, { headers: { cookie: first.cookie, 'x-inspect-token': first.pageToken } })).status).toBe(200)

  expect((await fetch(`${inspector.url}/board/me`, { headers: { cookie: first.cookie } })).status).toBe(403)
  const write = await fetch(`${inspector.url}/board/messages`, {
    method: 'POST',
    headers: { cookie: first.cookie, 'x-inspect-token': first.pageToken, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'ops', text: 'from the page' }),
  })
  expect(write.status).toBe(403)

  const out = await fetch(`${inspector.url}/sign-out`, {
    method: 'POST', redirect: 'manual', headers: { origin: inspector.url, cookie: first.cookie },
  })
  expect(out.status).toBe(303)
  expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
  expect((await fetch(`${inspector.url}/board/me`, { headers: { cookie: cookiePair(out.headers.get('set-cookie')) } })).status).toBe(401)
})

it('keeps the host check on a signed-in inspector', async () => {
  const { cookie, pageToken } = await session(ada)
  const status = await new Promise<number>((resolve, reject) => {
    const { hostname, port } = new URL(inspector.url)
    const req = request({ hostname, port, path: '/board/me', headers: { host: 'evil.example', cookie, 'x-inspect-token': pageToken } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
  expect(status).toBe(421)
})

it('does not put the team token in the page or its storage', async () => {
  const signedOut = await (await fetch(inspector.url)).text()
  const open = new Window()
  open.document.write(signedOut)
  const field = open.document.querySelector('input[name=token]')
  expect(field).not.toBeNull()
  field!.setAttribute('value', ada)
  expect(open.localStorage.length).toBe(0)
  expect(open.sessionStorage.length).toBe(0)
  expect(open.document.cookie).toBe('')
  expect(signedOut.includes(ada)).toBe(false)

  const { html } = await session(ada)
  const signed = new Window()
  signed.document.write(html)
  expect(html.includes(ada)).toBe(false)
  expect(signed.localStorage.length).toBe(0)
  expect(signed.sessionStorage.length).toBe(0)
  expect(signed.document.documentElement.outerHTML.includes(ada)).toBe(false)
  await open.happyDOM.abort()
  await signed.happyDOM.abort()
})
