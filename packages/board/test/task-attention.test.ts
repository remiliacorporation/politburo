import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import type { AttentionDraft, AttentionView, BoardEventView, MessageView, TaskClaim } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { a2 } from '../src/server/a2.ts'
import { memory } from '../src/store/memory.ts'
import { board, testClock } from './harness.ts'
import { serve } from './http.ts'
import { bearer, deploymentToken, localUserToken, personToken, testAuth, testLocal } from './tokens.ts'

const COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(64)
const OWNER = 'vercel:user:u_owner'
const RESPONDER = 'vercel:user:u_responder'
const DEPLOYMENT = 'vercel:project:prj_web:production'
const config = { work: [RESPONDER, DEPLOYMENT, 'local:user:julian', 'board:client'], conformance: [RESPONDER] }
const stop: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of stop.splice(0).reverse()) await close()
})

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>

async function setup(enabled = true, useLocal = false) {
  const clock = testClock()
  const attentionResponders = enabled ? { attentionResponders: config } : {}
  const backend = useLocal ? local({ memory: true, ...attentionResponders }) : a2({ store: memory({ clock }), ...attentionResponders })
  if ('close' in backend) stop.push(() => backend.close())
  const team = board({ backend, authenticate: oidcTokens({ ...testAuth, local: testLocal }) })
  const server = await serve(team.fetch)
  stop.push(server.close)
  const url = `${server.origin}/api/board`
  const [ownerToken, responderToken, webToken, localToken] = await Promise.all([
    personToken('u_owner', url), personToken('u_responder', url),
    deploymentToken('web', 'prj_web', 'production', { audience: url }), localUserToken('julian', url),
  ])
  const client = (token: string, headers: Record<string, string> = {}) => board({
    backend: http(url, { fetch: bearer((input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }), token) }),
  })
  const request = (token: string, headers: Record<string, string> = {}): Call => async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    team, url, clock, ownerToken, responderToken, request, client,
    owner: request(ownerToken), responder: request(responderToken), web: request(webToken), localUser: request(localToken),
  }
}

const pathOf = (id: string) => `/tasks/${id}/attention`
const answerPath = (id: string, requestId: string) => `${pathOf(id)}/${requestId}/answer`
const choose = (call: Call, root: MessageView, requestId: string, option = 'proceed', commit = COMMIT) =>
  call('POST', answerPath(root.id, requestId), { option, commit })
const code = (response: Awaited<ReturnType<Call>>) => [response.status, response.body.error?.code]

async function make(call: Call, fields: Record<string, unknown> = {}) {
  const made = await call('POST', '/tasks', { channel: 'work', text: 'Review the release', ...fields })
  expect(made.status).toBe(201)
  return made.body as { task: MessageView; claim?: TaskClaim }
}

async function evidence(call: Call, id: string) {
  const made = await call('POST', '/messages', { re: id, text: 'Checklist is green' })
  expect(made.status).toBe(201)
  return made.body.message as MessageView
}

function draft(root: MessageView, supporting: MessageView, now: Date, changes: Partial<AttentionDraft> = {}): AttentionDraft {
  return {
    kind: 'awaiting_approval', question: 'Release this commit?', context: 'The checklist passed.',
    options: [
      { id: 'proceed', label: 'Proceed', consequence: 'Workers may resume', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Release not approved', next: 'fail' },
    ],
    evidence: [{ message: supporting.id, revision: supporting.revision }],
    expiresAt: new Date(+now + 60_000).toISOString(), revision: root.revision, commit: COMMIT,
    ...changes,
  }
}

async function ask(call: Call, root: MessageView, body: AttentionDraft & { claim?: Pick<TaskClaim, 'epoch' | 'token'>; replaces?: string }) {
  const made = await call('POST', pathOf(root.id), body)
  expect(made.status, JSON.stringify(made.body.error)).toBe(201)
  return made.body as { task: MessageView; attention: AttentionView }
}

const read = async (call: Call, id: string): Promise<MessageView> => (await call('GET', `/messages/${id}`)).body.message
const cursor = async (call: Call): Promise<string> => (await call('GET', '/events')).body.cursor
const changes = async (call: Call, after: string): Promise<BoardEventView[]> => (await call('GET', `/events?after=${encodeURIComponent(after)}`)).body.events

function claimFields(claim: TaskClaim | undefined) {
  if (!claim) throw new Error('expected a claim')
  return { epoch: claim.epoch, token: claim.token }
}

describe('structured attention over authenticated HTTP', () => {
  it('keeps operator parks and structured holds separate', async () => {
    const { owner, responder, clock } = await setup()
    const { task } = await make(owner)
    const supporting = await evidence(owner, task.id)
    const request = draft(task, supporting, clock.now())
    const parkPath = `/tasks/${task.id}/park`
    const unparkPath = `/tasks/${task.id}/unpark`

    expect(code(await owner('POST', parkPath, { reason: 'hold for maintenance' }))).toEqual([200, undefined])
    expect(code(await owner('POST', pathOf(task.id), request))).toEqual([409, 'task_blocked'])
    expect((await owner('GET', pathOf(task.id))).body).toEqual({ attention: null })
    expect(code(await owner('POST', unparkPath, { reason: 'maintenance over' }))).toEqual([200, undefined])

    const { attention } = await ask(owner, task, request)
    expect(code(await owner('POST', parkPath, { reason: 'cannot replace a request' }))).toEqual([409, 'task_blocked'])
    const unpark = await owner('POST', unparkPath, { reason: 'cannot answer a request' })
    expect(code(unpark)).toEqual([200, undefined])
    expect(unpark.body.task.task).toMatchObject({ state: 'blocked', attentionId: attention.id })
    const answered = await choose(responder, task, attention.id)
    expect(code(answered)).toEqual([200, undefined])
    expect(answered.body.task.task.state).toBe('ready')
  })

  it('routes exactly one racing answer, persists its receipt, and refuses a retry without a second event', async () => {
    const { owner, responder, clock } = await setup()
    const { task } = await make(owner)
    expect((await owner('GET', pathOf(task.id))).body).toEqual({ attention: null })
    const supporting = await evidence(owner, task.id)
    const now = clock.now()
    const request = draft(task, supporting, now)
    const opened = await ask(owner, task, request)
    expect(opened.attention).toMatchObject({ ...request, status: 'pending', by: { actor: OWNER } })
    expect(opened.task.task).toMatchObject({ state: 'blocked', attentionId: opened.attention.id, blocked: { reason: request.question } })
    expect(opened.task.task).not.toHaveProperty('attention')
    const before = await cursor(owner)
    const answers = await Promise.all(['proceed', 'stop'].map((option) => choose(responder, task, opened.attention.id, option)))
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409])
    expect(code(answers.find((answer) => answer.status === 409)!)).toEqual([409, 'attention_stale'])
    const winner = answers.findIndex((answer) => answer.status === 200)
    const option = winner === 0 ? 'proceed' : 'stop'
    const state = winner === 0 ? 'ready' : 'failed'
    const landed = answers[winner]!.body
    expect(landed.attention).toMatchObject({ id: opened.attention.id, status: 'answered', receipt: { option, routedTo: state, by: { actor: RESPONDER }, at: expect.any(String) } })
    expect(Date.parse(landed.attention.receipt.at)).toBeGreaterThanOrEqual(+now)
    expect(landed.task).toMatchObject({ labels: { 'board.task': state }, task: { state, blocked: null, claim: null } })
    expect(code(await choose(responder, task, opened.attention.id, option))).toEqual([409, 'attention_stale'])
    expect((await owner('GET', pathOf(task.id))).body).toEqual({ attention: landed.attention })
    const events = await changes(owner, before)
    expect(events.map(({ type, message }) => [type, message?.task?.state])).toEqual([['task.attention_answered', state]])
    expect(events[0]?.payload).toMatchObject({ receipt: landed.attention.receipt })
  })

  it.each(['wrong commit', 'expiry', 'edited root', 'edited evidence', 'deleted evidence'] as const)('rejects %s without routing or recording an answer', async (stale) => {
    if (stale === 'expiry') vi.useFakeTimers({ toFake: ['Date'] })
    const { owner, responder, clock } = await setup()
    const { task } = await make(owner)
    const supporting = await evidence(owner, task.id)
    const opened = await ask(owner, task, draft(task, supporting, clock.now()))
    if (stale === 'expiry') vi.setSystemTime(new Date(opened.attention.expiresAt))
    if (stale === 'edited root' || stale === 'edited evidence') {
      const id = stale === 'edited root' ? task.id : supporting.id
      expect((await owner('POST', `/messages/${id}/edit`, { text: 'New information' })).status).toBe(200)
    }
    if (stale === 'deleted evidence') expect((await owner('POST', `/messages/${supporting.id}/delete`, {})).status).toBe(200)
    const before = await cursor(owner)
    expect(code(await choose(responder, task, opened.attention.id, 'proceed', stale === 'wrong commit' ? OTHER_COMMIT : COMMIT))).toEqual([409, 'attention_stale'])
    const { attention } = (await owner('GET', pathOf(task.id))).body
    expect(attention.status).toBe(stale === 'wrong commit' ? 'pending' : 'stale')
    expect(attention).not.toHaveProperty('receipt')
    expect((await read(owner, task.id)).task?.state).toBe('blocked')
    expect(await changes(owner, before)).toEqual([])
  })

  it('requires the exact-channel role, a verified person without a profile, and effective read and post', async () => {
    const { team, owner, responder, responderToken, localUser, web, request, client, clock } = await setup()
    const { task } = await make(owner)
    const opened = await ask(owner, task, draft(task, await evidence(owner, task.id), clock.now()))
    const id = opened.attention.id
    expect((await responder('GET', pathOf(task.id))).body.attention.status).toBe('pending')
    const hidden = request(responderToken, { 'x-board-can': 'elsewhere=all' })
    expect((await hidden('GET', pathOf(task.id))).status).toBe(404)
    expect((await hidden('POST', pathOf(task.id), draft(task, task, clock.now()))).status).toBe(404)
    expect((await choose(hidden, task, id)).status).toBe(404)
    const denied = {
      'unlisted person': owner, 'listed deployment': web,
      'profile': request(responderToken, { 'x-board-profile': 'bot' }),
      'read-only': request(responderToken, { 'x-board-can': 'work=read' }),
    }
    for (const [who, call] of Object.entries(denied)) expect(code(await choose(call, task, id)), who).toEqual([403, 'forbidden'])
    await expect(team.tasks.answer(task.id, id, { option: 'proceed', commit: COMMIT })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect((await responder('POST', '/messages', { re: task.id, text: 'Approved in a reply' })).status).toBe(201)
    expect((await responder('GET', pathOf(task.id))).body.attention.status).toBe('pending')
    expect(code(await choose(responder, task, id, 'missing-option'))).toEqual([400, 'invalid_request'])
    const { task: child } = await make(owner, { channel: 'work/release' })
    const childRequest = await ask(owner, child, draft(child, await evidence(owner, child.id), clock.now()))
    expect(code(await choose(responder, child, childRequest.attention.id))).toEqual([403, 'forbidden'])
    const narrowed = client(responderToken, { 'x-board-can': 'work=read,post' })
    expect((await narrowed.tasks.answer(task.id, id, { option: 'proceed', commit: COMMIT })).attention.status).toBe('answered')
    // The local issuer's signed-in person is distinct from the board's own in-process caller.
    const { task: another } = await make(owner)
    const anotherRequest = await ask(owner, another, draft(another, await evidence(owner, another.id), clock.now()))
    const localAnswer = await choose(localUser, another, anotherRequest.attention.id)
    expect(localAnswer.status).toBe(200)
    expect(localAnswer.body.attention.receipt.by.actor).toBe('local:user:julian')
  })

  it('uses a live claim to open a hold, then fences that claim and prevents a legacy unblock', async () => {
    const { owner, responder, clock } = await setup()
    const { task, claim } = await make(owner, { claim: true })
    const supporting = await evidence(owner, task.id)
    const body = draft(task, supporting, clock.now())
    expect(code(await owner('POST', pathOf(task.id), body))).toEqual([409, 'task_claimed'])
    const heldBy = claimFields(claim)
    const before = await cursor(owner)
    const opened = await ask(owner, task, { ...body, claim: heldBy })
    expect(opened.task.task).toMatchObject({ state: 'blocked', claim: null })
    expect(JSON.stringify([opened, await changes(owner, before)])).not.toContain(heldBy.token)
    expect(code(await owner('POST', `/tasks/${task.id}/complete`, heldBy))).toEqual([409, 'claim_lost'])
    expect(code(await owner('POST', `/tasks/${task.id}/claim`))).toEqual([409, 'task_blocked'])
    expect((await owner('POST', '/tasks/claim', { channel: 'work' })).body).toEqual({ task: null })
    expect(code(await responder('POST', `/tasks/${task.id}/unblock`))).toEqual([409, 'attention_required'])
    expect((await choose(responder, task, opened.attention.id)).status).toBe(200)
    expect(code(await owner('POST', `/tasks/${task.id}/complete`, heldBy))).toEqual([409, 'claim_lost'])
  })

  it('rejects a pre-pause claim but lets the owner open an attention hold without it', async () => {
    const { owner, responder, clock } = await setup()
    const { task, claim } = await make(owner, { claim: true, priority: 'high' })
    const request = draft(task, await evidence(owner, task.id), clock.now())
    expect((await owner('POST', '/control/pause', { reason: 'Review queued work' })).status).toBe(200)
    expect((await owner('POST', '/control/resume', { reason: 'Review complete' })).status).toBe(200)
    expect(code(await owner('POST', pathOf(task.id), { ...request, claim: claimFields(claim) }))).toEqual([409, 'claim_lost'])
    expect((await owner('GET', pathOf(task.id))).body).toEqual({ attention: null })
    const opened = await ask(owner, task, request)
    expect(opened.task.task).toMatchObject({ state: 'blocked', priority: 'high', attentionId: opened.attention.id })
    const answered = await choose(responder, task, opened.attention.id)
    expect(answered).toMatchObject({ status: 200, body: { task: { task: { state: 'ready', priority: 'high', claim: null } } } })
  })

  it('converts a plain human hold, replaces it by current ID, and leaves canceled requests unanswerable', async () => {
    const { owner, responder, clock } = await setup()
    const { task } = await make(owner)
    const supporting = await evidence(owner, task.id)
    expect((await owner('POST', `/tasks/${task.id}/block`, { kind: 'needs_input', reason: 'Which work?' })).status).toBe(200)
    const first = await ask(owner, task, draft(task, supporting, clock.now()))
    const next = draft(task, supporting, clock.now(), { question: 'Release the replacement?', commit: OTHER_COMMIT })
    expect(code(await owner('POST', pathOf(task.id), { ...next, replaces: '99999' }))).toEqual([409, 'attention_stale'])
    const second = await ask(owner, task, { ...next, replaces: first.attention.id })
    expect(second.attention.id).not.toBe(first.attention.id)
    expect(code(await choose(responder, task, first.attention.id))).toEqual([409, 'attention_stale'])
    expect((await owner('POST', `/tasks/${task.id}/cancel`, { reason: 'No release' })).status).toBe(200)
    expect((await responder('GET', pathOf(task.id))).body.attention).toMatchObject({ id: second.attention.id, status: 'canceled' })
    expect(code(await choose(responder, task, second.attention.id, 'proceed', OTHER_COMMIT))).toEqual([409, 'attention_stale'])
  })

  it.each([
    ['unmet prerequisites', 'proceed', 'waiting'],
    ['completed prerequisites', 'proceed', 'ready'],
    ['a failed answer', 'stop', 'failed'],
  ] as const)('routes with %s and records the destination without readying dependents', async (scenario, option, state) => {
    const { owner, responder, clock } = await setup()
    const { task: need, claim } = await make(owner, { claim: true })
    const { task } = await make(owner, { needs: [need.id] })
    const { task: dependent } = await make(owner, { needs: [task.id] })
    const opened = await ask(owner, task, draft(task, await evidence(owner, task.id), clock.now()))
    if (scenario === 'completed prerequisites') expect((await owner('POST', `/tasks/${need.id}/complete`, claimFields(claim))).status).toBe(200)
    const before = await cursor(owner)
    const landed = await choose(responder, task, opened.attention.id, option)
    expect(landed.status).toBe(200)
    expect(landed.body.attention.receipt.routedTo).toBe(state)
    expect(landed.body.task.task).toMatchObject({ state, claim: null, blocked: null, ...(state === 'failed' ? { reason: 'Release not approved' } : {}) })
    expect((await read(owner, dependent.id)).task?.state).toBe('waiting')
    expect((await changes(owner, before)).map(({ type, message }) => [type, message?.task?.state])).toEqual([['task.attention_answered', state]])
  })

  it('does not enable attention by default or fall back to an ordinary hold', async () => {
    const { owner, responder, clock, client, ownerToken } = await setup(false)
    const { task } = await make(owner)
    const supporting = await evidence(owner, task.id)
    expect(await client(ownerToken).discovery()).not.toHaveProperty('task_attention')
    const before = await cursor(owner)
    expect(code(await owner('GET', pathOf(task.id)))).toEqual([501, 'no_task_attention'])
    expect(code(await owner('POST', pathOf(task.id), draft(task, supporting, clock.now())))).toEqual([501, 'no_task_attention'])
    expect(code(await choose(responder, task, '99999'))).toEqual([501, 'no_task_attention'])
    expect((await read(owner, task.id)).task?.state).toBe('ready')
    expect(await changes(owner, before)).toEqual([])
    expect((await owner('POST', `/tasks/${task.id}/block`, { reason: 'Plain hold' })).status).toBe(200)
    expect((await owner('POST', `/tasks/${task.id}/unblock`)).body.task.task.state).toBe('ready')
  })

  it('runs the optional conformance check against an enabled authority', async () => {
    const { client, ownerToken } = await setup()
    const report = await conformance(client(ownerToken))
    expect(report.checks.find(({ name }) => name.startsWith('opens structured attention'))).toMatchObject({ group: 'tasks', status: 'passed' })
  }, 20_000)

  it('uses the CLI stored claim with ask --file and prints each JSON wrapper over HTTP', async () => {
    const { owner, responder, clock, url, ownerToken, responderToken } = await setup(true, true)
    const home = await mkdtemp(join(tmpdir(), 'board-attention-cli-'))
    stop.push(() => rm(home, { recursive: true, force: true }))
    const exec = promisify(execFile)
    const cli = async (token: string, ...args: string[]) => {
      const { stdout } = await exec(process.execPath, [join(import.meta.dirname, '../src/cli/bin.ts'), 'tasks', ...args, '--json'], {
        cwd: home, env: { HOME: home, XDG_CONFIG_HOME: home, BOARD_URL: url, BOARD_TOKEN: token },
      })
      return JSON.parse(stdout)
    }
    const { task } = await make(owner)
    const supporting = await evidence(owner, task.id)
    const { claim } = await cli(ownerToken, 'claim', task.id)
    expect(claim).toHaveProperty('epoch')
    expect(claim).not.toHaveProperty('token')
    const file = join(home, 'request.json')
    const request = draft(task, supporting, clock.now())
    await writeFile(file, JSON.stringify(request))
    const opened = await cli(ownerToken, 'ask', task.id, '--file', file)
    expect(opened).toMatchObject({ task: { id: task.id, task: { state: 'blocked' } }, attention: { ...request, status: 'pending' } })
    expect(await cli(responderToken, 'attention', task.id)).toEqual({ attention: opened.attention })
    const answered = await cli(responderToken, 'answer', task.id, opened.attention.id, 'proceed', '--commit', COMMIT)
    expect(answered).toMatchObject({ task: { id: task.id, task: { state: 'ready' } }, attention: { status: 'answered', receipt: { option: 'proceed', routedTo: 'ready' } } })
    expect((await responder('GET', pathOf(task.id))).body).toEqual({ attention: answered.attention })
  }, 20_000)
})
