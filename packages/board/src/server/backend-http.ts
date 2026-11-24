import { z } from 'zod'
import { BoardStatus, completeWithEvidencePath, readDiscovery, routes, type Discovery, type EventsPage } from '../api/routes.ts'
import { boundTaskPaths } from '../api/task-authority.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import { BoardError, createBoardClient, type BoardClient, type ProfileOption } from '../client/client.ts'
import { DERIVED_ID, keyId } from '../client/ids.ts'
import { boardEvents } from '../contract/events.ts'
import { AgentIntent, AgentRun, ATTACHMENT_BYTES_MAX, type Attachment } from '../contract/schemas.ts'
import { type Backend, type BoardBinding, type Caller, type ProtocolMethods, type SelfCaller } from './backend.ts'
import { HttpError, noAgentOps } from './errors.ts'
import { isAgentIntentMethod, isAgentOpsMethod, METHODS, type AgentOpsMethod } from './routing.ts'
import { compileWatcher } from './watch-spec.ts'
import { deployedOnVercel } from './registrant.ts'
import { tailWatchers } from './tails.ts'
import { PROTOCOL_ROUTES, withoutToken, type SandboxInput, type SandboxReach } from './sandbox.ts'
import { formatProfileHeader } from '../contract/profile-header.ts'

export type HttpOptions = {
  /**
   * How requests reach the board, with the credentials it recognizes. In Node it defaults to what
   * `vb` uses: a token from `BOARD_TOKEN`, `vb serve`'s, GitHub Actions, Vercel, or `vercel login`,
   * through Deployment Protection. In a browser, `fetch`, sending the page's own session (a cookie,
   * say), which the board's `authenticate` recognizes.
   */
  fetch?: typeof fetch
}

/**
 * What finds a board and reaches it, in the Node build: the environment, its files, and
 * `vercel login`. A browser has none.
 */
export type Environment = {
  /** The board the environment points at. Throws `no_board` when it points at none. */
  url(): string
  /** The fetch for the board at `url` when none is given: the credentials `vb` uses, through Deployment Protection. */
  fetch(url: string): typeof fetch
  /** The profile the environment names: `BOARD_PROFILE`, with `BOARD_AVATAR`. */
  profile(): ProfileOption
  /** What a sandbox's requests to the board at `url` carry from this deployment: `token`, or its own OIDC token, and what gets them through Deployment Protection. */
  sandbox(url: string, token: string | undefined): Promise<Record<string, string>>
}

/** A watcher's or client's name is the profile its writes are by. */
const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const PROFILE_RULE = 'ids start with a letter and use up to 32 letters, numbers, and hyphens'

const Agent = boardEvents['ops.agent_changed'].shape.agent
// Strip extra fields from HTTP replies without loosening the schemas for requests or the log.
const AgentIntentResponse = AgentIntent.strip().extend({
  run: AgentRun.strip().optional(),
  taken: AgentIntent.shape.taken.unwrap().strip().nullable(),
  report: AgentIntent.shape.report.unwrap().strip().nullable(),
})
const IssuedIntents = z.object({ intents: z.array(AgentIntentResponse) })
const AgentHealthResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('working'), validUntil: z.iso.datetime() }),
  // Only a working run has a deadline. Don't silently strip a deadline from this branch.
  z.object({ state: z.literal('not_confirmed'), validUntil: z.never().optional() }),
])
const agentResponses = {
  listOpsAgents: z.object({ agents: z.array(Agent) }),
  registerOpsAgent: Agent,
  heartbeatOpsAgent: Agent,
  retireOpsAgent: Agent,
  issueOpsIntent: IssuedIntents,
  issueOpsRoleIntent: IssuedIntents,
  listOpsIntents: IssuedIntents.extend({ next: z.string().nullable() }),
  takeOpsIntent: AgentIntentResponse,
  reportOpsIntent: AgentIntentResponse,
  getOpsHealth: AgentHealthResponse,
} satisfies { [M in AgentOpsMethod]: z.ZodType<Protocol[M]['output']> }

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

const noEvidenceCompletion = () => new HttpError(501, 'no_work_evidence', 'the HTTP board does not support completion with work evidence', {
  origin: 'handle', hint: 'Upgrade the board before completing with a commit.',
})

/** The SDK's error, as the board answers it: the remote's own status and code, or 502 when it never answered. */
const rethrow = (error: unknown): never => {
  if (error instanceof BoardError)
    throw new HttpError(error.status >= 400 ? error.status : 502, error.code, error.message, {
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      origin: error.origin,
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    })
  if (error instanceof HttpError || (error instanceof Error && error.name === 'AbortError')) throw error
  throw new HttpError(502, 'unreachable', `the board didn't answer: ${describe(error)}`)
}

/** A parsed input, back on the wire as a query string. */
function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    // A flag left off is false: `all=false` would read as true.
    if (value === undefined || value === null || value === false) continue
    // Label filters parse to `[key, values | null]`.
    if (key === 'label' && Array.isArray(value))
      for (const [name, values] of value as [string, string[] | null][]) params.append('label', values === null ? name : `${name}=${values.join('|')}`)
    else if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** A file the remote served, as the board stored it: its headers say what it is. */
function attachmentOf(id: string, response: Response): Protocol['attachment']['output'] {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  let name = 'file'
  try {
    if (encoded) name = decodeURIComponent(encoded)
  } catch {}
  const attachment: Attachment = {
    id,
    name,
    type: response.headers.get('content-type') ?? 'application/octet-stream',
    size: Number(response.headers.get('content-length') ?? 0),
  }
  return { attachment, data: response.body ?? new Uint8Array() }
}

/** The protocol methods that are a claim's own writes: each carries its proof. */
const CLAIM_WRITES = new Set<Method>(['renewTask', 'releaseTask', 'completeTask', 'failTask', 'handoffTask'])
/** The ones that carry a claim's token only when the caller brings one. */
const CLAIM_WITH_TOKEN = new Set<Method>(['createTask', 'claimTask', 'claimReadyTask', 'blockTask', 'setTaskPriority'])

/** Whether a call's request carries a claim's token, by the method and its input: the flag the client's transport refuses redirects for. */
const carriesClaim = (method: Method, input: Record<string, unknown>): boolean =>
  CLAIM_WRITES.has(method) ||
  (CLAIM_WITH_TOKEN.has(method) && input.token !== undefined) ||
  (method === 'requestTaskAttention' && input.claim !== undefined)

/**
 * Another board that speaks the protocol, at `url` (in Node, the one the environment points at
 * by default): this board keeps nothing, and this deployment reads and writes that one as itself.
 * Its watchers' tails are registered there. The remote wakes it when one matches, with nothing in
 * the wake-up but a hash, and it pulls what matched with its own credentials, runs it, and acks
 * it. When it can't be woken (no https URL of its own: a dev server, say), it pulls on its own.
 */
export function createHttp(url: string | undefined, options: HttpOptions, environment: Environment | null) {
  if (url !== undefined && !/^https?:\/\/[^/]/.test(url)) throw new Error(`http: ${url} isn't a URL: pass the board's, like https://board.example.com/api/board`)
  if (url === undefined && !environment) throw new Error("http: pass the board's URL: outside Node there's no environment to find it in")
  const remote = (url ?? environment!.url()).replace(/\/+$/, '')
  const doFetch: typeof fetch = options.fetch ?? environment?.fetch(remote) ?? ((input, init) => globalThis.fetch(input, init))
  let binding: BoardBinding | null = null
  /** This board's watchers, compiled: they run here, as tails of the board it uses. */
  const tails: Parameters<typeof tailWatchers>[0]['watchers'] = {}
  const bound = () => {
    if (!binding) throw new Error("http: this backend isn't serving a board yet: pass it to board({ backend })")
    return binding
  }

  /**
   * The SDK against the remote, as this deployment with `profile`, or the environment's for
   * `undefined`. Who the token's holder is, `fetch` says.
   */
  const sdk = (profile: ProfileOption | undefined, can?: string) =>
    createBoardClient({
      url: remote,
      fetch: doFetch,
      profile: profile !== undefined ? profile : () => environment?.profile() ?? null,
      // A handle `as(profile, { can })` narrowed: the board it uses holds it to that, as it does a sandbox.
      ...(can !== undefined ? { headers: { 'x-board-can': can } } : {}),
    })

  const own = sdk(null)
  const profiles = new Map<string, BoardClient>()
  /** This deployment as `profile`: a watcher's ID, or the middleware. */
  function asProfile(profile: string): BoardClient {
    if (!PROFILE.test(profile)) throw new HttpError(400, 'invalid_request', `as: ${profile}: profiles start with a letter and use up to 32 letters, numbers, and hyphens`)
    let client = profiles.get(profile)
    if (!client) profiles.set(profile, (client = sdk(profile)))
    return client
  }
  const holders = new Map<string, BoardClient>()
  /** The token's holder, with `profile` (`undefined`: the environment's), narrowed to `can` when a handle is. */
  function holder(profile: ProfileOption | undefined, can: string | undefined): BoardClient {
    const key = JSON.stringify([profile ?? (profile === null ? null : '\u0000'), can ?? null])
    let client = holders.get(key)
    if (!client) holders.set(key, (client = sdk(profile, can)))
    return client
  }

  /**
   * The client a call of this deployment's own code goes through: a handle's, as the token's holder
   * with its profile; a watcher's or the middleware's, as this deployment with theirs; and sync's,
   * as the deployment itself.
   */
  function clientOf(caller: SelfCaller): BoardClient {
    if (caller.origin.via?.kind === 'engine') return own
    if (caller.origin.via?.kind === 'client') {
      if (caller.self !== null) asProfile(caller.self)
      // The handle itself is whoever the environment picks; `as()` names its own, or none.
      return holder('profile' in caller ? caller.profile : caller.self ?? undefined, caller.can)
    }
    return asProfile(caller.self ?? 'client')
  }

  async function fetchDiscovery(init?: RequestInit): Promise<Discovery> {
    const response = await doFetch(remote, init).catch(rethrow)
    // This handle's own finding about the URL it was given, not the remote's words.
    if (!response.ok)
      throw new HttpError(response.status >= 400 ? response.status : 502, 'no_board', `There's no board at ${remote}: it answered ${response.status}.`, { origin: 'handle' })
    return readDiscovery(response)
  }

  let discovered: Promise<Discovery> | null = null
  /** The board it uses' discovery, for a handle here: who it is, and the sync entries it lists. */
  const discovery = () =>
    (discovered ??= fetchDiscovery()).catch((error: unknown) => {
      discovered = null
      throw error
    })

  let principal: Promise<string> | null = null
  /** This deployment's principal on the remote, asked once. */
  const self = () =>
    (principal ??= own
      .me()
      .then((me) => me.principal)
      .catch((error) => {
        principal = null
        throw error
      }))
  /**
   * A post's ID, from the one board() derived for it, under this deployment's own principal: the
   * remote takes a `key:<principal>:` ID only from that principal, so no one can post with it first.
   */
  const ownKey = async (derived: string) => keyId(await self(), derived)

  /** One protocol call on the remote, as `client`, with the input back on the wire. */
  async function call(client: BoardClient, method: Method, input: Record<string, unknown>, signal: AbortSignal, pathOverride?: string): Promise<Response> {
    const route = routes[method]
    const withEvidence = pathOverride === completeWithEvidencePath
    // Each `:name` in the path is the input's field of that name; the rest are the query or the body.
    const fields = { ...input }
    // The remote derives the audience from its own mount, not from an HTTP client's input.
    if (method === 'redeemInvite') return Response.json(await client.join((input as Protocol['redeemInvite']['input']).secret).catch(rethrow))
    const path = (pathOverride ?? route.path).replace(/:(\w+)/g, (_, name: string) => {
      const value = fields[name]
      delete fields[name]
      return encodeURIComponent(String(value))
    })
    let response: Response
    const refuseRedirect = pathOverride === completeWithEvidencePath || method === 'submitWork' || method === 'recordEvidence' || method === 'overrideEvidence' || method === 'resolveWorkEdge'
    if (method === 'upload') {
      const { data, name, type } = input as Protocol['upload']['input']
      // Too big for one request (a platform file sync imports): straight to the board's blob store,
      // where it signs uploads. Elsewhere, refused here, so no body goes over the wire to be refused.
      if (data.byteLength > ATTACHMENT_BYTES_MAX) {
        const attachment = await client.upload({ data: data as Uint8Array<ArrayBuffer>, name: name ?? 'file', ...(type ? { type } : {}) }).catch(rethrow)
        return Response.json({ attachment })
      }
      response = await client
        .request(path, {
          method: 'POST',
          body: data as Uint8Array<ArrayBuffer>,
          headers: { ...(type ? { 'content-type': type } : {}), ...(name !== null ? { 'x-board-filename': encodeURIComponent(name) } : {}) },
          signal,
          // The inspector flags the writes it forwards, and the handle in between drops the flag: a file goes nowhere but here.
          claim: true,
        })
        .catch(rethrow)
    } else if (route.method === 'GET') response = await client.request(`${path}${queryString(fields)}`, { signal }).catch(rethrow)
    else if (method === 'archiveOperationalMessage') response = await client.request(path, { method: 'POST', signal }).catch(rethrow)
    else
      response = await client
        .request(path, {
          method: route.method, body: new TextEncoder().encode(JSON.stringify(fields)), headers: { 'content-type': 'application/json' }, signal,
          claim: carriesClaim(method, input),
          ...(refuseRedirect ? { redirect: 'manual' as const } : {}),
        })
        .catch(rethrow)
    if (refuseRedirect && (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400))) {
      const completion = pathOverride === completeWithEvidencePath
      throw new HttpError(502, 'remote_error', completion
        ? 'The board redirected a completion with work evidence. This handle never follows those redirects.'
        : 'The board redirected a work-evidence request. This handle never follows those redirects.', {
        origin: 'handle', hint: "Point `url` at the board's final URL.",
      })
    }
    if (response.ok) return response
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string; hint?: unknown } }
      if (body.error?.message)
        throw new HttpError(response.status, body.error.code ?? 'error', body.error.message, typeof body.error.hint === 'string' ? { hint: body.error.hint } : {})
    } catch (error) {
      if (error instanceof HttpError) throw error
    }
    throw new HttpError(502, 'remote_error', `${remote} answered ${response.status}`)
  }

  /** A protocol method, called on the board it uses, as `caller`. */
  async function remoteCall(method: Method, caller: Caller, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    // board() serves no requests for a board that uses another's: only its own code calls here.
    if ('identity' in caller) throw new HttpError(404, 'not_found', `this board uses ${remote}, and answers nothing itself`)
    const boundPath = input.binding !== undefined && (method === 'createTask' || method === 'claimReadyTask' || method === 'claimTask') ? boundTaskPaths[method] : undefined
    if (boundPath) {
      // Ask again on a new call so an upgraded board can start taking bound claims. Even a positive
      // answer may be stale or come from a different instance: never fall back to the legacy path.
      signal.throwIfAborted()
      const response = await doFetch(remote, { signal, cache: 'no-store' }).catch(rethrow)
      const found = response.ok ? (await response.json().catch(() => null)) as Discovery | null : null
      if (found?.task_authority !== true) {
        signal.throwIfAborted()
        throw new HttpError(501, 'no_task_authority', 'the HTTP board does not advertise support for bound task writes', {
          origin: 'handle', hint: 'Upgrade the board before using a bound claim.',
        })
      }
    }
    const withEvidence = method === 'completeTask' && input.commit !== undefined
    if (withEvidence) {
      signal.throwIfAborted()
      const response = await doFetch(remote, { signal, cache: 'no-store' }).catch(rethrow)
      const found = response.ok ? (await response.json().catch(() => null)) as Discovery | null : null
      signal.throwIfAborted()
      if (found?.workEvidence?.version !== 1) throw noEvidenceCompletion()
    }
    if ((method === 'claimTask' || method === 'claimReadyTask') && input.hold !== undefined &&
        (await fetchDiscovery({ signal, cache: 'no-store' }))?.task_claim_hold !== true) {
      throw new HttpError(501, 'no_claim_hold', 'the HTTP board does not advertise a hard end for claims', { origin: 'handle' })
    }
    const agentOps = isAgentOpsMethod(method)
    if (agentOps) {
      // The mount can change. A registry-only mount can return discovery with 200 on an unknown intent or health GET.
      const intents = isAgentIntentMethod(method)
      const capability = intents ? 'agent_intents' : 'agent_ops'
      if ((await fetchDiscovery({ signal, cache: 'no-store' }))[capability] !== true) {
        throw noAgentOps(intents ? 'intents' : 'registry', {
          origin: 'handle',
          hint: intents
            ? 'Upgrade the board or use one started with vb serve --agent-ops that supports intents.'
            : 'Use a board started with vb serve --agent-ops.',
        })
      }
    }
    start()
    const client = clientOf(caller)
    // A post board() gave an ID derived from a trigger, a task's new thread included: the remote
    // takes it as this deployment's key, and a retry's lookup asks for the same.
    if ((method === 'post' || method === 'posted' || method === 'createTask' || method === 'createTasks' || method === 'createdTasks') && 'self' in caller && typeof input.id === 'string' && DERIVED_ID.test(input.id))
      input = { ...input, id: await ownKey(input.id).catch(rethrow) }
    // Discovery and the write can reach different versions. Never fall back to the legacy path.
    const response = await call(client, method, input, signal, withEvidence ? completeWithEvidencePath : boundPath).catch((error: unknown) => {
      if (withEvidence && error instanceof HttpError && error.status === 404 && error.code === 'not_found') throw noEvidenceCompletion()
      throw error
    })
    if (method === 'attachment') return attachmentOf(String(input.id), response)
    if (method === 'status' || method === 'pause' || method === 'resume') {
      // An older mount can answer an unknown GET with discovery, not a control state.
      const status = BoardStatus.safeParse(await response.json().catch(() => null))
      if (!status.success) throw new HttpError(502, 'remote_error', 'the remote board did not answer with a control status')
      return status.data
    }
    if (method === 'workEvidence') {
      // An older mount can answer an unknown GET with its discovery document.
      const work = (await response.json().catch(() => null)) as Partial<Protocol['workEvidence']['output']> | null
      if (!work || !Array.isArray(work.required) || !Array.isArray(work.evidence) || !Array.isArray(work.overrides)
        || !Array.isArray(work.releases) || !(work.submission === null || (work.submission && typeof work.submission === 'object')))
        throw new HttpError(501, 'no_work_evidence', 'the remote board did not answer with work evidence', {
          origin: 'handle', hint: 'Use a board that supports work evidence.',
        })
      return work
    }
    if (agentOps) {
      const body: unknown = await response.json().catch(() => null)
      const parsed = agentResponses[method].safeParse(body)
      if (!parsed.success) throw new HttpError(502, 'remote_error', `the remote board did not answer ${routes[method].path} with the expected response`)
      return parsed.data
    }
    return response.json()
  }

  const methods: ProtocolMethods = {
    ...(Object.fromEntries(METHODS.map((method) => [method, (caller: Caller, input: Record<string, unknown>, signal: AbortSignal) => remoteCall(method, caller, input, signal)])) as unknown as ProtocolMethods),
    // The board it uses is what a handle here asks about. board() answers a request's itself.
    async discovery() {
      return discovery()
    },
  }

  let running: ReturnType<typeof tailWatchers> | null = null
  /** Whether they won't run, or won't again: on Vercel, or once closed. */
  let stopped = false
  /**
   * On first use, this board's watchers start following the board it uses, in this process, as
   * `vb tail` does. Nothing wakes a board on http(). A deployment's function doesn't outlive its
   * request, so on Vercel none run.
   */
  function start() {
    if (running || stopped || Object.keys(tails).length === 0) return
    if (deployedOnVercel()) {
      stopped = true
      console.error(`[board] watchers on a board that uses ${remote} run only in a process that stays up: on Vercel, none run`)
      return
    }
    running = tailWatchers({
      watchers: tails,
      events: async (query, signal) => (await call(own, 'events', query, signal)).json() as Promise<EventsPage>,
      actorOf: async (id) => (await asProfile(id).me().catch(rethrow)).actor,
      run: (id, event, meta) => bound().run(id, event, meta),
    })
    running.start()
  }

  const backend = {
    ...methods,
    // Who may do what on the board it uses is that board's to say: a board here answers nothing itself.
    routes: [],
    // The log is the board it uses'.
    keeps: false,
    settlesMentions: true,
    async sandbox({ profile, can, token }: SandboxInput): Promise<SandboxReach> {
      const credential = environment ? await environment.sandbox(remote, token) : token === undefined ? withoutToken(remote) : { authorization: `Bearer ${token}` }
      return { url: remote, headers: { ...credential, 'x-board-profile': formatProfileHeader(profile), 'x-board-can': can }, routes: PROTOCOL_ROUTES }
    },
    bind(next: BoardBinding) {
      if (binding) throw new Error('http: this backend already serves a board: create one http() per board()')
      for (const [id, spec] of Object.entries(next.subscriptions)) {
        // Sync runs where the board keeps its log: the board it uses' own config, or Vercel's board.
        if (spec.kind === 'sync') throw new Error(`http: sync doesn't run on a board that uses ${remote}: sync from that board's own config`)
        if (!PROFILE.test(id)) throw new Error(`watch ${id}: ${PROFILE_RULE}`)
        const { filters, all } = compileWatcher(id, spec)
        tails[id] = { filters, all }
      }
      binding = next
    },
    /** Stops its watchers' tails. */
    close: () => {
      stopped = true
      running?.close()
      running = null
    },
  }
  return backend satisfies Backend
}

export type HttpBackend = ReturnType<typeof createHttp>
