import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Me } from '../api/routes.ts'
import { BoardError, type BoardClient, type ProfileOption } from '../client/client.ts'
import { InvalidProfileHeader, parseProfileHeader } from '../contract/profile-header.ts'
import { ATTACHMENT_BYTES_MAX } from '../contract/schemas.ts'
import { CSP, relative, shell } from './shell.ts'

/** A browser UI for one board, on this machine, reading and writing as the client's identity. */
export type Inspector = {
  url: string
  board: string
  /** Who it starts as. Null when each viewer signs in with their own token. */
  me: Me | null
  close(): Promise<void>
}

/** How a shared inspector turns a viewer's team token into a handle. The token never reaches the page. */
export type InspectorSignIn = {
  acting(credential: string): BoardClient
}

/** The inspector for one board, before a server has it: who it acts as, and what answers its requests there. */
export type InspectorPage = {
  board: string
  me: Me | null
  /**
   * What answers the page, its bundle, and its proxy on a server listening at `port` on this
   * machine: `handle` takes every request meant for them, and `close` stops the streams it has open.
   */
  at(port: number): { handle(request: IncomingMessage, response: ServerResponse): void; close(): void }
}

export const DEFAULT_PORT = 4747

/** What a proxy adds to a request it forwards: Tailscale's sets `X-Forwarded-Host`, most others `X-Forwarded-For`. */
const FORWARDED = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']

/** The prebuilt UI where board is installed, read only when an inspector starts without one. */
const bundle = async () => (await import('./page.ts')).page()

/**
 * The UI, and a proxy for the board's API that adds your credentials, for a server
 * on 127.0.0.1 to answer with. Because the proxy acts as you, it answers only its
 * own page: every request must name the server's host (no DNS rebinding) and carry
 * the per-run token that only the page has, and writes must also come from its
 * origin. Your credential for the board never leaves this process. With `signIn`,
 * the starter client is not who the page acts as: each viewer posts their own
 * token once, it stays in an HttpOnly cookie the page cannot read, and the proxy
 * forwards as them. `hosts` adds names a proxy in front of it serves the page on:
 * whoever reaches the page there acts as you, unless `visitor` says who a request
 * is, or `signIn` makes them sign in as themselves. A request a proxy forwarded
 * must name one of those hosts: the server's own name is this machine's alone,
 * and a caller behind a proxy can send it too.
 */
export async function createInspector(options: {
  client: BoardClient
  page?: string
  hosts?: string[]
  visitor?: (request: IncomingMessage) => BoardClient | null | undefined
  /** Each viewer signs in with their own token. The starter client is not who the page acts as. */
  signIn?: InspectorSignIn
}): Promise<InspectorPage> {
  const { client } = options
  const me = options.signIn ? null : await client.me()
  // Who it starts as (`--as claude`): the page's handle says who each request is, from there on.
  const started: ProfileOption = me === null || me.profile === null ? null : me.avatar ? { name: me.profile, avatar: me.avatar } : me.profile
  // The board it acts on, as that board names itself: a handle on one elsewhere has no URL of its own.
  const board = (await client.discovery().catch(() => null))?.url ?? client.url
  // The page it's given, or the one board is installed with.
  const app = options.page ?? (await bundle())
  const token = randomBytes(24).toString('base64url')
  // Hosts you allow are ones a proxy in front serves the page on, over http or https.
  const allowed = new Set((options.hosts ?? []).map((host) => host.toLowerCase()))
  let hosts = new Set<string>()
  // The hosts a proxy may forward a request for: never the server's own name, allowed or not.
  let proxied = new Set<string>()
  let origins = new Set<string>()
  const streams = new Set<AbortController>()

  async function viewer(request: IncomingMessage): Promise<BoardClient | null> {
    const credential = readCookie(request.headers.cookie)
    if (credential === undefined || !options.signIn) return null
    try {
      const acting = options.signIn.acting(credential)
      await acting.me()
      return acting
    } catch (error) {
      if (error instanceof BoardError && error.status === 401) return null
      throw error
    }
  }

  async function proxy(request: IncomingMessage, response: ServerResponse, url: URL, actingAs?: BoardClient) {
    const reading = request.method === 'GET' || request.method === 'HEAD'
    if (!sameSecret(String(request.headers['x-inspect-token'] ?? ''), token) || (!reading && !origins.has(String(request.headers.origin))))
      return json(response, 403, { error: { code: 'forbidden', message: "the board is reachable only from the inspector's own page" } })
    const path = url.pathname.slice('/board'.length) || '/'
    if (relative(path)) return json(response, 400, { error: { code: 'bad_path', message: 'no relative paths' } })
    // Whose page this is: yours, or where the proxy in front names its visitors, theirs.
    const visiting = options.visitor?.(request)
    if (visiting === null)
      return json(response, 401, { error: { code: 'unauthorized', message: "the proxy in front of this page names no one for this request, so there's no one to act as" } })
    const acting = visiting ?? actingAs ?? client
    const controller = new AbortController()
    streams.add(controller)
    response.on('close', () => controller.abort())
    try {
      // An upload is a whole file; everything else is a little JSON.
      const body = reading ? undefined : await read(request, path === '/attachments' ? ATTACHMENT_BYTES_MAX : undefined)
      // Who the page acts as is its handle's to say, the way any handle says it: `team.as(profile)`
      // sends the board's own `x-board-profile`, and a request with none is yours, as no profile.
      let as: ProfileOption = null
      const named = request.headers['x-board-profile']
      if (typeof named === 'string' && named.trim() !== '') {
        try {
          const { name, avatar } = parseProfileHeader(named)
          as = avatar === null ? name : { name, avatar }
        } catch (error) {
          if (!(error instanceof InvalidProfileHeader)) throw error
          return json(response, 400, { error: { code: 'invalid_profile', message: error.message } })
        }
      }
      const upstream = await acting.request(`${path}${url.search}`, {
        as,
        method: request.method ?? 'GET',
        headers: {
          ...(request.headers['content-type'] ? { 'content-type': String(request.headers['content-type']) } : {}),
          ...(request.headers.accept ? { accept: String(request.headers.accept) } : {}),
          ...(request.headers['x-board-filename'] ? { 'x-board-filename': String(request.headers['x-board-filename']) } : {}),
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
        // A write may carry a claim's proof, and the proxy can't tell: none follows a redirect.
        claim: !reading,
      })
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
      response.end()
    } catch (error) {
      if (controller.signal.aborted || response.headersSent) return void response.end()
      json(response, 502, { error: { code: 'unreachable', message: `the board didn't answer: ${(error as Error).message}` } })
    } finally {
      streams.delete(controller)
    }
  }

  function handle(request: IncomingMessage, response: ServerResponse) {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://inspector')
    } catch {
      // HTTP takes request targets a URL doesn't (`//[`): refused here, since a throw would stop the server.
      return send(response, 400, 'text/plain; charset=utf-8', 'bad request')
    }
    // A request a proxy forwarded is someone else's, whatever `Host` it carries: a caller behind one
    // can send this server's own name. So it reaches the page only at a host you allowed.
    const named = String(request.headers.host).toLowerCase()
    const forwarded = FORWARDED.some((header) => request.headers[header] !== undefined)
    if (!(forwarded ? proxied : hosts).has(named)) return send(response, 421, 'text/plain; charset=utf-8', 'wrong host')
    if (options.signIn) return void serveSignedIn(request, response, url).catch(() =>
      response.headersSent ? response.end() : send(response, 500, 'text/plain; charset=utf-8', 'error'),
    )
    if (url.pathname === '/board' || url.pathname.startsWith('/board/'))
      return void proxy(request, response, url).catch(() =>
        response.headersSent ? response.end() : send(response, 500, 'text/plain; charset=utf-8', 'error'),
      )
    if (request.method !== 'GET') return send(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
    if (url.pathname === '/app.js')
      return app
        ? send(response, 200, 'text/javascript; charset=utf-8', app)
        : send(response, 503, 'text/plain; charset=utf-8', "the inspector's UI isn't built: run `pnpm --filter @vercel/board build`")
    // Every other path is a route inside the page.
    send(response, 200, 'text/html; charset=utf-8', shell({ token, profile: started, base: '' }), { 'content-security-policy': CSP })
  }

  async function serveSignedIn(request: IncomingMessage, response: ServerResponse, url: URL) {
    const secure = secureCookie(request)
    if (url.pathname === '/sign-in' && request.method === 'GET') return signIn(response, 200, false)
    const signing = url.pathname === '/sign-in' || url.pathname === '/sign-out'
    if (signing) {
      if (request.method !== 'POST') return send(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
      if (!origins.has(String(request.headers.origin)))
        return json(response, 403, { error: { code: 'forbidden', message: "the board is reachable only from the inspector's own page" } })
      if (url.pathname === '/sign-out') {
        response.setHeader('set-cookie', clearCookie(secure))
        response.writeHead(303, { location: '/' })
        return void response.end()
      }
      let body: string
      try {
        body = new TextDecoder().decode(await read(request, 8 * 1024))
      } catch {
        return send(response, 413, 'text/plain; charset=utf-8', 'request too large')
      }
      const presented = new URLSearchParams(body).get('token') ?? ''
      if (presented.length === 0 || presented.length > 4096) return signIn(response, 401, true)
      const held = options.signIn!.acting(presented)
      try {
        await held.me()
      } catch (error) {
        if (error instanceof BoardError && error.status === 401) return signIn(response, 401, true)
        return json(response, 502, { error: { code: 'unreachable', message: "the board didn't answer" } })
      }
      response.setHeader('set-cookie', sessionCookie(presented, secure))
      response.writeHead(303, { location: '/' })
      return void response.end()
    }
    const acting = await viewer(request)
    const onBoard = url.pathname === '/board' || url.pathname.startsWith('/board/')
    if (!acting) {
      if (readCookie(request.headers.cookie) !== undefined) response.setHeader('set-cookie', clearCookie(secure))
      if (onBoard || request.method !== 'GET' || url.pathname === '/app.js')
        return json(response, 401, { error: { code: 'unauthorized', message: 'sign in with your team token' } })
      return signIn(response, 200, false)
    }
    if (onBoard) return proxy(request, response, url, acting)
    if (request.method !== 'GET') return send(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
    if (url.pathname === '/app.js')
      return app
        ? send(response, 200, 'text/javascript; charset=utf-8', app)
        : send(response, 503, 'text/plain; charset=utf-8', "the inspector's UI isn't built: run `pnpm --filter @vercel/board build`")
    send(response, 200, 'text/html; charset=utf-8', shell({ token, profile: started, base: '', signOut: true }), {
      'content-security-policy': CSP.replace("form-action 'none'", "form-action 'self'"),
    })
  }

  return {
    board,
    me,
    at(port) {
      const own = [`127.0.0.1:${port}`, `localhost:${port}`]
      hosts = new Set([...own, ...allowed])
      proxied = new Set([...allowed].filter((host) => !own.includes(host)))
      origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...[...allowed].flatMap((host) => [`http://${host}`, `https://${host}`])])
      return {
        handle,
        close() {
          for (const stream of streams) stream.abort()
        },
      }
    },
  }
}

/** The inspector on a server of its own, on 127.0.0.1: `port`, or 4747, or any free one when that's taken. */
export async function startInspector(options: { client: BoardClient; port?: number; page?: string; hosts?: string[]; signIn?: InspectorSignIn }): Promise<Inspector> {
  const inspector = await createInspector(options)
  let page: ReturnType<InspectorPage['at']> | null = null
  const server = createServer((request, response) => (page ? page.handle(request, response) : void response.writeHead(503).end()))
  const port = await listen(server, options.port ?? DEFAULT_PORT, options.port === undefined)
  const serving = (page = inspector.at(port))
  return {
    url: `http://127.0.0.1:${port}`,
    board: inspector.board,
    me: inspector.me,
    close: () =>
      new Promise<void>((resolve) => {
        serving.close()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

const VIEWER_COOKIE = 'board_viewer'
const SIGN_IN_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

function readCookie(header: IncomingMessage['headers']['cookie']): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1 || part.slice(0, eq).trim() !== VIEWER_COOKIE) continue
    let value: string
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return undefined
    }
    return value.length > 0 && value.length <= 4096 ? value : undefined
  }
  return undefined
}

function sessionCookie(credential: string, secure: boolean): string {
  return `${VIEWER_COOKIE}=${encodeURIComponent(credential)}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`
}

function clearCookie(secure: boolean): string {
  return `${VIEWER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`
}

function secureCookie(request: IncomingMessage): boolean {
  return String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase() === 'https'
}

function signIn(response: ServerResponse, status: number, refused: boolean) {
  send(response, status, 'text/html; charset=utf-8', signInPage(refused), { 'content-security-policy': SIGN_IN_CSP })
}

function signInPage(refused: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
  body { font: 16px/1.4 system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; }
  label { display: block; }
  input { width: 100%; box-sizing: border-box; margin: 0.5rem 0 1rem; }
</style>
</head>
<body>
<h1>Sign in</h1>
<p>Paste your team token. It stays in a cookie this page cannot read.</p>
${refused ? '<p>That token was refused.</p>' : ''}
<form method="post" action="/sign-in">
<label>Team token <input name="token" type="password" autocomplete="off" required maxlength="4096"></label>
<button type="submit">Sign in</button>
</form>
</body>
</html>`
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function read(request: IncomingMessage, limit = 1024 * 1024): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request too large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  response.end(body)
}

const json = (response: ServerResponse, status: number, body: unknown) =>
  send(response, status, 'application/json', JSON.stringify(body))

/** Listens on the port, or any free one when the default port is taken. */
async function listen(server: Server, port: number, fallback: boolean): Promise<number> {
  try {
    return await listenOn(server, port)
  } catch (error) {
    if (fallback && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') return listenOn(server, 0)
    throw error
  }
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}
