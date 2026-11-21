import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import * as store from '../src/inspect/app/store.ts'
import { memory } from '../src/store/memory.ts'
import { board, mount } from './harness.ts'
import { bearer, BOARD_URL, deploymentToken, personToken, testAuth } from './tokens.ts'

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
function configured(enabled = true) {
  const backend = local({ memory: true, ...(enabled ? { attentionResponders: responders } : {}) })
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
async function inspector(local: ReturnType<typeof remote>, user = owner, receive?: (request: Request, response: Response) => Response | void | Promise<Response | void>, options: {
  token?: string; scope?: string; writes?: ReturnType<typeof remote>
} = {}) {
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  const token = options.token ?? await personToken(user)
  const authorized = bearer(local.fetch, token)
  const write = options.writes ? bearer(options.writes.fetch, token) : authorized
  vi.resetModules()
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', { origin: new URL(BOARD_URL).origin, pathname: '/attention', search: '' })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('requestAnimationFrame', queueMicrotask)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    target.pathname = '/api' + target.pathname
    const headers = new Headers(init?.headers)
    if (options.scope) headers.set('x-board-can', options.scope)
    const request = new Request(target, { ...init, headers, signal: controller.signal })
    const response = await (answerWrite(request) ? write : authorized)(request)
    return (await receive?.(request, response)) ?? response
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
  const { Attention, keyAction, selectionAfter } = await import('../src/inspect/app/attention.tsx')
  const { Sidebar } = await import('../src/inspect/app/sidebar.tsx')
  const { route } = await import('../src/inspect/app/nav.tsx')
  const view = (state = page.getState()) => renderToStaticMarkup(createElement(Attention, { state, viewer: page.viewerOf(state.me!), lead: null }))
  const sidebar = () => renderToStaticMarkup(createElement(Sidebar, { state: page.getState(), current: route('/attention'), onCollapse() {} }))
    .match(/<a\b[^>]*href="\/attention"[^>]*>.*?<\/a>/)?.[0]
  return { page, shown, open, view, sidebar, route, keyAction, selectionAfter }
}

const attentionRead = (request: Request) => request.method === 'GET' && new URL(request.url).pathname.endsWith('/attention')
const answerWrite = (request: Request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/answer')
const disabledChoices = (markup: string) => (markup.match(/<button\b[^>]*attention-choice[^>]* disabled=""/g) ?? []).length

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

it('shows a stale answer’s 409 words and disables its snapshot without another read', async () => {
  const local = configured()
  const { task, attention } = await hold(await local.as(owner))
  const reads: string[] = []
  const { page, open, shown, view } = await inspector(local, owner, (request) => {
    if (attentionRead(request)) reads.push(request.url)
  })
  await open()
  await vi.waitFor(() => expect(shown(task.id)).toMatchObject({ reason: null, disabled: false }))
  // Passage of time doesn't put a task event on the feed. The write must come from the board.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(attention.expiresAt) + 1)
  await page.answerAttention(task.id, attention.id, 'ship')
  expect(shown(task.id)).toMatchObject({
    error: 'the attention request or its snapshot is no longer current', answering: null,
    attention: { status: 'pending' }, disabled: true,
  })
  expect(reads).toHaveLength(1)
  expect(view()).toContain('the attention request or its snapshot is no longer current')
  expect(disabledChoices(view())).toBe(2)
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

it('resolves the attention route, counts only held requests, and renders questions as text', async () => {
  const local = configured()
  const team = await local.as(owner)
  await team.tasks.create('work', 'not a hold')
  await hold(team, 'Use <img src=x onerror=alert(1)> and <b>?')
  await hold(team)
  const { open, view, sidebar, route } = await inspector(local)
  expect(route('/attention')).toEqual({ view: 'attention' })
  expect(sidebar()).toContain('aria-current="page"')
  await open()
  await vi.waitFor(() => expect(view()).toContain('Use &lt;img src=x onerror=alert(1)&gt; and &lt;b&gt;?'))
  expect(view()).not.toContain('<img src=x')
  expect(sidebar()).toContain('class="count">2</span>')
})

it('clears selection on removal or replacement and scopes shortcuts to enabled choices on the focused list', async () => {
  const local = configured()
  const { attention } = await hold(await local.as(owner))
  const { keyAction, selectionAfter } = await inspector(local)
  const first = { taskId: '1', requestId: 'a' }
  const second = { taskId: '2', requestId: 'b' }
  expect(selectionAfter(first, [second, first])).toEqual(first)
  expect(selectionAfter(first, [second])).toBeNull()
  expect(selectionAfter(first, [{ ...first, requestId: 'new' }, second])).toBeNull()
  expect(selectionAfter(null, [second])).toBeNull()

  const list = { closest: () => null }
  const event = { target: list, currentTarget: list, key: '2', nativeEvent: { isComposing: false },
    metaKey: false, ctrlKey: false, altKey: false, repeat: false, defaultPrevented: false }
  const ctx = { focused: list, choice: { attention, reason: null, disabled: false } }
  expect(keyAction(event, ctx)).toEqual({ type: 'answer', optionId: 'stop' })
  for (const key of ['j', 'k']) expect(keyAction({ ...event, key }, { ...ctx, choice: null })).toEqual({ type: 'move', by: key === 'j' ? 1 : -1 })
  expect(keyAction({ ...event, key: '3' }, ctx)).toBeNull()
  expect(keyAction({ ...event, repeat: true }, ctx)).toBeNull()
  expect(keyAction(event, { ...ctx, choice: null })).toBeNull()
  expect(keyAction(event, { ...ctx, choice: { ...ctx.choice, disabled: true } })).toBeNull()
  expect(keyAction(event, { ...ctx, choice: { ...ctx.choice, reason: 'read only' } })).toBeNull()
  expect(keyAction(event, { ...ctx, focused: null })).toBeNull()
  for (const tag of ['input', 'textarea', 'select', '[contenteditable]', 'outside']) {
    const target = { closest: () => tag }
    expect(keyAction({ ...event, target }, ctx)).toBeNull()
    if (tag !== 'outside') {
      expect(keyAction({ ...event, target, currentTarget: target }, { ...ctx, focused: target })).toBeNull()
    }
  }
})

it.each(['profile', 'deployment', 'read only'] as const)('does not offer or send an answer as %s', async (identity) => {
  const local = configured()
  const { task, attention } = await hold(await local.as(owner))
  let writes = 0
  const { page, open, view } = await inspector(local, owner, (request) => {
    if (answerWrite(request)) writes++
  }, identity === 'deployment' ? { token: await deploymentToken() } : identity === 'read only' ? { scope: '*=read' } : {})
  if (identity === 'profile') expect(await page.setProfile({ name: 'reviewer' })).toBe(true)
  await open()
  await vi.waitFor(() => expect(view()).toContain('read only: answering needs a person acting as themselves with post access'))
  expect(view()).not.toContain('attention-choice')
  await page.answerAttention(task.id, attention.id, 'ship')
  expect(writes).toBe(0)
})

it('shows why a cached question is read only when discovery does not advertise attention', async () => {
  const local = configured()
  const { task } = await hold(await local.as(owner))
  const { page, open, shown, view } = await inspector(local)
  await open()
  await vi.waitFor(() => expect(shown(task.id).reason).toBeNull())
  const state = page.getState()
  const markup = view({ ...state, discovery: { ...state.discovery!, task_attention: undefined } })
  expect(markup).toContain('read only: this board does not keep task attention requests')
  expect(markup).not.toContain('attention-choice')
})

it.each([404, 501])('shows a late %i write refusal until rendered, without another attention read', async (status) => {
  const local = configured()
  const team = await local.as(owner)
  const { task, attention } = await hold(team)
  const writing = Promise.withResolvers<number>()
  const release = Promise.withResolvers<void>()
  cleanup.push(release.resolve)
  let reads = 0
  // Change which real authority serves writes, while the page still has the original snapshot.
  const { page, open, shown, view, sidebar } = await inspector(local, owner, async (request, response) => {
    if (attentionRead(request)) reads++
    if (answerWrite(request)) {
      writing.resolve(response.status)
      await release.promise
    }
  }, { writes: configured(status === 404) })
  const close = await open()
  await vi.waitFor(() => expect(shown(task.id).disabled).toBe(false))
  const answer = page.answerAttention(task.id, attention.id, 'ship')
  expect(await writing.promise).toBe(status)
  close()
  release.resolve()
  await answer
  await new Promise(setImmediate)
  expect(reads).toBe(1)
  expect(sidebar()).toContain('>refused</span>')
  await open()
  await vi.waitFor(() => expect(reads).toBe(2))
  const rendered = page.getState()
  expect(sidebar()).toContain('>refused</span>')
  expect(view(rendered)).toContain(status === 404 ? `message not found: #${task.id}` : 'this board does not keep task attention requests')
  expect(disabledChoices(view(rendered))).toBe(2)
  page.attentionRendered(rendered)
  expect(sidebar()).not.toContain('>refused</span>')
  expect(disabledChoices(view())).toBe(2)
  const { attention: replacement } = await team.tasks.ask(task.id, {
    kind: attention.kind, question: 'Use a new snapshot?', context: attention.context, options: attention.options,
    evidence: attention.evidence, revision: attention.revision, commit, expiresAt: attention.expiresAt, replaces: attention.id,
  })
  await vi.waitFor(() => expect(shown(task.id)).toMatchObject({ attention: { id: replacement.id }, error: undefined, disabled: false }))
})

it('uses the newer read when navigation responses arrive out of order', async () => {
  const local = configured()
  const { task, attention } = await hold(await local.as(owner))
  let reads = 0
  const first = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanup.push(release.resolve)
  const { page, open, shown } = await inspector(local, owner, async (request) => {
    if (attentionRead(request) && ++reads === 1) {
      first.resolve()
      await release.promise
    }
  })
  await vi.waitFor(() => expect(page.getState().tasksCounted).toBe(true))
  const close = await open()
  await first.promise
  close()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(attention.expiresAt) + 1)
  await open()
  await vi.waitFor(() => expect(shown(task.id).attention?.status).toBe('stale'))
  release.resolve()
  await new Promise(setImmediate)
  expect(shown(task.id).attention?.status).toBe('stale')
})

it('keeps the disabled answering overlay after HTTP success until the real feed arrives', async () => {
  const local = configured()
  const { task, attention } = await hold(await local.as(owner))
  const delivery = Promise.withResolvers<void>()
  cleanup.push(delivery.resolve)
  let pause = false
  const { page, open, shown, view, sidebar } = await inspector(local, owner, async (request, response) => {
    if (answerWrite(request)) expect(response.ok).toBe(true)
    const url = new URL(request.url)
    if (pause && url.pathname.endsWith('/events') && url.searchParams.has('after')) await delivery.promise
  })
  await open()
  await vi.waitFor(() => expect(shown(task.id)).toMatchObject({ reason: null, disabled: false }))
  expect(sidebar()).toContain('class="count">1</span>')
  pause = true
  await page.answerAttention(task.id, attention.id, 'ship')
  expect(view()).toContain('answering Ship it')
  expect(disabledChoices(view())).toBe(2)
  delivery.resolve()
  await vi.waitFor(() => expect(view()).toContain('answered · Ship it'))
  expect(sidebar()).toBeDefined()
  expect(sidebar()).not.toContain('class="count"')
})
