import { randomUUID } from 'node:crypto'
import { block, type Board } from '@vercel/board'
import { allocateWorkId, parseWorkId } from './ids.ts'
import { createWorkItem, workIdHighWater } from './items.ts'

type Message = Awaited<ReturnType<Board['thread']>>['message']
type Request = { work_repo: string; tag: string; title: string; description: string; submitted_at: string }
type Decision = { request: string; decision: 'approve' | 'deny'; reason: string; work_id: string | null }
// WP-403 stub seam: the caller supplies a local repo grant lookup until the party registry exists.
type MayUse = (actor: string, repo: string) => boolean | Promise<boolean>
// Stub the party route registry as a trusted plain object parameter, keyed by tag.
type Routes = Readonly<Record<string, { repo: string; spawner: string }>>
type Route = Routes[string]

export class IntakeError extends Error {
  readonly code: 'repo_forbidden' | 'not_spawner' | 'invalid_request' | 'already_decided' | 'reason_required' | 'submission_conflict'
  constructor(code: IntakeError['code'], message: string) {
    super(message)
    this.name = 'IntakeError'
    this.code = code
  }
}

const text = { type: 'string' }
const nonempty = { ...text, minLength: 1 }
const object = (properties: Record<string, object>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})

export async function registerIntakeSchemas(board: Board) {
  await board.createSchema({ name: 'intake-request', version: 1, schema: object({
    work_repo: nonempty, tag: nonempty, title: nonempty, description: text, submitted_at: nonempty,
  }) })
  await board.createSchema({ name: 'intake-decision', version: 1, schema: object({
    request: nonempty, decision: { enum: ['approve', 'deny'] }, reason: text,
    work_id: { anyOf: [nonempty, { type: 'null' }] },
  }) })
}

function normalizeTag(tag: string) {
  if (!/^[a-z]{3}$/i.test(tag)) throw new IntakeError('invalid_request', 'Invalid intake tag.')
  return tag.toLowerCase()
}

async function requireRepo(mayUse: MayUse, actor: string, repo: string) {
  if (!await mayUse(actor, repo)) throw new IntakeError('repo_forbidden', 'Submitter may not use this repo.')
}

function routeFor(routes: Routes, tag: string): Route {
  const route = routes[tag]
  if (!route?.repo || !route.spawner) throw new IntakeError('invalid_request', 'No intake route for this tag.')
  return route
}

/** Pass the same id to replay an identical submission. */
export async function submitIntake(board: Board, input: {
  tag: string; repo: string; title: string; description: string; mayUse: MayUse; id?: string
}, routes: Routes) {
  const tag = normalizeTag(input.tag)
  const route = routeFor(routes, tag)
  const id = `intake-request:${input.id ?? randomUUID()}`
  if (input.repo !== route.repo) {
    // A same-author replay with a changed repo still conflicts; never post it.
    if (input.id !== undefined) {
      const prior = await board.posted(id).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'post_not_found') return undefined
        throw error
      })
      const saved = prior && getBlock<Request>(prior, 'intake-request')
      if (saved && saved.work_repo !== input.repo) submissionConflict()
    }
    throw new IntakeError('repo_forbidden', 'Repo does not match the intake route.')
  }
  await requireRepo(input.mayUse, (await board.me()).actor, route.repo)
  if (!input.title.trim() || /[\r\n]/.test(input.title)) {
    throw new IntakeError('invalid_request', 'An intake request needs a single-line title.')
  }
  const request: Request = {
    work_repo: input.repo, tag, title: input.title, description: input.description, submitted_at: new Date().toISOString(),
  }
  let posted: Message
  try {
    posted = await board.post(`intake/${tag}`, {
      text: block('intake-request@1', request), noSync: true, id,
    })
  } catch (error) {
    // A replay targeting a different channel is a different board write.
    if (error instanceof Error && 'code' in error && error.code === 'duplicate_id') submissionConflict()
    throw error
  }
  const saved = requestFor(posted, tag, route)
  if (!saved || saved.title !== request.title || saved.description !== request.description) {
    submissionConflict()
  }
  return posted
}

function submissionConflict(): never {
  throw new IntakeError('submission_conflict', 'This submission id already has a different request.')
}

// The public handle exposes only blocks that the board checked against their schema.
function getBlock<T>(message: Message, name: string): T | undefined {
  return message.deleted ? undefined : message.blocks.find(entry => entry.schema === name && entry.version === 1)?.data as T | undefined
}

// The board can still show raw posts. WP-403 board grants, not this code, must
// keep non-members from posting in intake/<tag>. This code never acts on a
// misrouted post, and approval separately checks the author's repo grant.
function requestFor(message: Message, tag: string, route: Route) {
  if (message.channel !== `intake/${tag}` || message.re !== null) return
  const request = getBlock<Request>(message, 'intake-request')
  if (request?.tag === tag && request.work_repo === route.repo) return request
}

function decisionFor(reply: Message, id: string, tag: string, route: Route) {
  // The board exposes editedAt on the current view. Reject edited replies
  // rather than treating an edit as the first-written decision.
  if (reply.by.actor !== route.spawner || reply.re !== id || reply.editedAt !== null) return
  const data = getBlock<Decision>(reply, 'intake-decision')
  if (data?.request !== id) return
  if (data.decision === 'deny' && data.reason.trim() && data.work_id === null) return data
  if (data.decision === 'approve' && data.work_id && parseWorkId(data.work_id)?.tag === tag) return data
}

const decisionId = (requestId: string) => `intake-decision:${requestId}`

async function firstDecision(board: Board, id: string, tag: string, route: Route) {
  let after = id
  for (;;) {
    const { replies } = await board.thread(id, { after, limit: 100 })
    for (const reply of replies) {
      const data = decisionFor(reply, id, tag, route)
      if (data) return data
    }
    if (replies.length < 100) return
    after = replies.at(-1)!.id
  }
}

async function hasWork(board: Board, decision: Decision, route: Route) {
  const { tasks } = await board.tasks.list({ state: 'all', label: [`work.reservation=${decisionId(decision.request)}`] })
  return tasks.some(({ message }) => !message.deleted && message.task && message.by.actor === route.spawner &&
    message.labels['work.id'] === decision.work_id && message.labels['work.repo'] === route.repo)
}

export async function listIntake(board: Board, tag: string, routes: Routes) {
  tag = normalizeTag(tag)
  const route = routeFor(routes, tag)
  const requests = []
  let before: string | undefined
  do {
    const page = await board.threads({ channel: `intake/${tag}`, ...(before ? { before } : {}) })
    for (const { message } of page.threads) {
      const request = requestFor(message, tag, route)
      if (!request) continue
      const decision = await firstDecision(board, message.id, tag, route)
      const status = decision?.decision === 'approve'
        ? await hasWork(board, decision, route) ? 'approved' : 'pending-work'
        : decision ? 'denied' : 'pending'
      requests.push({ id: message.id, by: message.by, ...request, status, decision: decision ?? null })
    }
    before = page.older ?? undefined
  } while (before)
  return requests
}

function alreadyDecided(): never {
  throw new IntakeError('already_decided', 'This intake request is already decided.')
}

export async function decideIntake(board: Board, input: {
  tag: string; requestId: string; decision: Decision['decision']; reason: string
  tags: readonly string[]; channel: string; mayUse: MayUse
}, routes: Routes): Promise<Decision> {
  const { requestId, decision, mayUse, tags, channel } = input
  const tag = normalizeTag(input.tag)
  const route = routeFor(routes, tag)
  if ((await board.me()).actor !== route.spawner) throw new IntakeError('not_spawner', 'Use the spawner handle.')
  const { message } = await board.thread(requestId, { limit: 1 })
  const request = message.id === requestId && requestFor(message, tag, route)
  if (!request) throw new IntakeError('invalid_request', 'Not an intake request for this route.')
  const reason = input.reason.trim()
  const existing = await firstDecision(board, requestId, tag, route)
  if (existing && (existing.decision !== decision || existing.reason !== reason)) alreadyDecided()

  let work_id = null
  if (decision === 'deny') {
    if (!reason) throw new IntakeError('reason_required', 'Denial needs a reason.')
  } else if (decision === 'approve') {
    await requireRepo(mayUse, message.by.actor, route.repo)
    // The reply reserves this number for this request, not for the whole tag.
    // A collision with a different request fails closed in createWorkItem.
    work_id = existing?.work_id ?? allocateWorkId(tags, tag, await workIdHighWater(board, tag)).id
  } else {
    throw new IntakeError('invalid_request', 'Expected approve or deny.')
  }
  const id = decisionId(requestId)
  const proposed = { request: requestId, decision, reason, work_id }
  // A post id is atomic on the board and scoped to this writer. A competing
  // call gets the stored reply back, and must not act on a different decision.
  const reply = await board.reply(requestId, { id, text: block('intake-decision@1', proposed), noSync: true })
  const saved = decisionFor(reply, requestId, tag, route)
  if (!saved || saved.decision !== decision || saved.reason !== reason || saved.work_id !== work_id) alreadyDecided()
  if (saved.work_id !== null) {
    await createWorkItem(board, {
      id: saved.work_id, reservation: id, channel, tag, tags, title: request.title, kind: 'code', repo: route.repo,
      description: request.description, links: [],
    })
  }
  return saved
}
