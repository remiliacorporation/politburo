import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { board, type Board } from '@vercel/board'
import { compileAccess, type HostPrincipal } from '@vercel/board/access'
import { local, type LocalOptions } from '@vercel/board/backend-local'
import { decodeJwt } from 'jose'
import { parseConfigText } from '../config/load.ts'
import { accessIssuer } from './assertion.ts'
import { accessKeys, parseMembers, personAuthenticator, principalId, type AssertionOptions, type Members } from './index.ts'

type ServeOptions = Omit<AssertionOptions, 'keys'> & {
  keys?: AssertionOptions['keys']
  members: Members
  dir?: string
  memory?: boolean
  tunnelPort?: number
  publicHosts?: readonly string[]
  attentionResponders?: LocalOptions['attentionResponders']
}

const loopback = '127.0.0.1'
const assertion = 'cf-access-jwt-assertion'
const grantWriter = 'swarm-members'

async function seed(handle: Board, members: Members) {
  // Board user grants match suffixes, not issuers. Never join an existing user's grants.
  const wanted = new Map([...members.values()].map(({ email, can }) => [principalId(email).split(':')[2]!, can]))
  const writer = handle.as(grantWriter)
  const grants = await writer.grants()
  for (const grant of grants) {
    if (grant.by !== `board:client:${grantWriter}` && grant.principals.some((p) => p.kind === 'user' && wanted.has(p.userId))) {
      throw new Error('member_grant_collision')
    }
  }
  for (const { id, by, principals, can } of grants) {
    if (id === 'g1' || id === 'g2' || id === 'g3') {
      await writer.revokeGrant(id)
    } else if (by === `board:client:${grantWriter}`) {
      const [principal] = principals
      if (principals.length === 1 && principal?.kind === 'user' && isDeepStrictEqual(wanted.get(principal.userId), can)) {
        wanted.delete(principal.userId)
      } else {
        await writer.revokeGrant(id)
      }
    }
  }
  for (const [userId, can] of wanted) await writer.createGrant({ principals: [{ kind: 'user', userId }], can })
}

function reject(status: number, code: string, message = code) {
  return Response.json({ error: { code, message } }, { status })
}

async function writeResponse(res: ServerResponse, response: Response) {
  const headers = new Headers(response.headers)
  headers.delete('set-cookie')
  headers.set('cache-control', 'no-store')
  res.writeHead(response.status, Object.fromEntries(headers))
  if (response.body) await pipeline(Readable.from(response.body.values()), res)
  else res.end()
}

export async function serveBoard(options: ServeOptions): Promise<{ tunnelUrl?: string; handle: Board; close(): Promise<void> }> {
  const { dir, memory, tunnelPort, members } = options
  const hosts = new Set(options.publicHosts?.map((host) => new URL(accessIssuer(host)).hostname))
  const authenticatePerson = personAuthenticator({ ...options, keys: options.keys ?? accessKeys(options.teamDomain) })
  const verified = new WeakMap<Headers, HostPrincipal>()
  const memberAccess = new Map([...members.values()].map(({ email, can }) => [principalId(email), compileAccess(can)]))
  const signIn = () => reject(401, 'unauthorized', 'Cloudflare Access sign-in required')
  const responders = [...members.values()].filter(({ can }) => can['*'] === 'all' || can['*']?.includes('manage'))
  const attentionResponders = options.attentionResponders ?? { '*': responders.map(({ email }) => principalId(email)) }
  const backend = local({ dir, memory, agentOps: true, politburo: 1, attentionResponders })
  const handle = board({ backend, basePath: '/', authenticate: ({ headers }) => verified.get(headers) ?? signIn() })
  const pending = new Set<Promise<void>>()
  let tunnelUrl: string | undefined
  const server = createServer((req, res) => {
    const request = serve(req, res).catch(async () => {
      if (!res.headersSent && !res.destroyed) await writeResponse(res, reject(500, 'internal'))
      else res.destroy()
    })
    pending.add(request)
    void request.then(() => pending.delete(request), () => pending.delete(request))
  })

  async function serve(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host?.toLowerCase() ?? ''
    const publicHost = hosts.has(host)
    if (!publicHost && `http://${host}` !== tunnelUrl) return writeResponse(res, reject(403, 'invalid_host'))
    const token = req.headers[assertion]
    if (typeof token !== 'string') return writeResponse(res, signIn())
    const caller = await authenticatePerson(new Headers({ [assertion]: token }))
    if (!caller) return writeResponse(res, signIn())
    if (caller instanceof Response) return writeResponse(res, caller)
    // Service assertions can carry common_name or the non_identity token type, not a person session.
    const claims = decodeJwt(token)
    if (claims.common_name !== undefined || claims.type === 'non_identity') return writeResponse(res, signIn())

    const method = req.method ?? 'GET'
    const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
    const origin = publicHost ? `https://${host}` : tunnelUrl!
    const site = req.headers['sec-fetch-site']
    if (!read && ((site !== undefined && site !== 'same-origin' && site !== 'none') ||
      (req.headers.origin !== undefined && (!publicHost || req.headers.origin !== origin)))) {
      return writeResponse(res, reject(403, 'cross_site_write'))
    }
    if (!req.url?.startsWith('/')) return writeResponse(res, reject(400, 'invalid_path'))
    const url = new URL(`${origin}${req.url}`)
    const channel = url.searchParams.get('channel')
    // Board filters list results; an explicitly requested channel outside the registry gets a 403.
    if (method === 'GET' && url.pathname === '/messages' && channel && !memberAccess.get(caller.id)?.readable(channel)) {
      return writeResponse(res, reject(403, 'forbidden'))
    }

    if (res.destroyed) return
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    const chunks: Buffer[] = []
    let size = 0
    if (!read) for await (const chunk of req) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) return writeResponse(res, reject(413, 'too_large'))
      chunks.push(chunk)
    }
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if ([assertion, 'authorization', 'cookie', 'tailscale-user-login'].includes(key)) continue
      if (typeof value === 'string') headers.set(key, value)
      else if (value) for (const item of value) headers.append(key, item)
    }
    const request = new Request(url, {
      method, headers, ...(size ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}), signal: controller.signal,
    })
    verified.set(request.headers, caller)
    await writeResponse(res, await handle.fetch(request))
  }

  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    if (server.listening) {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await stopped
    }
    await Promise.allSettled(pending)
    await backend.close()
  })()

  try {
    await seed(handle, members)
    if (tunnelPort !== undefined) {
      const listening = once(server, 'listening')
      server.listen(tunnelPort, loopback)
      await listening
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no_listener_address')
      tunnelUrl = `http://${loopback}:${address.port}`
    }
    return { tunnelUrl, handle, close }
  } catch (error) {
    await close()
    throw error
  }
}

const usage = 'usage: swarm serve --dir DIR --members FILE [--tunnel-port N --public-host HOST]\n' +
  '                   [--team-domain HOST] [--audience AUD]'

export async function serveCommand(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage)
    return 0
  }
  let options: ServeOptions
  try {
    const { values } = parseArgs({ args, options: {
      dir: { type: 'string' }, members: { type: 'string' }, 'tunnel-port': { type: 'string' },
      'team-domain': { type: 'string' }, audience: { type: 'string' }, 'public-host': { type: 'string', multiple: true },
    } })
    const { dir, members: file, 'tunnel-port': port, 'public-host': publicHosts } = values
    const teamDomain = values['team-domain'] ?? process.env.SWARM_ACCESS_TEAM_DOMAIN
    const audience = values.audience ?? process.env.SWARM_ACCESS_AUD
    if (!dir || !file || !teamDomain || !audience || audience.trim() !== audience ||
      (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) > 65535 || !publicHosts?.length))) throw new Error()
    accessIssuer(teamDomain)
    publicHosts?.forEach(accessIssuer)
    const members = parseMembers(parseConfigText(await readFile(file, 'utf8')))
    options = { dir, members, teamDomain, audience, publicHosts, tunnelPort: port === undefined ? undefined : Number(port) }
  } catch {
    console.error('error: invalid serve options or member registry')
    console.error(usage)
    return 2
  }
  try {
    const running = await serveBoard(options)
    if (!running.tunnelUrl) {
      await running.close()
      return 0
    }
    console.log(`board  ${running.tunnelUrl}`)
    const stop = () => void running.close().catch(() => {
      console.error('error: board shutdown failed')
      process.exitCode = 1
    })
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return 0
  } catch (error) {
    console.error(error instanceof Error && error.message === 'member_grant_collision'
      ? 'error: member id conflicts with an existing board grant' : 'error: cannot start board')
    return 1
  }
}
