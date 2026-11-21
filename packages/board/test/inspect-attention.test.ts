import { afterEach, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import * as store from '../src/inspect/app/store.ts'
import { memory } from '../src/store/memory.ts'
import { board, mount } from './harness.ts'
import { bearer, BOARD_URL, personToken, testAuth } from './tokens.ts'

const owner = 'u_owner'
const commit = 'a'.repeat(40)
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
})

function remote(authority: ReturnType<typeof board>) {
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => authority.fetch(new Request(input, init))
  const as = async (user: string) => board({ backend: http(BOARD_URL, { fetch: bearer(fetch, await personToken(user)) }) })
  return { fetch, as }
}

const responders = { work: [`vercel:user:${owner}`] }
function configured() {
  const backend = local({ memory: true, attentionResponders: responders })
  cleanup.push(() => backend.close())
  return remote(board({ backend, authenticate: oidcTokens(testAuth), url: BOARD_URL }))
}

async function hold(team: ReturnType<typeof board>, question = 'Ship the revised docs?') {
  const { task: { id, revision } } = await team.tasks.create('work', 'revise the docs')
  return team.tasks.ask(id, {
    kind: 'awaiting_approval', question, context: 'The wording has been reviewed.',
    options: [
      { id: 'ship', label: 'Ship it', consequence: 'Publish the revised docs', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Keep the current docs', next: 'fail' },
    ],
    evidence: [{ message: id, revision }], revision, commit, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
}

/** Browser transport only. The page's board.ts handle reads and writes a real local authority. */
async function inspector(local: ReturnType<typeof remote>, user = owner, receive?: (request: Request, response: Response) => void | Promise<void>) {
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  const authorized = bearer(local.fetch, await personToken(user))
  vi.resetModules()
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', { origin: new URL(BOARD_URL).origin })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('requestAnimationFrame', queueMicrotask)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    target.pathname = '/api' + target.pathname
    const request = new Request(target, { ...init, signal: controller.signal })
    const response = await authorized(request)
    await receive?.(request, response)
    return response
  })
  const page = await import('../src/inspect/app/board.ts')
  await page.boot()
  const shown = (id: string) => {
    const state = page.getState()
    return store.attentionFor(state, state.messages[id]! as store.TaskRoot, page.viewerOf(state.me!))
  }
  const open = async () => {
    const close = page.openAttention()
    cleanup.push(close)
    await vi.waitFor(() => expect(page.getState().tasksCounted).toBe(true))
    return close
  }
  return { page, shown, open }
}

it('reads only in the inbox, shows each question as it arrives, and folds a live answer in place', async () => {
  const local = configured()
  const team = await local.as(owner)
  const first = await hold(team)
  const second = await hold(team, 'Publish the examples too?')
  const id = first.task.id
  const blocked = Promise.withResolvers<void>()
  cleanup.push(() => blocked.resolve())
  const reads: string[] = []
  const { page, open, shown } = await inspector(local, owner, async (request) => {
    const match = /\/tasks\/(.+)\/attention$/.exec(new URL(request.url).pathname)
    if (request.method !== 'GET' || !match) return
    reads.push(match[1]!)
    if (match[1] === id) await blocked.promise
  })
  await vi.waitFor(() => expect(page.getState().tasksCounted).toBe(true))
  expect(reads).toEqual([])
  const close = await open()
  expect(store.attentionTasks(page.getState()).map((row) => row.id)).toEqual([id, second.task.id])
  await vi.waitFor(() => expect(shown(second.task.id).attention?.question).toBe('Publish the examples too?'))
  expect(shown(id).attention).toBeNull()
  blocked.resolve()
  await vi.waitFor(() => expect(shown(id)).toMatchObject({ attention: { question: 'Ship the revised docs?', status: 'pending' }, reason: null, disabled: false }))
  await page.answerAttention(id, first.attention.id, 'ship')
  expect((await team.tasks.attention(id)).attention).toMatchObject({ status: 'answered', receipt: { option: 'ship', routedTo: 'ready' } })
  await vi.waitFor(() => {
    expect(store.attentionTasks(page.getState()).map((row) => row.id)).toEqual([second.task.id])
    expect(shown(id)).toMatchObject({ answering: null, attention: { status: 'answered' } })
  })
  expect(reads.sort()).toEqual([id, second.task.id].sort())
  close()
  const third = await hold(team, 'Keep this off-screen until opened?')
  await vi.waitFor(() => expect(store.attentionTasks(page.getState()).map((row) => row.id)).toContain(third.task.id))
  expect(shown(third.task.id).attention).toBeNull()
  expect(reads).not.toContain(third.task.id)
  await open()
  await vi.waitFor(() => expect(shown(third.task.id).attention?.question).toBe('Keep this off-screen until opened?'))
  const fourth = await hold(team, 'Does a live hold show up?')
  await vi.waitFor(() => expect(shown(fourth.task.id).attention?.question).toBe('Does a live hold show up?'))
})

it('shows a non-responder the board’s 403 words without losing the pending question', async () => {
  const local = configured()
  const { task, attention } = await hold(await local.as(owner))
  const { page, open, shown } = await inspector(local, 'u_other')
  await open()
  await vi.waitFor(() => expect(shown(task.id)).toMatchObject({ reason: null, disabled: false }))
  await page.answerAttention(task.id, attention.id, 'ship')
  expect(shown(task.id)).toMatchObject({
    error: 'only a configured responder acting as themselves with read and post access can answer task attention',
    answering: null, attention: { status: 'pending' },
  })
})

it('shows a stale answer’s 409 words and re-reads the hold as stale', async () => {
  const local = configured()
  const { task, attention } = await hold(await local.as(owner))
  const { page, open, shown } = await inspector(local)
  await open()
  await vi.waitFor(() => expect(shown(task.id)).toMatchObject({ reason: null, disabled: false }))
  // Passage of time doesn't put a task event on the feed. The write must come from the board.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(attention.expiresAt) + 1)
  await page.answerAttention(task.id, attention.id, 'ship')
  expect(shown(task.id)).toMatchObject({
    error: 'the attention request or its snapshot is no longer current', answering: null,
    attention: { status: 'stale' }, reason: 'the request is stale',
  })
  expect(store.attentionTasks(page.getState()).map((row) => row.id)).toEqual([task.id])
})

it('shows the board’s 501 words on a stored hold when attention is no longer enabled', async () => {
  const log = memory()
  const enabled = remote(mount({ store: log, auth: testAuth, attentionResponders: responders }))
  const { task } = await hold(await enabled.as(owner))
  const { open, shown } = await inspector(remote(mount({ store: log, auth: testAuth })))
  await open()
  await vi.waitFor(() => expect(shown(task.id)).toMatchObject({
    attention: null, readError: 'this board does not keep task attention requests', reason: store.NO_ATTENTION,
  }))
})
