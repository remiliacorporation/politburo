import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP, type AddressInfo } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { BoardError, createBoardClient, type BoardClient } from '../client/client.ts'
import { localTokenFile } from '../client/node.ts'
import { local } from '../server/local.ts'
import { oidcTokens } from '../server/tokens.ts'
import { board } from '../server/index.ts'
import { hostCheckedBy } from '../server/board.ts'
import type { Authenticate, HostPrincipal } from '../server/auth.ts'
import { unauthorized } from '../server/errors.ts'
import { Failed } from './main.ts'
import { tailscale, tailscaleLogin } from './tailscale.ts'

export const DEFAULT_SERVE_PORT = 4100
/** Where the board is mounted on its server: every other path is the inspector's, when it's served. */
const MOUNT = '/api/board'
const mounted = (path: string) => path === MOUNT || path.startsWith(`${MOUNT}/`)
const ISSUER = 'board:local'
const BODY_MAX = 8 * 1024 * 1024

/** What answers a request on the board's server that isn't for the board. */
type Handler = (request: IncomingMessage, response: ServerResponse) => void

type ServingBoard = {
  /** The board's direct URL at `/api/board`. */
  url: string
  /** The port its server listens on, where a page beside the board is served too. */
  port: number
  /** Where its log and attachments live. */
  dir: string
  close(): Promise<void>
}

export type LocalBoard = ServingBoard & {
  mode: 'local'
  /** Answers every request outside the board's mount (`/api/board`) with `handler`: the inspector. Without one, the board answers them 404. */
  page(handler: Handler): void
  /**
   * Who a request to the page is, where Tailscale serves the board: a client on the board as the
   * person Tailscale says sent it, or null when it names no one. Undefined at any other host, where
   * the page is yours.
   */
  visitor(request: IncomingMessage): BoardClient | null | undefined
  /** Who you are on it: `local:user:<name>`. */
  principal: string
  handle: string
  /** Your token for it, also in `localTokenFile(url)`. */
  token: string
}

type TeamBoard = ServingBoard & { mode: 'team' }

type ServeOptions = {
  dir: string
  host?: string
  port?: number
  teamTokens?: string
  handle?: string
  hosts?: readonly string[]
  tailscale?: readonly string[]
  agentOps?: true
}

/** Your OS username as a handle: lowercase letters, digits, `.`, `_`, `-`. */
export function localHandle(name = safeUsername()): string {
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/, '')
  return handle || 'me'
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USER || process.env.USERNAME || 'me'
  }
}

/** What an earlier `vb serve` left under `dir` (`board.db`, `attachments/`), moved to where `local()` keeps the board. */
async function carryOver(dir: string) {
  const there = (path: string) => stat(join(dir, path)).then(() => true, () => false)
  if (!(await there('board.db')) || (await there('local.db'))) return
  for (const suffix of ['', '-wal', '-shm']) if (await there(`board.db${suffix}`)) await rename(join(dir, `board.db${suffix}`), join(dir, `local.db${suffix}`))
  if ((await there('attachments')) && !(await there('local'))) await rename(join(dir, 'attachments'), join(dir, 'local'))
}

/** Validate the bind IP without ever including the supplied value in an error. */
function bindHost(options: ServeOptions) {
  const { host, teamTokens, tailscale } = options
  const invalid = (message: string) => new Failed({ class: 'usage', reason: 'invalid_arguments', message })
  if (teamTokens !== undefined && tailscale?.length)
    throw invalid("--team-tokens can't be used with --tailscale.")
  if (host === undefined) return { ip: '127.0.0.1', hostname: '127.0.0.1' }
  if (teamTokens === undefined) throw invalid('--host requires --team-tokens.')
  const version = isIP(host)
  if (version === 0 || host.includes('%')) throw invalid('--host needs an IPv4 or IPv6 address.')
  const hostname = version === 6 ? new URL(`http://[${host}]`).hostname : host
  if (hostname === '0.0.0.0' || hostname === '[::]' || hostname === '[::ffff:0:0]')
    throw invalid('--host needs a specific IP address, not an unspecified address.')
  return { ip: host, hostname }
}

const TEAM_HANDLE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const TEAM_TOKEN = /^[a-f0-9]{64}$/
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/** The file is read once at startup. The verifier keeps digests, not the raw bearer tokens. */
async function teamVerifier(file: string): Promise<Authenticate> {
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Failed({
      class: 'usage', reason: 'unreadable_team_tokens', message: "Can't read the --team-tokens file.",
      next: [{ instruction: 'Pass the path to a readable JSON file' }],
    })
  })
  const invalid = () => new Failed({
    class: 'usage', reason: 'invalid_team_tokens', message: 'The --team-tokens file is invalid.',
    next: [{ instruction: 'Use a nonempty JSON object mapping lowercase handles to unique 64-character lowercase hex tokens' }],
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A JSON parse error can include the raw input.
    throw invalid()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid()
  const people = new Map<string, HostPrincipal>()
  for (const [handle, token] of Object.entries(parsed)) {
    if (!TEAM_HANDLE.test(handle) || typeof token !== 'string' || !TEAM_TOKEN.test(token)) throw invalid()
    const key = digest(token)
    if (people.has(key)) throw invalid()
    people.set(key, { id: `team:user:${handle}`, kind: 'person', handle })
  }
  if (people.size === 0) throw invalid()
  return ({ credential }) => {
    if (credential === null) return null
    const person = TEAM_TOKEN.test(credential) ? people.get(digest(credential)) : undefined
    if (person === undefined) throw unauthorized('invalid team token')
    return person
  }
}

async function localIssuer() {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'local', alg: 'ES256' }] })
  return {
    authenticate: oidcTokens({ local: { issuer: ISSUER, jwks } }),
    sign: (url: string, handle: string) => new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'local' })
      .setIssuer(ISSUER)
      .setAudience(url)
      .setSubject(handle)
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(privateKey),
  }
}

/**
 * A standalone `local()` board with SQLite and attachments under `dir` and no sync. `hosts` adds
 * proxy names for discovery and auth. Normally it listens on loopback and writes a local JWT for
 * you; `tailscale` names the proxies it can also trust for identity. With `teamTokens` it serves
 * only the API and trusts only that file's credentials, even on loopback.
 */
export async function serveLocal(options: ServeOptions): Promise<LocalBoard | TeamBoard> {
  const { ip, hostname } = bindHost(options)
  const auth = options.teamTokens === undefined
    ? await localIssuer()
    : { authenticate: await teamVerifier(options.teamTokens) }
  const dir = resolve(options.dir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  quietSqliteWarning()
  await carryOver(dir)
  const backend = local({ dir, ...(options.agentOps ? { agentOps: true } : {}) })

  const tailnet = new Set((options.tailscale ?? []).map((host) => host.toLowerCase()))
  const hosts = new Set([...(options.hosts ?? []).map((host) => host.toLowerCase()), ...tailnet])
  // Its own address, once the port is known: where every request reaches it but one for a host you allowed.
  let origin = ''
  let handler: ((request: Request) => Promise<Response>) | null = null
  let page: Handler | null = null
  const server = createServer((request, response) => {
    if (!handler) return void response.writeHead(503).end()
    if (page && !mounted((request.url ?? '/').split('?')[0]!)) {
      // Whatever the page makes of a request, the board keeps serving.
      try {
        return page(request, response)
      } catch {
        if (!response.headersSent) response.writeHead(500)
        return void response.end()
      }
    }
    void forward(handler, originOf(request, origin, hosts), request, response)
  })
  let port: number
  try {
    port = await listen(server, ip, options.port ?? DEFAULT_SERVE_PORT)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      throw new BoardError('port_taken', `Port ${options.port ?? DEFAULT_SERVE_PORT} is taken. Is a board already running there?`, 0)
    throw error
  }
  origin = `http://${hostname}:${port}`
  const url = `${origin}${MOUNT}`
  const team = board(hostCheckedBy({
    // Its timers live in this process, which runs as long as the board does.
    backend,
    // At a host Tailscale serves it on, a request's URL is that host's, since `originOf` allowed it.
    authenticate: tailnet.size > 0 ? tailscale(auth.authenticate, (audience) => servedAt(tailnet, audience)) : auth.authenticate,
    // No `url`: the board is at the URL a request reaches it at, a token's audience there, and
    // `originOf` lets a request name only this server's own or a host you allowed. So this handle
    // knows no URL of its own: its `url` is the in-process one, and `sandboxPolicy()` has none to
    // give. It only serves requests here: hand it nothing that needs either.
    basePath: MOUNT,
  }))
  const close = async () => {
    const closed = new Promise<void>((done) => server.close(() => done()))
    server.closeAllConnections()
    await closed
    await backend.close()
  }
  const serving = { url, port, dir, close }
  let handle: string
  let token: string
  let file: string
  try {
    // Opened now, so a directory it can't write says so before it serves.
    await team.channels({ limit: 1 })
    if (!('sign' in auth)) {
      handler = team.fetch
      return { mode: 'team', ...serving }
    }
    handle = options.handle ?? localHandle()
    token = await auth.sign(url, handle)
    file = localTokenFile(url)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify({ url, token, handle }), { mode: 0o600 })
    handler = team.fetch
  } catch (error) {
    await close()
    throw error
  }

  // One client a person at each host: the page's requests reach the board in this process, as Tailscale named them.
  const visitors = new Map<string, BoardClient>()
  return {
    mode: 'local',
    ...serving,
    page(handler) {
      page = handler
    },
    visitor(request) {
      const at = originOf(request, origin, hosts)
      // Only this server's own address is yours. At a host Tailscale serves, the page is whoever
      // Tailscale names, or no one; and on a board behind Tailscale, so is it at any other host, so
      // nothing about how a host is written, a port added or left out, makes a caller you.
      if (at === origin) return undefined
      if (!servedAt(tailnet, at)) return tailnet.size > 0 ? null : undefined
      const login = tailscaleLogin(request.headers['tailscale-user-login'])
      if (login === null) return null
      const key = `${at} ${login}`
      const known = visitors.get(key)
      if (known) return known
      const client = createBoardClient({
        url: `${at}${MOUNT}`,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const sent = new Request(input, init)
          sent.headers.set('tailscale-user-login', login)
          return team.fetch(sent)
        }) as typeof fetch,
      })
      visitors.set(key, client)
      return client
    },
    principal: `local:user:${handle}`,
    handle,
    token,
    async close() {
      await rm(file, { force: true })
      await close()
    },
  }
}

/** Node flags `node:sqlite` as experimental on stderr, which would be the CLI's only stderr line. */
function quietSqliteWarning() {
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (/SQLite is an experimental feature/.test(text)) return
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
}

function listen(server: Server, ip: string, port: number): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(port, ip, () => {
      server.off('error', fail)
      done((server.address() as AddressInfo).port)
    })
  })
}

/**
 * Where a request reached this server: at a host you allowed, over `https` when the proxy in front
 * says so (`X-Forwarded-Proto`), and at the server's `own` address for any other. A request's
 * sender chooses its `Host`, so one you didn't allow never names the board.
 */
function originOf(request: IncomingMessage, own: string, hosts: ReadonlySet<string>): string {
  const host = String(request.headers.host ?? '').toLowerCase()
  if (!hosts.has(host)) return own
  const scheme = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase()
  return `${scheme === 'https' ? 'https' : 'http'}://${host}`
}

/**
 * Whether `url` is at one of `hosts`, however each was written: a URL leaves its scheme's own port
 * out of its host (`box:443` over https is `box`), so each is compared as that URL would write it.
 */
function servedAt(hosts: ReadonlySet<string>, url: string): boolean {
  const { protocol, host } = new URL(url)
  for (const named of hosts) {
    try {
      if (new URL(`${protocol}//${named}`).host === host) return true
    } catch {
      // Not a host a URL can hold: it names nothing.
    }
  }
  return false
}

async function forward(handler: (request: Request) => Promise<Response>, origin: string, req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  try {
    let body: Uint8Array<ArrayBuffer> | undefined
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > BODY_MAX) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'too_large', message: 'request too large' } }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      body = new Uint8Array(Buffer.concat(chunks))
    }
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    const response = await handler(
      new Request(`${origin}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        ...(body && body.length > 0 ? { body } : {}),
        signal: controller.signal,
      }),
    )
    const out: Record<string, string | string[]> = {}
    response.headers.forEach((value, key) => {
      if (key === 'set-cookie') return
      out[key] = value
    })
    res.writeHead(response.status, out)
    if (response.body)
      try {
        for await (const chunk of response.body) res.write(chunk)
      } catch {}
    res.end()
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'internal', message: (error as Error).message } }))
  }
}
