// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { createBoardClient, type ProfileOption } from '../src/client/client.ts'
import { shell } from '../src/inspect/shell.ts'
import { slack } from '../src/sync/slack.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'
import { deploymentToken, localUserToken } from './tokens.ts'
import { fakePlatform } from './sync-fixtures.ts'

let visit = 0
const browser = (window as unknown as import('happy-dom').Window).happyDOM
const closed = () => Response.json({ error: { code: 'closed', message: 'page closed' } }, { status: 403 })
const routePath = (request: Request) => new URL(request.url.slice(BOARD_URL.length), 'http://board.test').pathname
afterAll(() => vi.unstubAllGlobals())
let root: Root | undefined
let disconnect: (() => Promise<void>) | undefined
let local: ReturnType<typeof localBoard> | undefined
const releaseGates: (() => void)[] = []
const otherBoards: ReturnType<typeof localBoard>[] = []

afterEach(async () => {
  root?.unmount()
  root = undefined
  for (const release of releaseGates.splice(0)) release()
  await disconnect?.()
  for (const board of otherBoards.splice(0)) await board.close()
  vi.useRealTimers()
  disconnect = undefined
  await local?.close()
  local = undefined
  localStorage.clear()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

// Only the browser-to-proxy transport is substituted. The inspector's handle, live feed,
// route components, and the local board processing their requests are real.
async function workbench(options: Parameters<typeof localBoard>[0] = {}) {
  const api = local = localBoard(options)
  const token = await personToken('u_reader', BOARD_URL)
  const as = (profile: ProfileOption = null, can?: string) => createBoardClient({
    url: BOARD_URL, token, profile,
    fetch: (input, init) => {
      const request = new Request(input, init)
      if (can) request.headers.set('x-board-can', can)
      return api.fetch(request)
    },
  })
  const page = new AbortController()
  const streamClosed = Promise.withResolvers<void>()
  let streaming = false
  disconnect = async () => {
    page.abort()
    if (streaming) await streamClosed.promise
  }
  return {
    api, as, client: as(),
    async open(path = '/', options: {
      profile?: string; named?: boolean; can?: string; width?: number; token?: string
      holdSchedules?: (profile: string | null) => Promise<void> | undefined
      proxy?: (request: Request, forward: (request: Request) => Promise<Response>) => Promise<Response>
      transport?: (request: Request, send: () => Promise<Response>) => Promise<Response>
    } = {}) {
      browser.settings.enableImageFileLoading = false
      browser.setViewport({ width: options.width ?? 1280, height: 900 })
      browser.setURL(`http://inspector-${++visit}.test${path}`)
      const profile = options.profile ? { name: options.profile } : null
      const html = new DOMParser().parseFromString(shell({ token: 'inspector-test', base: '', profile, named: options.named ?? false }), 'text/html')
      document.head.replaceChildren(...html.head.querySelectorAll('meta, style'))
      document.body.innerHTML = '<div id="root"></div>'
      const proxy = `${location.origin}/board`
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url !== proxy && !request.url.startsWith(`${proxy}/`)) return closed()
        const isStream = new URL(request.url).pathname === '/board/events'
        if (page.signal.aborted) {
          // A refusal stops the handle from reconnecting after this tab closes.
          if (isStream) streamClosed.resolve()
          return closed()
        }
        if (isStream) streaming = true
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${options.token ?? token}`)
        if (options.can) headers.set('x-board-can', options.can)
        const outbound = new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: AbortSignal.any([page.signal, request.signal]),
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        })
        const forward = (outbound: Request) => options.proxy ? options.proxy(outbound, api.fetch) : api.fetch(outbound)
        const response = options.transport ? options.transport(outbound, () => forward(outbound)) : forward(outbound)
        if (options.holdSchedules && request.method === 'GET' && new URL(request.url).pathname === '/board/schedules') {
          const result = await response
          await options.holdSchedules(headers.get('x-board-profile'))
          return result
        }
        return response
      })
      vi.resetModules()
      const { App } = await import('../src/inspect/app/App.tsx')
      const mounted = root = createRoot(document.getElementById('root')!)
      flushSync(() => mounted.render(<App />))
    },
  }
}

function link(text: string, inElement: ParentNode = document) {
  const el = [...inElement.querySelectorAll('a')].find((a) => a.textContent?.trim() === text)
  expect(el, `link: ${text}`).toBeDefined()
  return el!
}

function lane(title: string) {
  const box = [...document.querySelectorAll('main section')].find((section) => section.querySelector('h2')?.textContent === title)
  expect(box, `lane: ${title}`).toBeDefined()
  return box!
}

const mainText = () => document.querySelector('main')?.textContent

it('shows a handoff lease relatively with its local deadline on hover', async () => {
  const { client, as, open } = await workbench()
  const { task } = await client.tasks.create('work', { text: 'Review the lease' })
  const { until } = await as('worker').tasks.claim(task.id, { lease: 750 })
  vi.setSystemTime(Date.parse(until) - 750_000)
  await open(`/handoffs?thread=${task.id}`)
  await vi.waitFor(() => {
    const row = link('Review the lease', lane('In progress')).closest('li')!
    for (const scope of [row, threadPane()]) {
      const deadline = scope?.querySelector(`time[datetime="${until}"]`)
      expect(deadline?.textContent).toBe('12m left')
      expect(deadline?.getAttribute('title')).toBe(new Date(until).toLocaleString())
    }
  })
})

it('shows a scheduled reply time relatively with its local timestamp on hover', async () => {
  const { client, open } = await workbench()
  const { id } = await client.post('work', 'Scheduled discussion')
  const { next } = await client.schedule({ re: id }, { text: 'Check the thread later', in: '2h' })
  expect(next).not.toBeNull()
  vi.setSystemTime(Date.parse(next!) - 7_200_000)
  await open(`/c/work?thread=${id}`)
  await vi.waitFor(() => {
    const time = threadPane()?.querySelector(`.thread-facts time[datetime="${next}"]`)
    expect(time?.textContent).toBe('in 2h')
    expect(time?.getAttribute('title')).toBe(new Date(next!).toLocaleString())
  })
})

it('shortens head and commit labels with the full hashes on hover', async () => {
  const { client, open } = await workbench()
  const head = 'abcdef0123456789abcd'.repeat(2)
  const commit = '01234567'.repeat(8)
  await client.post('work', { text: 'Review the head', labels: { head, commit, other: head } })
  await open('/c/work')
  await vi.waitFor(() => {
    expect(mainText()).toContain('head=abcdef0')
    expect(mainText()).toContain('commit=0123456')
    expect(mainText()).toContain(`other=${head}`)
    expect(document.querySelector(`main [title="${head}"]`)?.textContent).toBe('abcdef0')
    expect(document.querySelector(`main [title="${commit}"]`)?.textContent).toBe('0123456')
  })
})

it('shows a grouped message time relatively with its local timestamp on hover', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'First update')
  const grouped = await client.post('work', 'Second update')
  vi.setSystemTime(Date.parse(grouped.createdAt) + 75_000)
  await open('/c/work')
  const row = await vi.waitFor(() => {
    const message = [...document.querySelectorAll('main .message')].find((el) => el.textContent?.includes('Second update'))
    expect(message).toBeDefined()
    return message!
  })
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await vi.waitFor(() => {
    const time = row.querySelector('.gutter time')
    expect(time?.textContent).toBe('1m')
    expect(time?.getAttribute('datetime')).toBe(grouped.createdAt)
    expect(time?.getAttribute('title')).toBe(new Date(grouped.createdAt).toLocaleString())
  })
})

it('shows an older day divider relatively with the local timestamp on hover', async () => {
  const { client, open } = await workbench()
  const { createdAt } = await client.post('work', 'Earlier update')
  const now = new Date(createdAt)
  now.setDate(now.getDate() + 3)
  vi.setSystemTime(now)
  await open('/c/work', { token: await personToken('u_reader', BOARD_URL) })
  await vi.waitFor(() => {
    const divider = document.querySelector('main .divider')
    expect(divider?.textContent).toBe('3d ago')
    expect(divider?.getAttribute('title')).toBe(new Date(createdAt).toLocaleString())
  })
})

it('shows loading before the empty Needs action sentence on an empty board', async () => {
  const { open } = await workbench()
  const listed = Promise.withResolvers<void>()
  releaseGates.push(() => listed.resolve())
  await open('/', { transport: async (request, send) => {
    if (routePath(request) === '/tasks') await listed.promise
    return send()
  } })
  await vi.waitFor(() => {
    expect(document.querySelector('main h1')?.textContent).toBe('Needs action')
    expect(mainText()).toContain('loading…')
    expect(mainText()).not.toContain('nothing needs anyone')
  })
  listed.resolve()
  await vi.waitFor(() => expect(mainText()).toContain('nothing needs anyone'))
  link('Handoffs').click()
  await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe('HANDOFFS'))
  expect(location.pathname).toBe('/handoffs')
})

it('renders the three Needs action groups with ordered thread links', async () => {
  const { client, as, open } = await workbench({ attentionResponders: responders })
  const { id: decisionId } = await hold(client, 'Approve wording', 'Ship it?')
  const { task: lapsed } = await client.tasks.create('work', { text: 'Overdue urgent', priority: 'urgent' })
  const lease = await client.tasks.claim(lapsed.id, { lease: 30 })
  const worker = as('worker')
  const { task: stalled } = await client.tasks.create('work', { text: 'Overdue assigned', for: (await worker.me()).actor })
  const stalledLease = await worker.tasks.claim(stalled.id, { lease: 30 })
  const { task: normal } = await client.tasks.create('work', { text: 'Normal work' })
  const { task: high } = await client.tasks.create('work', { text: 'High work', priority: 'high' })
  vi.setSystemTime(Math.max(Date.parse(lease.until), Date.parse(stalledLease.until)) + 12 * 60_000)
  await open()
  await vi.waitFor(() => {
    expect([...document.querySelectorAll('main section h2')].map((heading) => heading.textContent)).toEqual([
      'Open decisions', 'Stalled or overdue claims', 'Ready work',
    ])
    const linksIn = (title: string) => [...lane(title).querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(linksIn('Open decisions')).toEqual([['Approve wording', `/?thread=${decisionId}`]])
    expect(linksIn('Stalled or overdue claims')).toEqual([['Overdue assigned', `/?thread=${stalled.id}`]])
    expect(linksIn('Ready work')).toEqual([['Overdue urgent', `/?thread=${lapsed.id}`], ['High work', `/?thread=${high.id}`], ['Normal work', `/?thread=${normal.id}`]])
    expect(link('Overdue urgent').closest('li')?.textContent).toContain('lease ended 12m ago')
  })
})

it.each(['list omission', 'thread 404'] as const)('removes a revoked Needs action row after a %s', async (read) => {
  const { api, open } = await workbench({ attentionResponders: responders })
  const target = { kind: 'project' as const, project: 'prj_reader' }
  const token = await deploymentToken('dpl_reader', target.project, 'production')
  await api.revokeGrant('g2')
  const { grant } = await api.createGrant({ principals: [target], can: { work: 'all' } })
  await api.createGrant({ principals: [target], can: { keep: 'all' } })
  const viewer = createBoardClient({ url: BOARD_URL, token, profile: null, fetch: (input, init) => api.fetch(new Request(input, init)) })
  // A decision is shown even without label access, so refreshing /me alone cannot hide it.
  const id = read === 'list omission' ? (await hold(viewer, 'Private queue', 'Continue?')).id
    : (await viewer.tasks.create('work', { text: 'Private queue' })).task.id
  await viewer.tasks.create('keep', { text: 'Public queue' })
  await open('/', { token })
  const row = await vi.waitFor(() => link('Private queue', lane(read === 'list omission' ? 'Open decisions' : 'Ready work')))
  if (read === 'thread 404') {
    row.click()
    await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Private queue'))
    document.querySelector<HTMLButtonElement>('button[aria-label="Close thread"]')!.click()
    await vi.waitFor(() => expect(threadPane()).toBeNull())
  }
  await api.revokeGrant(grant.id)
  await vi.waitFor(() => expect(viewer.thread(id)).rejects.toMatchObject({ status: 404 }))
  if (read === 'list omission') {
    link('Handoffs').click()
    await vi.waitFor(() => expect(location.pathname).toBe('/handoffs'))
    link('Needs action').click()
  } else {
    row.focus()
    row.click()
  }
  await vi.waitFor(() => {
    expect(lane('Ready work').textContent).toContain('Public queue')
    expect(mainText()).not.toContain('Private queue')
    if (read === 'thread 404') {
      expect(threadPane()).not.toBeNull()
      expect(threadPane()?.textContent).not.toContain('Private queue')
    }
  })
})

const openTasksRead = (request: Request) => routePath(request) === '/tasks' && new URL(request.url).searchParams.get('state') === 'open'

async function grantedWorkbench() {
  const bench = await workbench({ attentionResponders: responders })
  const target = { kind: 'project' as const, project: 'prj_reader' }
  const token = await deploymentToken('dpl_reader', target.project, 'production')
  const { api } = bench
  await api.revokeGrant('g2')
  await api.createGrant({ principals: [target], can: { keep: 'all' } })
  const viewer = createBoardClient({ url: BOARD_URL, token, profile: null, fetch: (input, init) => api.fetch(new Request(input, init)) })
  return { ...bench, token, target, viewer }
}

it('evicts a focused decision when its delayed attention read is refused', async () => {
  const { api, open, target, token, viewer } = await grantedWorkbench()
  const { grant } = await api.createGrant({ principals: [target], can: { work: 'all' } })
  const task = await hold(viewer, 'Private decision', 'Continue?')
  await viewer.tasks.create('keep', { text: 'Neighbor' })
  const requested = gate()
  const release = gate()
  await open('/', { token, transport: async (request, send) => {
    if (attentionRead(request)) {
      requested.resolve()
      await release.promise
    }
    return send()
  } })
  const row = await vi.waitFor(() => link('Private decision', lane('Open decisions')))
  row.focus()
  await requested.promise
  await api.revokeGrant(grant.id)
  await vi.waitFor(() => expect(viewer.tasks.attention(task.id)).rejects.toMatchObject({ status: 404 }))
  release.resolve()
  await vi.waitFor(() => {
    expect(mainText()).not.toContain('Private decision')
    expect(mainText()).toContain(`message not found: #${task.id}`)
    expect(document.activeElement).toBe(link('Neighbor', lane('Ready work')))
  })
})

it('re-reads an already open thread when revalidation removes its task', async () => {
  const { api, open, target, token, viewer } = await grantedWorkbench()
  const { grant } = await api.createGrant({ principals: [target], can: { work: 'all' } })
  const { task } = await viewer.tasks.create('work', { text: 'Private open thread' })
  await viewer.tasks.create('keep', { text: 'Still readable' })
  let revalidating = false
  const release = gate()
  await open('/', { token, transport: async (request, send) => {
    const response = await send()
    if (revalidating && routePath(request) === `/messages/${task.id}`) await release.promise
    return response
  } })
  const row = await vi.waitFor(() => link('Private open thread', lane('Ready work')))
  row.click()
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Private open thread'))
  await api.revokeGrant(grant.id)
  await vi.waitFor(() => expect(viewer.thread(task.id)).rejects.toMatchObject({ status: 404 }))
  revalidating = true
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => {
    expect(lane('Ready work').textContent).toContain('Still readable')
    expect(mainText()).not.toContain('Private open thread')
    expect(threadPane()?.textContent).not.toContain('Private open thread')
    expect(threadPane()?.textContent).toContain('loading…')
  })
  release.resolve()
  await vi.waitFor(() => {
    expect(threadPane()?.textContent).not.toContain('Private open thread')
    expect(threadPane()?.textContent).toContain(`message not found: #${task.id}`)
    expect(location.search).toBe(`?thread=${task.id}`)
  })
})

it('does not render a deleted task from the first list snapshot', async () => {
  const { client, open } = await workbench()
  const { task } = await client.tasks.create('work', { text: 'Deleted during first read' })
  await client.tasks.create('work', { text: 'Survives first read' })
  const sampled = gate()
  const release = gate()
  const consumed = gate()
  let deletionDelivered = false
  await open('/', { transport: async (request, send) => {
    if (openTasksRead(request)) {
      const response = await send()
      sampled.resolve()
      await release.promise
      return response
    }
    if (routePath(request) !== '/events') return send()
    if (deletionDelivered) consumed.resolve()
    const response = await send()
    if (response.ok) {
      const { events } = await response.clone().json() as { events: { type: string; message?: { id: string } }[] }
      deletionDelivered ||= events.some((event) => event.type === 'message.deleted' && event.message?.id === task.id)
    }
    return response
  } })
  await sampled.promise
  await client.delete(task.id)
  await consumed.promise
  release.resolve()
  await vi.waitFor(() => {
    expect(lane('Ready work').textContent).toContain('Survives first read')
    expect(mainText()).not.toContain('Deleted during first read')
  })
})

it('renders claim-next order as soon as a lease lapses, including assignment and age ties', async () => {
  const { client, as, open } = await workbench()
  const worker = as('worker')
  const { actor } = await worker.me()
  const { task: urgent } = await client.tasks.create('work', { text: 'Lapsed urgent', priority: 'urgent' })
  const lease = await client.tasks.claim(urgent.id, { lease: 30 })
  const { task: first } = await client.tasks.create('work', { text: 'Older normal' })
  const { task: second } = await client.tasks.create('work', { text: 'Newer normal' })
  const { task: assigned } = await client.tasks.create('work', { text: 'Assigned normal', for: actor })
  const expiry = Date.parse(lease.until)
  const ready = () => [...lane('Ready work').querySelectorAll('a')].map((row) => row.getAttribute('href'))
  const before = [assigned.id, first.id, second.id].map((id) => `/?thread=${id}`)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(expiry - 10_000)
  await open('/', { profile: 'worker' })
  await vi.waitFor(() => expect(ready()).toEqual(before))
  await act(async () => vi.advanceTimersByTimeAsync(expiry - Date.now() - 1))
  expect(ready()).toEqual(before)
  await act(async () => vi.advanceTimersByTimeAsync(1_001))
  const rendered = ready()
  const taken: string[] = []
  for (let next = await worker.tasks.claim({ channel: 'work' }); next; next = await worker.tasks.claim({ channel: 'work' })) {
    taken.push(`/?thread=${next.task.id}`)
  }
  expect(taken).toEqual([`/?thread=${urgent.id}`, ...before])
  expect(rendered).toEqual(taken)
})

it('revalidates on window focus and does not re-admit a revoked row from a delayed frame', async () => {
  const { api, open, target, token, viewer } = await grantedWorkbench()
  const { grant } = await api.createGrant({ principals: [target], can: { work: 'all' } })
  const task = await hold(viewer, 'Private work', 'Proceed?')
  await viewer.tasks.create('keep', { text: 'Other work' })
  const queued = Promise.withResolvers<void>()
  let delivered = false
  await open('/', { token, transport: async (request, send) => {
    if (routePath(request) !== '/events') return send()
    if (delivered) queued.resolve() // The next poll starts after the previous events were queued for paint.
    const response = await send()
    if (response.ok) {
      const page = await response.clone().json() as { events: { message?: { id: string; text: string } }[] }
      delivered ||= page.events.some(({ message }) => message?.id === task.id && message.text === 'Private work, edited')
    }
    return response
  } })
  const row = await vi.waitFor(() => link('Private work', lane('Open decisions')))
  row.focus()
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) })
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  try {
    await viewer.edit(task.id, 'Private work, edited')
    await queued.promise
    expect(frames.length).toBeGreaterThan(0)
    await api.revokeGrant(grant.id)
    await vi.waitFor(() => expect(viewer.thread(task.id)).rejects.toMatchObject({ status: 404 }))
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(mainText()).not.toContain('Private work')
      expect(document.activeElement).toBe(link('Other work', lane('Ready work')))
    })
    frame.mockRestore()
    await act(async () => { for (const run of frames) run(performance.now()) })
    expect(mainText()).not.toContain('Private work')
  } finally {
    frame.mockRestore()
  }
})

it('revalidates Needs action when the live feed reconnects after an outage', async () => {
  const { api, open, target, token, viewer } = await grantedWorkbench()
  const { grant } = await api.createGrant({ principals: [target], can: { work: 'all' } })
  const { task } = await viewer.tasks.create('work', { text: 'Private until reconnect' })
  await viewer.tasks.create('keep', { text: 'Still visible' })
  const fail = Promise.withResolvers<void>()
  releaseGates.push(() => fail.resolve())
  let first = true
  await open('/', { token, transport: async (request, send) => {
    if (!isFeed(request) || !first) return send()
    first = false
    await fail.promise
    return Response.json({ error: { code: 'unavailable', message: 'Feed unavailable' } }, { status: 503 })
  } })
  await vi.waitFor(() => link('Private until reconnect', lane('Ready work')))
  await api.revokeGrant(grant.id)
  await vi.waitFor(() => expect(viewer.thread(task.id)).rejects.toMatchObject({ status: 404 }))
  fail.resolve()
  await vi.waitFor(() => {
    expect(lane('Ready work').textContent).toContain('Still visible')
    expect(mainText()).not.toContain('Private until reconnect')
  })
})

it('discards an older list snapshot when a later revalidation is requested', async () => {
  const { api, open, target, token, viewer } = await grantedWorkbench()
  const { grant } = await api.createGrant({ principals: [target], can: { work: 'all' } })
  const { task } = await viewer.tasks.create('work', { text: 'Outdated snapshot' })
  await viewer.tasks.create('keep', { text: 'Fresh snapshot' })
  const sampled = Promise.withResolvers<void>()
  const first = Promise.withResolvers<void>()
  const resampled = Promise.withResolvers<void>()
  const next = Promise.withResolvers<void>()
  releaseGates.push(() => first.resolve(), () => next.resolve())
  let initial = true
  await open('/', { token, transport: async (request, send) => {
    if (!openTasksRead(request)) return send()
    const before = initial
    initial = false
    const response = await send()
    if (before) {
      sampled.resolve()
      await first.promise
    } else {
      resampled.resolve()
      await next.promise
    }
    return response
  } })
  await sampled.promise
  await api.revokeGrant(grant.id)
  await vi.waitFor(() => expect(viewer.thread(task.id)).rejects.toMatchObject({ status: 404 }))
  window.dispatchEvent(new Event('focus'))
  await act(async () => { first.resolve(); await resampled.promise })
  expect(mainText()).toContain('loading…')
  expect(mainText()).not.toContain('Outdated snapshot')
  next.resolve()
  await vi.waitFor(() => {
    expect(lane('Ready work').textContent).toContain('Fresh snapshot')
    expect(mainText()).not.toContain('Outdated snapshot')
  })
})

it('refreshes label access with the accepted read, matching claim-next without hiding readable decisions', async () => {
  const { api, open, target, token, viewer } = await grantedWorkbench()
  await api.createGrant({ principals: [target], can: { work: ['read', 'post'] } })
  const { grant } = await api.createGrant({ principals: [target], can: { work: ['label'] } })
  const { id } = await hold(viewer, 'Readable decision', 'Continue?')
  await viewer.tasks.create('work', { text: 'Needs label' })
  await viewer.tasks.create('keep', { text: 'Still claimable' })
  const list = Promise.withResolvers<void>()
  const me = Promise.withResolvers<void>()
  releaseGates.push(() => list.resolve())
  let revalidating = false
  await open('/', { token, transport: async (request, send) => {
    const response = await send()
    if (revalidating && routePath(request) === '/me') me.resolve()
    if (revalidating && openTasksRead(request)) await list.promise
    return response
  } })
  const row = await vi.waitFor(() => link('Needs label', lane('Ready work')))
  row.focus()
  await api.revokeGrant(grant.id)
  await vi.waitFor(() => expect(viewer.tasks.claim({ channel: 'work' })).rejects.toMatchObject({ status: 403 }))
  expect((await viewer.thread(id)).message.text).toBe('Readable decision')
  revalidating = true
  document.dispatchEvent(new Event('visibilitychange'))
  await act(async () => { await me.promise })
  expect(link('Needs label', lane('Ready work'))).toBe(row)
  list.resolve()
  await vi.waitFor(() => {
    expect(lane('Ready work').textContent).toContain('Still claimable')
    expect(mainText()).not.toContain('Needs label')
    expect(lane('Open decisions').textContent).toContain('Readable decision')
  })
})

it('shows tasks created after the first list snapshot only once a follow-up read accepts them', async () => {
  const { client, open } = await workbench()
  await client.tasks.create('work', { text: 'In first snapshot' })
  const sampled = Promise.withResolvers<void>()
  const first = Promise.withResolvers<void>()
  const next = Promise.withResolvers<void>()
  releaseGates.push(() => first.resolve(), () => next.resolve())
  let initial = true
  await open('/', { transport: async (request, send) => {
    if (!openTasksRead(request)) return send()
    if (!initial) {
      const response = await send()
      await next.promise
      return response
    }
    initial = false
    const response = await send()
    sampled.resolve()
    await first.promise
    return response
  } })
  await sampled.promise
  await client.tasks.create('work', { text: 'Created during first read' })
  first.resolve()
  await vi.waitFor(() => expect(lane('Ready work').textContent).toContain('In first snapshot'))
  expect(mainText()).not.toContain('Created during first read')
  next.resolve()
  await vi.waitFor(() => expect(lane('Ready work').textContent).toContain('Created during first read'))
  await client.tasks.create('work', { text: 'Created after first read' })
  await vi.waitFor(() => expect(lane('Ready work').textContent).toContain('Created after first read'))
})

it('removes a focused deleted row, focuses its neighbor and holds the remaining order until blur', async () => {
  const { client, as, open } = await workbench()
  await client.tasks.create('work', { text: 'Previous' })
  const { task: removed } = await client.tasks.create('work', { text: 'Reading' })
  await client.tasks.create('work', { text: 'Next' })
  const { task: promoted } = await client.tasks.create('work', { text: 'Promoted' })
  await open()
  const names = () => [...lane('Ready work').querySelectorAll('a')].map((a) => a.textContent)
  const reading = await vi.waitFor(() => link('Reading', lane('Ready work')))
  reading.focus()
  await as('worker').tasks.priority(promoted.id, 'urgent')
  await vi.waitFor(() => expect(link('Promoted').closest('li')?.textContent).toContain('urgent'))
  expect(names()).toEqual(['Previous', 'Reading', 'Next', 'Promoted'])
  expect(document.activeElement).toBe(reading)
  await as().delete(removed.id)
  await vi.waitFor(() => {
    expect(names()).toEqual(['Previous', 'Next', 'Promoted'])
    expect(document.activeElement).toBe(link('Next', lane('Ready work')))
  })
  link('Next', lane('Ready work')).blur()
  await vi.waitFor(() => expect(names()).toEqual(['Promoted', 'Previous', 'Next']))
})

it('shows attention refusals alongside rows and clears membership on a refused task list', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  await hold(client, 'A decision', 'Continue?')
  await client.tasks.create('work', { text: 'Still ready' })
  let refuseTasks = false
  const refuse = (message: string) => Response.json({ error: { code: 'unavailable', message } }, { status: 503 })
  await open('/', { transport: async (request, forward) => {
    if (attentionRead(request)) return refuse('Attention read unavailable')
    if (refuseTasks && routePath(request) === '/tasks' && new URL(request.url).searchParams.get('state') === 'open') return refuse('Task list unavailable')
    return forward()
  } })
  await vi.waitFor(() => {
    expect(mainText()).toContain('Attention read unavailable')
    expect(link('A decision', lane('Open decisions'))).toBeDefined()
    expect(link('Still ready', lane('Ready work'))).toBeDefined()
  })
  link('Handoffs').click()
  await vi.waitFor(() => expect(location.pathname).toBe('/handoffs'))
  refuseTasks = true
  link('Needs action').click()
  await vi.waitFor(() => {
    expect(mainText()).toContain('Task list unavailable')
    expect(mainText()).not.toContain('A decision')
    expect(mainText()).not.toContain('Still ready')
  })
})

it('shows normal priority and lets the reader set and remove the URL priority filter', async () => {
  const { client, open } = await workbench()
  await client.tasks.create('work', { text: 'Check copy' })
  await client.tasks.create('work', { text: 'Fix release', priority: 'urgent' })
  await open('/tasks?state=ready&channel=work')
  const rows = () => [...document.querySelectorAll('main [role="link"]')].map((row) => row.textContent)
  await vi.waitFor(() => expect(rows()).toEqual([expect.stringMatching(/urgent.*Fix release/), expect.stringMatching(/normal.*Check copy/)]), { timeout: 5000 })

  document.querySelector<HTMLButtonElement>('button[aria-label="filter tasks"]')!.click()
  const urgent = await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="priority"] button')].find((el) => el.textContent === 'urgent')
    expect(button).toBeDefined()
    return button!
  }, { timeout: 5000 })
  urgent.click()
  await vi.waitFor(() => expect(rows()).toEqual([expect.stringContaining('Fix release')]), { timeout: 5000 })
  expect(Object.fromEntries(new URLSearchParams(location.search))).toEqual({ state: 'ready', channel: 'work', priority: 'urgent' })

  document.querySelector<HTMLButtonElement>('button[title="remove priority urgent"]')!.click()
  await vi.waitFor(() => expect(rows()).toHaveLength(2), { timeout: 5000 })
  expect(Object.fromEntries(new URLSearchParams(location.search))).toEqual({ state: 'ready', channel: 'work' })
}, 30_000)

const taskRows = () => [...document.querySelectorAll<HTMLElement>('main [data-task-row]')]
const taskRowIds = () => taskRows().map((row) => row.dataset.taskRow)
const taskRead = { timeout: 5000 }

// Observe a real event leaving the proxy before releasing a held animation frame.
function seeTaskEvent(type: string, seen: () => void) {
  return async (request: Request, forward: (request: Request) => Promise<Response>) => {
    const response = await forward(request)
    if (routePath(request) === '/events' && response.ok) {
      const page = await response.clone().json() as { events: { type: string }[] }
      if (page.events.some((event) => event.type === type)) seen()
    }
    return response
  }
}

it('orders rendered Ready rows by default claim-next eligibility, priority, assignment and age', async () => {
  const { api, as, client, open } = await workbench()
  const worker = as('worker')
  const me = await worker.me()
  const make = async (text: string, priority: 'urgent' | 'high', assigned?: string) =>
    (await worker.tasks.create('work', { text, priority, ...(assigned ? { for: assigned } : {}) })).task
  const parked = await make('Parked', 'urgent')
  await client.tasks.park(parked.id, 'hold for operator')
  const other = await make('Other profile', 'urgent', (await as('reviewer').me()).actor)
  const teammate = createBoardClient({ url: BOARD_URL, token: await personToken('u_teammate', BOARD_URL), fetch: (input, init) => api.fetch(new Request(input, init)) })
  const foreign = (await teammate.tasks.create('work', { text: 'Other owner', priority: 'urgent' })).task
  const first = await make('First', 'high')
  const second = await make('Second', 'high')
  const assigned = await make('For this profile', 'high', me.actor)
  const urgent = await make('Urgent unassigned', 'urgent')
  const lapsed = await make('Urgent, lease ended', 'urgent')
  const lease = await worker.tasks.claim(lapsed.id, { lease: 30 })
  const held = await make('Held, lease running', 'urgent')
  await worker.tasks.claim(held.id, { lease: 600 })
  // The local board has no scheduler: the expired lease still wears `claimed` in the open list.
  vi.setSystemTime(Date.parse(lease.until) + 1)
  expect((await worker.tasks.list({ channel: 'work', state: 'open' })).tasks.find(({ message }) => message.id === lapsed.id)?.message.task?.state).toBe('claimed')

  await open('/tasks?state=ready&channel=work', { profile: 'worker' })
  const expected = [urgent.id, lapsed.id, assigned.id, first.id, second.id, other.id, foreign.id]
  await vi.waitFor(() => expect(taskRowIds()).toEqual(expected), taskRead)
  const rendered = taskRowIds()
  const claimed: string[] = []
  for (;;) {
    const next = await worker.tasks.claim({ channel: 'work' })
    if (!next) break
    claimed.push(next.task.id)
  }
  // The rows claim-next can take come first, in the order it takes them; the rest follow.
  expect(rendered).toEqual([...claimed, other.id, foreign.id])
}, 30_000)

it('waits for all Ready pages before showing the same first task as claim-next', async () => {
  const { as, open } = await workbench()
  const worker = as('worker')
  for (let offset = 0; offset < 200; offset += 50) {
    await worker.tasks.createMany('work', Array.from({ length: 50 }, (_, i) => ({ text: `Normal task ${offset + i}` })))
  }
  await worker.tasks.create('work', { text: 'Urgent task', priority: 'urgent' })
  const release = Promise.withResolvers<void>()
  releaseGates.push(release.resolve)
  await open('/tasks?state=ready&channel=work', { profile: 'worker', proxy: async (request, forward) => {
    const query = new URL(request.url).searchParams
    if (routePath(request) === '/tasks' && query.get('channel') === 'work' && query.has('after')) await release.promise
    return forward(request)
  } })
  await vi.waitFor(() => expect(mainText()).toContain('loading all 200 so far'), taskRead)
  expect(taskRowIds()).toEqual([])
  release.resolve()
  await vi.waitFor(() => expect(taskRowIds()).toHaveLength(201), taskRead)
  const first = taskRowIds()[0]
  expect(first).toBe((await worker.tasks.claim({ channel: 'work' }))?.task.id)
}, 30_000)

it('moves a lapsed claim into Ready in claim order with a ready badge on the same tick', async () => {
  const { as, open } = await workbench()
  const worker = as('worker')
  const { task: normal } = await worker.tasks.create('work', { text: 'Normal task' })
  const { task: urgent } = await worker.tasks.create('work', { text: 'Urgent task', priority: 'urgent' })
  const lease = await worker.tasks.claim(urgent.id, { lease: 30 })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(Date.parse(lease.until) - 5000)
  await open('/tasks?state=ready', { profile: 'worker' })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([normal.id]), taskRead)
  await act(async () => { await vi.advanceTimersByTimeAsync(Date.parse(lease.until) - Date.now() - 1) })
  expect(taskRowIds()).toEqual([normal.id])
  await act(async () => { await vi.advanceTimersByTimeAsync(1001) })
  expect(taskRowIds()).toEqual([urgent.id, normal.id])
  expect(taskRows()[0]?.querySelector('.task-state')?.textContent).toBe('ready')
}, 30_000)

async function revocableTasks() {
  const bench = await workbench()
  const { api, client } = bench
  const admin = createBoardClient({ url: BOARD_URL, token: await localUserToken('julian', BOARD_URL), fetch: (input, init) => api.fetch(new Request(input, init)) })
  const { task: secret } = await admin.tasks.create('secret', { text: 'Private task' })
  const { task: publicTask } = await client.tasks.create('work', { text: 'Shared task' })
  await admin.createGrant({ principals: [{ kind: 'everyone' }], can: { secret: [] } })
  const { grant } = await admin.createGrant({ principals: [{ kind: 'user', userId: 'u_reader' }], can: { secret: ['read', 'react'] } })
  return { ...bench, admin, secret, publicTask, revoke: () => admin.revokeGrant(grant.id) }
}

it('drops a cached Ready row when a fresh task read omits it after revocation', async () => {
  const { client, open, secret, publicTask, revoke } = await revocableTasks()
  await open('/tasks?state=ready&priority=normal')
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  await revoke()
  expect((await client.tasks.list({ state: 'ready' })).tasks.map(({ message }) => message.id)).toEqual([publicTask.id])
  // Navigation with the same board query must revalidate, not just apply the local chip filter.
  document.querySelector<HTMLButtonElement>('button[title="remove priority normal"]')!.click()
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id]), taskRead)
}, 30_000)

it('does not accept an older task response when focus requested a newer read', async () => {
  const { open, revoke, publicTask } = await revocableTasks()
  const reads = Array.from({ length: 2 }, () => ({ sampled: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }))
  releaseGates.push(...reads.map(({ release }) => release.resolve))
  let page = 0
  await open('/tasks?state=all', { proxy: async (request, forward) => {
    const response = await forward(request)
    const read = routePath(request) === '/tasks' && new URL(request.url).searchParams.get('state') === 'all' ? reads[page++] : undefined
    if (read) {
      read.sampled.resolve()
      await read.release.promise
    }
    return response
  } })
  await reads[0]!.sampled.promise
  await revoke()
  window.dispatchEvent(new Event('focus'))
  reads[0]!.release.resolve()
  await reads[1]!.sampled.promise
  // Let the first response paint if accepted, while the newer response is still held.
  await act(async () => {})
  expect(taskRowIds()).toEqual([])
  reads[1]!.release.resolve()
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id]), taskRead)
}, 30_000)

it('drops a row whose read grant was revoked between the task page and permission snapshots', async () => {
  const { open, revoke, publicTask } = await revocableTasks()
  await open('/tasks?state=all', { proxy: async (request, forward) => {
    const response = await forward(request)
    if (routePath(request) === '/tasks' && new URL(request.url).searchParams.get('state') === 'all') await revoke()
    return response
  } })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id]), taskRead)
}, 30_000)

it('clears loaded rows when the board refuses a revalidation', async () => {
  const { open, publicTask, secret } = await revocableTasks()
  let refused = false
  await open('/tasks?state=all', { transport: async (request, send) => {
    if (refused && routePath(request) === '/tasks') {
      return Response.json({ error: { code: 'forbidden', message: 'Task list refused' } }, { status: 403 })
    }
    return send()
  } })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  refused = true
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(mainText()).toContain('Task list refused'), taskRead)
  expect(taskRowIds()).toEqual([])
}, 30_000)

it('does not bring back a revoked task from a feed frame delayed past a focus revalidation', async () => {
  const { client, open, secret, publicTask, revoke } = await revocableTasks()
  const seen = Promise.withResolvers<void>()
  await open('/tasks?state=ready', { proxy: seeTaskEvent('reaction.added', seen.resolve) })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'), taskRead)
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  try {
    await client.react(secret.id, 'eyes')
    await seen.promise
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), taskRead)
    taskRows()[1]!.focus()
    await revoke()
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(taskRowIds()).toEqual([publicTask.id])
      expect(document.activeElement).toBe(taskRows()[0])
    }, taskRead)
    frame.mockRestore()
    flushSync(() => { for (const flush of frames) flush(performance.now()) })
    expect(taskRowIds()).toEqual([publicTask.id])
  } finally {
    frame.mockRestore()
  }
}, 30_000)

it('revalidates task access when the feed reconnects after a failed poll', async () => {
  const { client, open, secret, publicTask, revoke } = await revocableTasks()
  let dropNext = false
  await open('/tasks?state=ready', { transport: async (request, send) => {
    if (routePath(request) === '/events' && dropNext) {
      dropNext = false
      return Response.json({ error: { code: 'unavailable', message: 'connection lost' } }, { status: 503 })
    }
    return send()
  } })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'), taskRead)
  await revoke()
  dropNext = true
  await client.post('work', 'Wake the current poll')
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id]), taskRead)
}, 30_000)

it('refreshes label permission with the loaded rows even when read access remains', async () => {
  const { admin, client, open, publicTask } = await revocableTasks()
  const urgent = (await client.tasks.create('limited', { text: 'Urgent but needs label permission', priority: 'urgent' })).task
  await admin.createGrant({ principals: [{ kind: 'everyone' }], can: { limited: ['read'] } })
  const { grant } = await admin.createGrant({ principals: [{ kind: 'user', userId: 'u_reader' }], can: { limited: ['label'] } })
  await open('/tasks?state=ready')
  await vi.waitFor(() => expect(taskRowIds().slice(0, 2)).toEqual([urgent.id, publicTask.id]), taskRead)
  await admin.revokeGrant(grant.id)
  await expect(client.tasks.claim({ channel: 'limited' })).rejects.toMatchObject({ status: 403 })
  expect((await client.tasks.list({ channel: 'limited' })).tasks.map(({ message }) => message.id)).toEqual([urgent.id])
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.waitFor(() => expect(taskRowIds().slice(0, 2)).toEqual([publicTask.id, urgent.id]), taskRead)
}, 30_000)

it('re-reads for a task announced while the first page snapshot is held, and for later tasks', async () => {
  const { client, open } = await workbench()
  const { task: first } = await client.tasks.create('work', { text: 'In the snapshot' })
  const sampled = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  releaseGates.push(release.resolve)
  let hold = true
  let watchingCreate = false
  const seen = Promise.withResolvers<void>()
  const watch = seeTaskEvent('task.created', () => { if (watchingCreate) seen.resolve() })
  await open('/tasks?channel=work', { proxy: async (request, forward) => {
    const response = await watch(request, forward)
    if (hold && routePath(request) === '/tasks' && new URL(request.url).searchParams.get('channel') === 'work') {
      hold = false
      sampled.resolve()
      await release.promise
    }
    return response
  } })
  await sampled.promise
  await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'), taskRead)
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  let second: string
  try {
    watchingCreate = true
    second = (await client.tasks.create('work', { text: 'During the read' })).task.id
    await seen.promise
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), taskRead)
    expect(taskRowIds()).toEqual([])
    release.resolve()
    await vi.waitFor(() => expect(taskRowIds()).toContain(first.id), taskRead)
    frame.mockRestore()
    await act(async () => { for (const flush of frames) flush(performance.now()) })
  } finally {
    frame.mockRestore()
  }
  await vi.waitFor(() => expect(taskRowIds()).toEqual([first.id, second]), taskRead)
  const { task: third } = await client.tasks.create('work', { text: 'After the read' })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([first.id, second, third.id]), taskRead)
}, 30_000)

it('drops a cached row when opening its thread is refused after revocation', async () => {
  const { client, open, secret, publicTask, revoke } = await revocableTasks()
  const release = Promise.withResolvers<void>()
  releaseGates.push(release.resolve)
  let hold = false
  await open('/tasks?state=ready', { proxy: async (request, forward) => {
    if (hold && routePath(request) === '/tasks') await release.promise
    return forward(request)
  } })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  hold = true
  await revoke()
  await expect(client.thread(secret.id)).rejects.toMatchObject({ status: 404 })
  taskRows()[1]!.click()
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id]), taskRead)
  expect(document.body.textContent).not.toContain('Private task')
}, 30_000)

it('keeps a refused thread and its cache empty after a delayed feed frame', async () => {
  const { client, open, secret, publicTask, revoke } = await revocableTasks()
  const seen = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  releaseGates.push(release.resolve)
  const watch = seeTaskEvent('reaction.added', seen.resolve)
  let hold = false
  await open('/tasks?state=ready', { proxy: async (request, forward) => {
    const response = await watch(request, forward)
    if (hold && routePath(request) === '/tasks') await release.promise
    return response
  } })
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'), taskRead)
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  try {
    await client.react(secret.id, 'eyes')
    await seen.promise
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), taskRead)
    hold = true
    await revoke()
    await expect(client.thread(secret.id)).rejects.toMatchObject({ status: 404 })
    taskRows()[1]!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('message not found'), taskRead)
    expect(document.body.textContent).not.toContain('Private task')
    frame.mockRestore()
    flushSync(() => { for (const flush of frames) flush(performance.now()) })
    expect(document.body.textContent).not.toContain('Private task')
    link('Handoffs').click()
    await vi.waitFor(() => {
      expect(document.querySelector('main h1')?.textContent).toBe('HANDOFFS')
      expect(mainText()).not.toContain('Private task')
    }, taskRead)
  } finally {
    frame.mockRestore()
  }
}, 30_000)

it('keeps a live reply out of the pane until its own read accepts it, without interrupting a draft', async () => {
  const { client, open } = await workbench()
  const { task } = await client.tasks.create('work', { text: 'Discuss the release' })
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  releaseGates.push(release.resolve)
  let hold = false
  await open(`/tasks?thread=${task.id}`, { proxy: async (request, forward) => {
    const response = await forward(request)
    if (hold && routePath(request) === `/messages/${task.id}`) {
      reading.resolve()
      await release.promise
    }
    return response
  } })
  const { pane, draft } = await vi.waitFor(() => {
    const pane = document.querySelector('aside[aria-label="Thread"]')
    const draft = pane?.querySelector('textarea')
    expect(pane?.textContent).toContain('Discuss the release')
    expect(draft).toBeDefined()
    return { pane: pane!, draft: draft! }
  }, taskRead)
  draft.focus()
  await act(async () => typeInto(draft, 'A reply in progress'))
  hold = true
  await client.reply(task.id, 'A reply on the board')
  await reading.promise
  expect(pane.textContent).not.toContain('A reply on the board')
  release.resolve()
  await vi.waitFor(() => expect(pane.textContent).toContain('A reply on the board'), taskRead)
  expect(document.activeElement).toBe(draft)
  expect(draft.value).toBe('A reply in progress')
}, 30_000)

it('keeps the same focused Ready row in place during a live promotion until blur', async () => {
  const { client, open } = await workbench()
  const { task: first } = await client.tasks.create('work', { text: 'First task', priority: 'high' })
  const { task: second } = await client.tasks.create('work', { text: 'Reading this task' })
  await open(`/tasks?state=ready&thread=${second.id}`)
  await vi.waitFor(() => expect(taskRowIds()).toEqual([first.id, second.id]), taskRead)
  const reading = taskRows()[1]!
  reading.focus()
  expect(document.activeElement).toBe(reading)
  await client.tasks.priority(second.id, 'urgent')
  await vi.waitFor(() => expect(reading.querySelector('.task-priority')?.textContent).toBe('urgent'), taskRead)
  expect(taskRowIds()).toEqual([first.id, second.id])
  expect(taskRows()[1]).toBe(reading)
  expect(document.activeElement).toBe(reading)
  reading.blur()
  await vi.waitFor(() => expect(taskRowIds()).toEqual([second.id, first.id]), taskRead)
}, 30_000)

it('removes a focused task deleted by another client and passes focus to the next, previous, then list', async () => {
  const { client, as, open } = await workbench()
  const { task: first } = await client.tasks.create('work', { text: 'First' })
  const { task: second } = await client.tasks.create('work', { text: 'Second' })
  const { task: third } = await client.tasks.create('work', { text: 'Third' })
  await open('/tasks?state=all')
  await vi.waitFor(() => expect(taskRowIds()).toEqual([first.id, second.id, third.id]), taskRead)
  taskRows()[1]!.focus()
  const other = as()
  await other.delete(second.id)
  await vi.waitFor(() => {
    expect(taskRowIds()).toEqual([first.id, third.id])
    expect(document.activeElement).toBe(taskRows()[1])
  }, taskRead)
  await other.delete(third.id)
  await vi.waitFor(() => {
    expect(taskRowIds()).toEqual([first.id])
    expect(document.activeElement).toBe(taskRows()[0])
  }, taskRead)
  await other.delete(first.id)
  await vi.waitFor(() => {
    expect(taskRowIds()).toEqual([])
    expect(document.activeElement).toBe(document.querySelector('.task-rows'))
  }, taskRead)
}, 30_000)

it('shows urgent before older normal work in Handoffs Runnable', async () => {
  const { client, open } = await workbench()
  await client.tasks.create('work', { text: 'Normal Handoff' })
  await client.tasks.create('work', { text: 'Urgent Handoff', priority: 'urgent' })
  await open('/handoffs')
  await vi.waitFor(() => expect([...lane('Runnable').querySelectorAll('.handoff-title')].map((a) => a.textContent))
    .toEqual(['Urgent Handoff', 'Normal Handoff']), taskRead)
}, 30_000)

const runnableTitles = () => [...lane('Runnable').querySelectorAll('.handoff-title')].map((row) => row.textContent)

it('does not let a reaction from an overlapping poll restore an omitted Handoff', async () => {
  const { client, open, secret, revoke } = await revocableTasks()
  const polling = gate()
  const sampled = gate()
  const release = gate()
  await open('/handoffs', { transport: async (request, send) => {
    if (routePath(request) !== '/events') return send()
    const result = send()
    if (Number(new URL(request.url).searchParams.get('wait')) > 0) polling.resolve()
    const response = await result
    if (!response.ok) return response
    const { events } = await response.clone().json() as { events: { type: string }[] }
    if (events.some(({ type }) => type === 'reaction.added')) {
      sampled.resolve()
      await release.promise
    }
    return response
  } })
  await vi.waitFor(() => expect(runnableTitles()).toContain('Private task'))
  await polling.promise
  await client.react(secret.id, 'eyes')
  await sampled.promise
  await revoke()
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(runnableTitles()).toEqual(['Shared task']))
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  try {
    release.resolve()
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    frame.mockRestore()
    await act(async () => { for (const flush of frames) flush(performance.now()) })
    expect(runnableTitles()).toEqual(['Shared task'])
    expect(mainText()).not.toContain('Private task')
  } finally { frame.mockRestore() }
})

it('does not apply a retained Handoff edit from a poll dispatched before its accepted read', async () => {
  const { client, open, publicTask, revoke } = await revocableTasks()
  const polling = gate()
  const list = gate()
  const accept = gate()
  const sampled = gate()
  const deliver = gate()
  const recheck = gate()
  let read = 0
  let revalidating = false
  await open('/handoffs', { transport: async (request, send) => {
    if (routePath(request) === '/tasks' && revalidating) {
      if (++read > 1) await recheck.promise
      const response = await send()
      list.resolve()
      await accept.promise
      return response
    }
    if (routePath(request) !== '/events') return send()
    const result = send()
    if (Number(new URL(request.url).searchParams.get('wait')) > 0) polling.resolve()
    const response = await result
    if (!response.ok) return response
    const { events } = await response.clone().json() as { events: { type: string }[] }
    if (events.some(({ type }) => type === 'message.edited')) {
      sampled.resolve()
      await deliver.promise
    }
    return response
  } })
  await vi.waitFor(() => expect(runnableTitles()).toContain('Private task'))
  await polling.promise
  await revoke()
  revalidating = true
  window.dispatchEvent(new Event('focus'))
  await list.promise
  await client.edit(publicTask.id, 'Edited during the older poll')
  await sampled.promise
  accept.resolve()
  await vi.waitFor(() => expect(runnableTitles()).toEqual(['Shared task']))
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  try {
    deliver.resolve()
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    frame.mockRestore()
    await act(async () => { for (const flush of frames) flush(performance.now()) })
    expect(runnableTitles()).toEqual(['Shared task'])
  } finally { frame.mockRestore() }
  recheck.resolve()
  await vi.waitFor(() => expect(runnableTitles()).toEqual(['Edited during the older poll']))
})

it('evicts a revoked task from Handoffs and the already loaded channel', async () => {
  const { open, revoke } = await revocableTasks()
  await open('/c/secret')
  await vi.waitFor(() => expect(mainText()).toContain('Private task'))
  link('Handoffs').click()
  await vi.waitFor(() => expect(runnableTitles()).toContain('Private task'))
  await revoke()
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(runnableTitles()).toEqual(['Shared task']))
  history.pushState(null, '', '/c/secret')
  window.dispatchEvent(new PopStateEvent('popstate'))
  await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe('#secret'))
  expect(mainText()).not.toContain('Private task')
})

it('orders Handoffs with the refreshed label grant and matches claim-next', async () => {
  const { admin, as, open } = await revocableTasks()
  const worker = as('worker')
  await worker.tasks.create('limited', { text: 'Urgent but no longer claimable', priority: 'urgent' })
  await admin.createGrant({ principals: [{ kind: 'everyone' }], can: { limited: ['read'] } })
  const { grant } = await admin.createGrant({ principals: [{ kind: 'user', userId: 'u_reader' }], can: { limited: ['label'] } })
  await open('/handoffs', { profile: 'worker' })
  await vi.waitFor(() => expect(runnableTitles()[0]).toBe('Urgent but no longer claimable'))
  await admin.revokeGrant(grant.id)
  await expect(worker.tasks.claim({ channel: 'limited' })).rejects.toMatchObject({ status: 403 })
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(runnableTitles()[0]).toBe('Shared task'))
  const first = runnableTitles()[0]
  expect((await worker.tasks.claim({ channel: 'work' }))?.task.text).toBe(first)
})

it('says more loading in Runnable until the urgent task on page two is read', async () => {
  const { as, open } = await workbench()
  const worker = as('worker')
  for (let offset = 0; offset < 200; offset += 50)
    await worker.tasks.createMany('work', Array.from({ length: 50 }, (_, i) => ({ text: `Normal handoff ${offset + i}` })))
  await worker.tasks.create('work', { text: 'Urgent handoff', priority: 'urgent' })
  const release = gate()
  await open('/handoffs', { profile: 'worker', transport: async (request, send) => {
    if (routePath(request) === '/tasks' && new URL(request.url).searchParams.has('after')) await release.promise
    return send()
  } })
  await vi.waitFor(() => expect(lane('Runnable').textContent).toContain('more loading'))
  expect(runnableTitles()).toEqual([])
  release.resolve()
  await vi.waitFor(() => expect(runnableTitles()).toHaveLength(201), taskRead)
  expect(runnableTitles()[0]).toBe((await worker.tasks.claim({ channel: 'work' }))?.task.text)
}, 30_000)

it('ignores a superseded thread success released after a newer real 404', async () => {
  const { open, secret, revoke } = await revocableTasks()
  const sampled = gate()
  const release = gate()
  const delivered = gate()
  let held = false
  await open(`/handoffs?thread=${secret.id}`, { transport: async (request, send) => {
    const response = await send()
    if (!held && routePath(request) === `/messages/${secret.id}`) {
      held = true
      expect(response.status).toBe(200)
      sampled.resolve()
      await release.promise
      delivered.resolve()
    }
    return response
  } })
  await sampled.promise
  await revoke()
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('message not found'))
  await act(async () => { release.resolve(); await delivered.promise })
  expect(threadPane()?.textContent).toContain('message not found')
  expect(document.body.textContent).not.toContain('Private task')
})

it('keeps unsent reply text and attachments through a 503 and recovery', async () => {
  const { client, open } = await workbench()
  const { task } = await client.tasks.create('work', { text: 'Thread with a draft' })
  await client.tasks.create('elsewhere', { text: 'Different task scope' })
  let outage = false
  await open(`/handoffs?thread=${task.id}`, { transport: async (request, send) => {
    if (outage && routePath(request) === `/messages/${task.id}`)
      return Response.json({ error: { code: 'unavailable', message: 'temporary outage' } }, { status: 503 })
    return send()
  } })
  const draft = await vi.waitFor(() => {
    const textarea = threadPane()?.querySelector('textarea')
    expect(textarea).toBeDefined()
    return textarea!
  })
  draft.focus()
  await act(async () => {
    typeInto(draft, 'Draft text')
    const picker = threadPane()!.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(picker, 'files', { value: [new File(['draft contents'], 'notes.txt', { type: 'text/plain' })] })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(threadPane()?.textContent).toContain('notes.txt')
  outage = true
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('temporary outage'))
  expect(threadPane()?.querySelector('textarea')).toBe(draft)
  expect(draft.value).toBe('Draft text')
  expect(threadPane()?.textContent).toContain('notes.txt')
  outage = false
  await client.reply(task.id, 'New reply after recovery')
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('New reply after recovery'))
  expect(document.activeElement).toBe(draft)
  expect(draft.value).toBe('Draft text')
  expect(threadPane()?.textContent).toContain('notes.txt')

  // A scope change can also hide the pane while it rechecks access.
  outage = true
  history.pushState(null, '', `/tasks?channel=elsewhere&thread=${task.id}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
  await vi.waitFor(() => {
    expect(threadPane()?.textContent).toContain('temporary outage')
    expect(threadPane()?.querySelector('textarea')).toBeNull()
  })
  outage = false
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => {
    expect(threadPane()?.querySelector('textarea')?.value).toBe('Draft text')
    expect(threadPane()?.textContent).toContain('notes.txt')
  })
})

it('keeps a focused Handoff in its original lane when another reader claims it', async () => {
  const { api, as, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Review the release' })
  await open('/handoffs')
  const reading = await vi.waitFor(() => link('Review the release', lane('Runnable')))
  reading.focus()
  expect(document.activeElement).toBe(reading)

  await as('worker').tasks.claim(task.id)
  await vi.waitFor(() => {
    const row = link('Review the release', lane('Runnable')).closest('li')!
    expect(row.textContent).toContain('claimed')
    expect(row.textContent).toContain('Held by')
    expect(document.activeElement).toBe(reading)
  })

  link('Presidium').click()
  await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe('Presidium'))
  link('Handoffs').click()
  await vi.waitFor(() => expect(link('Review the release', lane('In progress'))).toBeDefined())
})

it('shows a completed task and its result in the Delivered lane', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Publish the release notes' })
  await (await api.tasks.claim(task.id)).complete('Release notes are live')
  await open('/handoffs')
  await vi.waitFor(() => {
    const delivered = lane('Delivered')
    expect(link('Publish the release notes', delivered)).toBeDefined()
    expect(delivered.textContent).toContain('Delivery: Release notes are live')
  })
})

it('typing over Handoffs focuses the open thread reply', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Check the build' })
  await open(`/handoffs?thread=${task.id}`)
  const reply = await vi.waitFor(() => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="reply to thread…"]')
    expect(field).not.toBeNull()
    return field!
  })
  const overHandoffs = link('Check the build', lane('Runnable'))
  overHandoffs.focus()
  expect(document.activeElement).toBe(overHandoffs)
  overHandoffs.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
  expect(document.activeElement).toBe(reply)
})

it('renders the author’s initial without loading their supplied avatar', async () => {
  const { as, open } = await workbench()
  const author = as({ name: 'Reviewer', avatar: 'https://images.example.test/avatar.png' })
  await author.post('work', 'The build is green')
  await open('/c/work')
  await vi.waitFor(() => {
    const row = [...document.querySelectorAll('main .message')].find((el) => el.textContent?.includes('The build is green'))
    expect(row?.querySelector('.avatar')?.textContent).toBe('R')
    expect(row?.querySelector('img')).toBeNull()
  })
})

it('renders markdown images as alt-text links, not automatic loads', async () => {
  const { client, open } = await workbench()
  await client.post('work', '![Build chart](https://images.example.test/chart.png)\n\n![Trace][trace]\n\n[![Dashboard icon](https://images.example.test/icon.png)](https://example.test/dashboard)\n\n[trace]: https://images.example.test/trace.png')
  await open('/c/work')
  await vi.waitFor(() => {
    const main = document.querySelector('main')!
    expect(link('Build chart', main).href).toBe('https://images.example.test/chart.png')
    expect(link('Trace', main).href).toBe('https://images.example.test/trace.png')
    expect(link('Dashboard icon', main).href).toBe('https://example.test/dashboard')
    expect(main.querySelector('img')).toBeNull()
  })
})

it('opens Schedules from Settings and cancels a scheduled post', async () => {
  const { client, open } = await workbench()
  await client.schedule('work', { text: 'Tomorrow’s recap', in: '1d' })
  await open('/settings/access')
  const schedules = await vi.waitFor(() => link('schedules'))
  schedules.click()
  const cancel = await vi.waitFor(() => {
    expect(mainText()).toContain('Tomorrow’s recap')
    const button = [...document.querySelectorAll<HTMLButtonElement>('main button')].find((el) => el.textContent === 'cancel')
    expect(button).toBeDefined()
    return button!
  })
  link('#work', cancel.parentElement!).focus()
  cancel.click()
  await vi.waitFor(() => expect(mainText()).toContain('nothing scheduled'))
  link('all').click()
  await vi.waitFor(() => {
    expect(mainText()).toContain('Tomorrow’s recap')
    expect(mainText()).toContain('canceled')
    expect([...document.querySelectorAll('main button')].some((el) => el.textContent === 'cancel')).toBe(false)
  })
})

function button(title: string) {
  const match = document.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
  expect(match, `button: ${title}`).not.toBeNull()
  return match!
}

function menuItem(text: string) {
  const match = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === text)
  expect(match, `menu item: ${text}`).toBeDefined()
  return match!
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  set.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

async function switchProfile(name: string, fromRegistry = false) {
  const developer = document.querySelector<HTMLDetailsElement>('main details.developer-identity')!
  if (!developer.open) developer.querySelector('summary')!.click()
  button('post as').click()
  if (fromRegistry) (await vi.waitFor(() => menuItem(name))).click()
  else {
    const custom = await vi.waitFor(() => menuItem('another profile…'))
    custom.click()
    const field = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="profile name"]')
      expect(input).not.toBeNull()
      return input!
    })
    await act(async () => typeInto(field, name))
    field.form!.querySelector('button')!.click()
  }
  await vi.waitFor(() => expect(document.querySelector('.sidebar-foot')!.textContent).toContain(`acting as ${name}`))
}

it('labels the signed-in person and lists only registered profiles in Settings', async () => {
  const { as, client, open } = await workbench({ agentOps: true })
  await client.post('work', 'Ready for review')
  await as('reviewer').agents.register({ channel: 'work', role: 'implementation-worker', harness: 'shell' })
  await open('/settings/access')
  const me = await client.me()
  await vi.waitFor(() => expect(document.querySelector('.sidebar-foot')!.textContent).toContain(`acting as ${me.name}`))
  expect(document.querySelector('.sidebar-foot button[title="post as"]')).toBeNull()
  await switchProfile('reviewer', true)
  button('post as').click()
  await vi.waitFor(() => expect(menuItem('another profile…')).toBeDefined())
  expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).not.toContain('claude')
})

it('waits for a name in app-served mode and then shows that profile', async () => {
  const { open } = await workbench()
  await open('/', { named: true, profile: 'deployment' })
  const field = document.querySelector<HTMLInputElement>('input[name="profile"]')!
  expect(field).not.toBeNull()
  expect(document.querySelector('main')).toBeNull()
  typeInto(field, 'reviewer')
  field.form!.querySelector('button')!.click()
  await vi.waitFor(() => expect(document.querySelector('.sidebar-foot')!.textContent).toContain('acting as reviewer'))
})

it('keeps the identity shown and the author of writes in sync when switching during named boot', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'Ready for review')
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await open('/settings/access', {
    named: true,
    proxy: async (request, forward) => {
      const response = await forward(request)
      if (routePath(request) === '/channels' && request.headers.get('x-board-profile') === 'reviewer') {
        reading.resolve()
        await release.promise
      }
      return response
    },
  })
  const field = document.querySelector<HTMLInputElement>('input[name="profile"]')!
  typeInto(field, 'reviewer')
  field.form!.querySelector('button')!.click()
  try {
    await reading.promise
    await switchProfile('editor')
    release.resolve()
    const channel = await vi.waitFor(() => {
      const item = document.querySelector<HTMLAnchorElement>('a[href="/c/work"]')
      expect(item).not.toBeNull()
      return item!
    })
    channel.click()
    await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'))
    const composer = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="message #work…"]')!
    await act(async () => typeInto(composer, 'Edits ready'))
    document.querySelector<HTMLButtonElement>('main button.send')!.click()
    await vi.waitFor(async () => {
      const { messages } = await client.channel('work').messages()
      expect(messages.find((message) => message.text === 'Edits ready')?.by.profile).toBe('editor')
    })
    expect(document.querySelector('.sidebar-foot')?.textContent).toContain('acting as editor')
  } finally {
    release.resolve()
  }
})

it('drops a registry answer from the previous profile at the data boundary', async () => {
  const { as, client, open } = await workbench({ agentOps: true })
  await client.post('work', 'Ready for review')
  await as('reviewer').agents.register({ channel: 'work', role: 'implementation-worker', harness: 'shell' })
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await open('/settings/access', {
    profile: 'editor',
    proxy: async (request, forward) => {
      const response = await forward(request)
      if (routePath(request) === '/ops/agents' && request.headers.get('x-board-profile') === 'editor') {
        reading.resolve()
        await release.promise
      }
      return response
    },
  })
  // Test at the data boundary so effect cleanup cannot hide a stale result.
  const page = await import('../src/inspect/app/board.ts')
  const stale = page.listProfiles('work')
  try {
    await reading.promise
    await switchProfile('writer')
    release.resolve()
    expect(await stale).toBeUndefined()
    expect(await page.listProfiles('work')).toEqual(['reviewer'])
  } finally {
    release.resolve()
    await stale
  }
})

it('does not merge a delayed actors directory from the boot profile after switching', async () => {
  const { as, open } = await workbench()
  const post = await as('directory-only').post('work', 'Ready for review')
  const editor = await as('editor').post('work', 'Editor is ready')
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await open('/settings/access', {
    profile: 'reviewer',
    proxy: async (request, forward) => {
      if (routePath(request) !== '/actors') return forward(request)
      if (request.headers.get('x-board-profile') === 'editor') {
        // The new handle's directory doesn't include the old entry.
        const url = new URL(request.url)
        url.searchParams.set('id', editor.by.actor)
        return forward(new Request(url, request))
      }
      const response = await forward(request)
      reading.resolve()
      await release.promise
      return response
    },
  })
  try {
    await reading.promise
    await switchProfile('editor')
    const page = await import('../src/inspect/app/board.ts')
    await vi.waitFor(() => expect(page.getState().actors[editor.by.actor]?.name).toBe('editor'))
    await act(async () => release.resolve())
    expect(page.getState().actors[post.by.actor]).toBeUndefined()
  } finally {
    release.resolve()
  }
})

it('aborts the boot feed and discards an event already queued by the previous profile', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'Ready for review')
  const oldSignals: AbortSignal[] = []
  let newFeed = false
  await open('/settings/access', {
    profile: 'reviewer',
    proxy: async (request, forward) => {
      if (routePath(request) === '/events') {
        if (request.headers.get('x-board-profile') === 'reviewer') oldSignals.push(request.signal)
        else if (request.headers.get('x-board-profile') === 'editor') newFeed = true
      }
      return forward(request)
    },
  })
  const page = await import('../src/inspect/app/board.ts')
  await vi.waitFor(() => expect(page.getState().live).toBe('live'))
  const frames: FrameRequestCallback[] = []
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => frames.push(run))
  try {
    const stale = await client.post('work', 'Queued by the old feed')
    await vi.waitFor(() => expect(frames).not.toHaveLength(0))
    frame.mockRestore()
    await switchProfile('editor')
    await vi.waitFor(() => expect(newFeed).toBe(true))
    expect(oldSignals.length).toBeGreaterThan(0)
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true)
    for (const flush of frames) flush(performance.now())
    expect(page.getState().messages[stale.id]).toBeUndefined()
    const fresh = await client.post('work', 'Read by the new feed')
    await vi.waitFor(() => expect(page.getState().messages[fresh.id]?.text).toBe(fresh.text))
  } finally {
    frame.mockRestore()
  }
})

it('drops a late status read after a profile switch', async () => {
  const { client, open } = await workbench()
  const sampled = Promise.withResolvers<void>()
  const releaseOld = Promise.withResolvers<void>()
  const releaseNew = Promise.withResolvers<void>()
  const releaseEvents = Promise.withResolvers<void>()
  let hold = false
  await open('/settings/access', {
    profile: 'reviewer',
    proxy: async (request, forward) => {
      const response = await forward(request)
      const profile = request.headers.get('x-board-profile')
      const path = routePath(request)
      if (path === '/events' && profile === 'reviewer' && hold) await releaseEvents.promise
      if (path === '/control' && hold) {
        if (profile === 'reviewer') {
          sampled.resolve()
          await releaseOld.promise
        } else await releaseNew.promise
      }
      return response
    },
  })
  const page = await import('../src/inspect/app/board.ts')
  await vi.waitFor(() => {
    expect(page.getState().live).toBe('live')
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 0 })
  })
  try {
    hold = true
    await client.pause('old profile samples the pause')
    const reading = page.loadStatus()
    await sampled.promise
    await client.resume('before switching')
    await switchProfile('editor')
    releaseOld.resolve()
    await reading
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 0 })
    releaseNew.resolve()
    await vi.waitFor(() => expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 1 }))
  } finally {
    releaseOld.resolve()
    releaseNew.resolve()
    releaseEvents.resolve()
  }
})

it.each([
  { width: 390, profile: undefined },
  { width: 1280, profile: undefined },
  { width: 390, profile: 'reviewer' },
])('shows one acting-as label with the sidebar hidden or open ($width, $profile)', async ({ width, profile }) => {
  const { as, client, open } = await workbench()
  await client.post('work', 'Ready for review')
  await open('/c/work', { width, ...(profile ? { profile } : {}) })
  const identity = `acting as ${(await as(profile ?? null).me()).name}`
  const header = () => document.querySelector('main .header')?.textContent
  const rail = () => document.querySelector<HTMLElement>('.sidebar')!
  const openRail = () => {
    expect(getComputedStyle(rail()).display).not.toBe('none')
    expect(rail().hidden).toBe(false)
    expect(rail().querySelector('.whoami')?.textContent).toContain(identity)
    expect(header()).not.toContain('acting as')
  }
  if (width >= 1024) {
    await vi.waitFor(openRail)
    button('Hide sidebar').click()
  }
  await vi.waitFor(() => {
    expect(header()).toContain(identity)
    expect(rail().hidden || getComputedStyle(rail()).display === 'none').toBe(true)
  })
  button('Show sidebar').click()
  await vi.waitFor(openRail)
})

it('shows a pause that lands before the first channels cursor is captured', async () => {
  const { client, open } = await workbench()
  let earlyStatus: Promise<Response> | undefined
  let channelsStarted = false
  await open('/', {
    proxy: async (request, forward) => {
      const path = routePath(request)
      if (path === '/control' && !channelsStarted) return (earlyStatus = forward(request))
      if (path === '/channels' && !channelsStarted) {
        channelsStarted = true
        // If boot already read status, let the real board finish that snapshot first.
        await earlyStatus
        await client.pause('paused during boot')
      }
      return forward(request)
    },
  })
  await vi.waitFor(() => {
    expect(document.querySelector('.live')?.textContent).toBe('live')
    expect(document.querySelector('.pause-banner:not([hidden])')?.textContent).toBe('paused')
  })
  expect(await client.status()).toEqual({ paused: true, pauseEpoch: 1 })
})

it('asks for a reason to Pause, shows the board’s refusal, and lets the manager try again', async () => {
  const { client, open } = await workbench()
  let allow = false
  await open('/', {
    proxy: async (request, forward) => {
      // Simulate the write arriving with reduced authority after the page read /me.
      if (!allow && routePath(request) === '/control/pause') request.headers.set('x-board-can', '*=read')
      return forward(request)
    },
  })
  await vi.waitFor(() => button('Pause')).then((pause) => pause.click())
  await submitReason('reason', 'rotate workers')
  await vi.waitFor(() => expect(document.querySelector('.toasts')?.textContent).toContain('only a person with board-wide manage can change work control'))
  expect(await client.status()).toEqual({ paused: false, pauseEpoch: 0 })
  allow = true
  button('Pause').click()
  await submitReason('reason', 'rotate workers')
  await vi.waitFor(() => expect(document.querySelector('.pause-banner:not([hidden])')?.textContent).toContain('rotate workers'))
  expect(await client.status()).toEqual({ paused: true, pauseEpoch: 1 })
})

it('shows live pause detail on every view and lets the manager resume with a reason', async () => {
  const { client, open } = await workbench()
  await client.post('work', 'Release notes')
  await open()
  const banner = () => document.querySelector<HTMLElement>('.pause-banner')!
  await vi.waitFor(() => button('Pause'))
  await vi.waitFor(() => expect(document.querySelector('.live')?.textContent).toBe('live'))
  await client.pause('maintenance window')
  const me = await client.me()
  await vi.waitFor(() => expect(banner().textContent).toMatch(new RegExp(`^paused by ${me.name}, .+ ago: maintenance window$`)))
  for (const [path, title] of [['/presidium', 'Presidium'], ['/c/work', '#work'], ['/tasks', 'tasks'], ['/attention', 'attention'], ['/settings/access', 'settings'], ['/handoffs', 'HANDOFFS']]) {
    document.querySelector<HTMLAnchorElement>(`.sidebar a[href="${path}"]`)!.click()
    await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe(title))
    expect(banner().hidden).toBe(false)
    expect(banner().textContent).toContain('maintenance window')
  }
  button('Resume').click()
  await submitReason('reason', 'maintenance ended')
  await vi.waitFor(() => {
    expect(banner().hidden).toBe(true)
    button('Pause')
  })
  const received = client.events({ all: true, last: 1 })
  try {
    expect((await received.next()).value).toMatchObject({ type: 'work.control', payload: { reason: 'maintenance ended', paused: false } })
  } finally {
    await received.return(undefined)
  }
})

it('keeps the message scroller in place through a live pause and resume', async () => {
  const { client, open } = await workbench()
  for (let i = 1; i <= 20; i++) await client.post('work', `Release log entry ${i}`)
  const thread = await client.post('work', 'Release review')
  await client.reply(thread.id, 'The review starts here')
  await open(`/c/work?thread=${thread.id}`)
  await vi.waitFor(() => {
    expect(document.querySelector('.live')?.textContent).toBe('live')
    expect(document.querySelectorAll('main .message')).toHaveLength(21)
    expect(document.querySelector('.pane .feed')?.textContent).toContain('The review starts here')
    button('Pause')
  })
  const scrollers = [...document.querySelectorAll<HTMLElement>('main .feed, .pane .feed, .sidebar-scroll')]
  expect(scrollers).toHaveLength(3)
  const banner = document.querySelector<HTMLElement>('.pause-banner')!
  // Happy DOM doesn't lay out the page. Supply the box measurement, not the style or scroll behavior.
  const height = 32
  banner.getBoundingClientRect = () => new DOMRect(0, 46, 1256, banner.hidden ? 0 : height)
  scrollers.forEach((el) => {
    Object.defineProperty(el, 'scrollHeight', { value: 1200 })
    el.scrollTop = 300
    el.dispatchEvent(new Event('scroll'))
  })

  await client.pause('waiting for the release window')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toContain('waiting for the release window')
    expect(scrollers.map((el) => el.scrollTop)).toEqual([332, 332, 332])
  })
  expect(banner.parentElement).toBe(document.querySelector('.workspace'))
  expect(getComputedStyle(banner.parentElement!).display).toBe('grid')
  expect(['', 'static', 'relative']).toContain(getComputedStyle(banner).position)
  expect(getComputedStyle(banner).overflowY).toBe('auto')

  await client.resume('the release window opened')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(true)
    expect(scrollers.map((el) => el.scrollTop)).toEqual([300, 300, 300])
    button('Pause')
  })

  // A browser can clamp the pinned pane's old offset as soon as the banner goes away.
  const pane = document.querySelector<HTMLElement>('.pane .feed')!
  const bottom = () => pane.scrollHeight - pane.clientHeight
  let offset = 300
  Object.defineProperties(pane, {
    clientHeight: { get: () => 300 - (banner.hidden ? 0 : height) },
    scrollTop: { get: () => Math.min(offset, bottom()), set: (top: number) => { offset = Math.min(top, bottom()) } },
  })
  pane.scrollTop = bottom()
  pane.dispatchEvent(new Event('scroll'))
  await client.pause('waiting again')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(false)
    expect(pane.scrollTop).toBe(bottom())
  })
  await client.resume('finished')
  await vi.waitFor(() => {
    expect(banner.hidden).toBe(true)
    expect(pane.scrollTop).toBe(bottom())
  })
})

async function submitReason(placeholder: string, text: string) {
  const reason = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
    expect(input).not.toBeNull()
    return input!
  })
  await act(async () => typeInto(reason, text))
  reason.form!.querySelector('button')!.click()
}

it('shows just paused to a reader who joined after the transition', async () => {
  const { client, open } = await workbench()
  await client.pause('an earlier pause')
  await open('/settings/access', { can: '*=read' })
  await vi.waitFor(() => expect(document.querySelector('.pause-banner')?.textContent).toBe('paused'))
  expect(document.querySelector('button[title="Resume"]')).toBeNull()
})

it('lets a person claim, park, and unpark an unheld ready task', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Check the release' })
  await open(`/?thread=${task.id}`)
  await vi.waitFor(() => expect(document.querySelector('.task-card .task-state')?.textContent).toBe('ready'))
  await vi.waitFor(() => button('more')).then((more) => more.click())
  const park = await vi.waitFor(() => menuItem('park…'))
  const actions = [...document.querySelectorAll('.task-card button, [role="menuitem"]')].map((item) => item.textContent?.trim()).join(' ')
  expect(actions).toContain('claim')
  expect(actions).toContain('park')
  expect(actions).not.toMatch(/\b(renew|release|complete)\b/i)
  park.click()
  await submitReason('why it should wait', 'waiting for the release window')
  const unpark = await vi.waitFor(() => {
    expect(document.querySelector('.task-card')?.textContent).toContain('waiting for the release window')
    const button = [...document.querySelectorAll<HTMLButtonElement>('.task-card button')].find((item) => item.textContent === 'unpark…')
    // The feed can render the parked task before the park write has settled.
    expect(button?.disabled).toBe(false)
    return button!
  })
  unpark.click()
  await submitReason('why it can go ahead', 'the window opened')
  await vi.waitFor(() => expect(document.querySelector('.task-card .task-state')?.textContent).toBe('ready'))
})

it('offers Priority, Park and Cancel but no lease actions on another actor’s claimed task; Answer follows a hold', async () => {
  const { as, client, open } = await workbench({ attentionResponders: { work: ['vercel:user:u_reader'] } })
  const { task } = await client.tasks.create('work', { text: 'Review the release' })
  const worker = as('worker')
  const { token, epoch } = await worker.tasks.claim(task.id)
  await open(`/?thread=${task.id}`)
  await vi.waitFor(() => {
    expect(document.querySelector('.task-card .task-state')?.textContent).toBe('claimed')
    expect(document.querySelector('.task-card .task-head')?.textContent).toContain('by worker')
  })
  button('more').click()
  await vi.waitFor(() => {
    for (const action of ['change priority…', 'park…', 'cancel the task…']) menuItem(action)
    const controls = [...document.querySelectorAll('.task-card button, [role="menuitem"]')]
    const names = controls.flatMap((el) => [el.textContent, el.getAttribute('title'), el.getAttribute('aria-label')])
    expect(names.join(' ')).not.toMatch(/\b(claim|renew|release|complete|answer)\b/i)
  })
  // A structured attention request ends the claim; only then can a person be offered Answer.
  await worker.tasks.ask(task.id, {
    claim: { token, epoch }, kind: 'awaiting_approval', question: 'Release this commit?', context: 'Checks passed.',
    options: [
      { id: 'proceed', label: 'Proceed', consequence: 'Resume work', next: 'resume' },
      { id: 'revise', label: 'Revise', consequence: 'Make changes first', next: 'resume' },
    ],
    revision: task.revision, evidence: [{ message: task.id, revision: task.revision }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), commit: 'a'.repeat(40),
  })
  await vi.waitFor(() => {
    expect(document.querySelector('.task-card .task-state')?.textContent).toBe('blocked')
    expect([...document.querySelectorAll('.task-card button')].map((el) => el.textContent)).toContain('answer…')
  })
})

it('clears blind schedules on profile switch and ignores a late list', async () => {
  const { as, open } = await workbench()
  const codexReady = Promise.withResolvers<void>()
  const codex = Promise.withResolvers<void>()
  const grok = Promise.withResolvers<void>()
  // In work each profile can post but not read, so it lists only its own blind schedules.
  const can = '*=read;work=post'
  await as('claude', can).schedule('work', { text: 'Private Claude reminder', in: '1d' })
  await as('codex', can).schedule('work', { text: 'Private Codex reminder', in: '1d' })
  await as('grok', can).schedule('work', { text: 'Private Grok reminder', in: '1d' })
  await open('/settings/schedules', {
    profile: 'claude', can,
    holdSchedules: (profile) => {
      if (profile === 'codex') {
        codexReady.resolve()
        return codex.promise
      }
      if (profile === 'grok') return grok.promise
    },
  })
  try {
    await vi.waitFor(() => expect(mainText()).toContain('Private Claude reminder'))
    await switchProfile('codex')
    expect(mainText()).not.toContain('Private Claude reminder')
    expect(mainText()).toContain('loading…')

    await codexReady.promise
    await switchProfile('grok')
    await act(async () => codex.resolve())
    expect(mainText()).not.toContain('Private Codex reminder')
    expect(mainText()).toContain('loading…')

    grok.resolve()
    await vi.waitFor(() => {
      expect(mainText()).toContain('Private Grok reminder')
      expect(mainText()).not.toContain('Private Claude reminder')
      expect(mainText()).not.toContain('Private Codex reminder')
    })
  } finally {
    codex.resolve()
    grok.resolve()
  }
})

it('offers Cancel only to the schedule creator or a channel manager', async () => {
  const { as, open } = await workbench()
  const creator = as('claude')
  const thread = await creator.post('work', 'Release review')
  await creator.schedule({ re: thread.id }, { text: 'Review tomorrow', in: '1d' })
  await creator.schedule('managed', { text: 'Send status', in: '1d' })
  await creator.schedule('readonly', { text: 'Post results', in: '1d' })
  await open('/settings/schedules', { profile: 'codex', can: '*=read,post;managed=read,post,manage;readonly=read' })
  const cancel = (text: string) => {
    const row = [...document.querySelectorAll('main .sched-row')].find((el) => el.textContent?.includes(text))
    expect(row, text).toBeDefined()
    return row!.querySelector('button')?.textContent
  }
  await vi.waitFor(() => {
    expect(cancel('Review tomorrow')).toBeUndefined()
    expect(cancel('Send status')).toBe('cancel')
    expect(cancel('Post results')).toBeUndefined()
  })
  link('reply in #work').click()
  const threadCancel = () => {
    const scheduled = [...document.querySelectorAll('aside[aria-label="Thread"] dd')].find((el) => el.textContent?.includes('Review tomorrow'))
    expect(scheduled).toBeDefined()
    return scheduled!.querySelector('button')?.textContent?.trim()
  }
  await vi.waitFor(() => expect(threadCancel()).toBeUndefined())
  await switchProfile('claude')
  await vi.waitFor(() => {
    expect(cancel('Review tomorrow')).toBe('cancel')
    expect(cancel('Post results')).toBeUndefined()
    expect(threadCancel()).toBe('cancel')
  })
})

it('opens Sync from Settings and shows the selected inbox', async () => {
  const { adapter } = fakePlatform('slack')
  const { api, open } = await workbench({ sync: { alerts: slack({ adapter }, () => {}), support: slack({ adapter }, () => {}) } })
  const inbound = await api.fetch(new Request(`${BOARD_URL}/webhooks/support`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'Can someone check my invoice?', user: 'U_ADA' }),
  }))
  expect(inbound.ok).toBe(true)
  await open('/settings/access')
  const sync = await vi.waitFor(() => link('sync'))
  sync.click()
  const support = await vi.waitFor(() => link('support slack'))
  support.click()
  await vi.waitFor(() => expect(mainText()).toContain('Can someone check my invoice?'))
})

const responders = { work: ['vercel:user:u_reader'] }
const commit = 'a'.repeat(40)
const question = '<img src=x onerror=alert(1)>'
const staleWords = 'the attention request or its snapshot is no longer current'
const unsupportedWords = 'this board does not keep task attention requests'
const readOnlyWords = 'answering needs a person acting as themselves with post access'
const inboxLink = () => document.querySelector<HTMLAnchorElement>('a[href="/attention"]')!
const inboxCount = () => inboxLink().querySelector('.count')?.textContent
const attentionList = () => document.querySelector<HTMLElement>('[aria-label="attention requests"]')!
const decision = (id: string) => document.getElementById(`attention-${id}`)!
const choice = (id: string) => decision(id)?.querySelector<HTMLButtonElement>('button.attention-choice')
const selectedDecision = () => attentionList().querySelector('[aria-current="true"]')?.id
const threadPane = () => document.querySelector('aside[aria-label="Thread"]')
const unblockButton = () => [...(threadPane()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'unblock')
const attentionRead = (r: Request) => r.method === 'GET' && r.url.endsWith('/attention')
const answerWrite = (r: Request) => r.method === 'POST' && r.url.endsWith('/answer')
const isFeed = (r: Request) => {
  const url = new URL(r.url)
  return url.pathname.endsWith('/events') && Number(url.searchParams.get('wait')) > 0
}
const gate = () => {
  const g = Promise.withResolvers<void>()
  releaseGates.push(g.resolve)
  return g
}

async function hold(client: ReturnType<typeof createBoardClient>, text: string, question: string) {
  const { task } = await client.tasks.create('work', { text })
  const draft = {
    kind: 'awaiting_approval', question, context: 'The wording has been reviewed.',
    options: [
      { id: 'ship', label: 'Ship it', consequence: 'Publish the revised docs', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Keep the current docs', next: 'fail' },
    ],
    evidence: [{ message: task.id, revision: task.revision }], revision: task.revision, commit,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as const
  const request = { ...draft, options: [...draft.options], evidence: [...draft.evidence] }
  const { attention } = await client.tasks.ask(task.id, request)
  return { id: task.id, attention, request }
}

it.each([
  ['upcoming', -45_000, '45s left'],
  ['past', 45_000, '45s ago'],
] as const)('shows the %s attention deadline relatively with its local timestamp on hover', async (_status, offset, expected) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const { id, attention: { expiresAt } } = await hold(client, 'Draft for review', 'Ship the draft?')
  vi.setSystemTime(Date.parse(expiresAt) + offset)
  await open('/attention')
  await vi.waitFor(() => {
    const time = decision(id)?.querySelector(`time[datetime="${expiresAt}"]`)
    expect(time?.textContent).toBe(expected)
    expect(time?.getAttribute('title')).toBe(new Date(expiresAt).toLocaleString())
  })
})

function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  flushSync(() => target.dispatchEvent(event))
  return event.defaultPrevented
}

it('opens Attention from the sidebar, counts only holds, escapes questions, and applies each allowed read as it arrives', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  await client.tasks.create('work', { text: 'A ready task' })
  const a = await hold(client, 'First draft', question)
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  const release = gate()
  const reads: string[] = []
  await open('/handoffs', { transport: async (r, send) => {
    const response = await send()
    if (attentionRead(r)) {
      reads.push(r.url)
      if (r.url.endsWith(`/${a.id}/attention`)) await release.promise
    }
    return response
  } })
  await vi.waitFor(() => expect(inboxCount()).toBe('2'))
  expect(reads).toEqual([])
  inboxLink().click()
  await vi.waitFor(() => expect(choice(b.id)?.disabled).toBe(false))
  expect(location.pathname).toBe('/attention')
  expect(inboxLink().getAttribute('aria-current')).toBe('page')
  expect(decision(a.id).textContent).toContain('reading request')
  expect([...attentionList().querySelectorAll('article')].map((row) => row.id)).toEqual([`attention-${a.id}`, `attention-${b.id}`])
  release.resolve()
  await vi.waitFor(() => expect(decision(a.id).querySelector('.attention-question')?.textContent).toBe(question))
  expect(decision(a.id).querySelector('img')).toBeNull()
  decision(a.id).querySelector('a')!.click()
  await vi.waitFor(() => expect(document.querySelector('aside[aria-label="Thread"]')?.textContent).toContain('First draft'))
  expect([...document.querySelectorAll('aside[aria-label="Thread"] button')].some((button) => button.textContent === 'unblock')).toBe(false)
  expect(reads).toHaveLength(2)
  link('Handoffs').click()
  const c = await hold(client, 'Third draft', 'Use the third draft?')
  await vi.waitFor(() => expect(inboxCount()).toBe('3'))
  expect(reads).toHaveLength(2)
  inboxLink().click()
  await vi.waitFor(() => expect(choice(c.id)?.disabled).toBe(false))
  const d = await hold(client, 'Fourth draft', 'Use the fourth draft?')
  await vi.waitFor(() => expect(choice(d.id)?.disabled).toBe(false))
})

it('ignores an Attention refusal that arrives after switching to a responder', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const unsupported = localBoard()
  otherBoards.push(unsupported)
  const a = await hold(client, 'First draft', 'Use this draft?')
  const captured = gate()
  const release = gate()
  await open('/attention', { profile: 'reviewer', transport: async (r, send) => {
    if (!attentionRead(r) || r.headers.get('x-board-profile') !== 'reviewer') return send()
    const refused = await unsupported.fetch(r)
    expect(refused.status).toBe(501)
    captured.resolve()
    await release.promise
    return refused
  } })
  await captured.promise
  link('settings').click()
  const developer = await vi.waitFor(() => {
    const details = document.querySelector<HTMLDetailsElement>('details.developer-identity')
    expect(details).not.toBeNull()
    return details!
  })
  developer.querySelector('summary')!.click()
  button('post as').click()
  const yourself = await vi.waitFor(() => menuItem('act as yourself'))
  yourself.click()
  const me = await client.me()
  await vi.waitFor(() => expect(document.querySelector('.sidebar-foot')?.textContent).toContain(`acting as ${me.name}`))
  inboxLink().click()
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  await act(async () => release.resolve())
  expect(choice(a.id)?.disabled).toBe(false)
})

it('lets j/k from the focused empty Attention list reach the open thread composer', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const { task } = await client.tasks.create('work', { text: 'Check the title' })
  await open(`/attention?thread=${task.id}`)
  const reply = await vi.waitFor(() => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[data-composer="thread"]')
    expect(field).not.toBeNull()
    return field!
  })
  expect(inboxCount()).toBeUndefined()
  for (const key of ['j', 'k']) {
    attentionList().focus()
    expect(press(attentionList(), key)).toBe(false)
    expect(document.activeElement).toBe(reply)
  }
})

it('consumes only real moves and enabled digits, and requires reselection after a replacement or removal', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use the first draft?')
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  await open('/attention')
  await vi.waitFor(() => expect(choice(b.id)?.disabled).toBe(false))
  const list = attentionList()
  list.focus()
  expect(press(list, '1')).toBe(false)
  expect(press(list, 'j')).toBe(true)
  expect(selectedDecision()).toBe(`attention-${a.id}`)
  expect(press(list, 'k')).toBe(false)
  expect(press(list, 'j')).toBe(true)
  expect(selectedDecision()).toBe(`attention-${b.id}`)
  expect(press(list, '3')).toBe(false)
  choice(b.id)!.focus()
  expect(press(choice(b.id)!, '1')).toBe(false)
  expect(press(list, '1')).toBe(false)
  list.focus()
  await client.tasks.ask(b.id, { ...b.request, question: 'Use the replacement?', replaces: b.attention.id })
  await vi.waitFor(() => expect(decision(b.id).textContent).toContain('Use the replacement?'))
  expect(selectedDecision()).toBeUndefined()
  expect(press(list, '1')).toBe(false)
  expect(press(list, 'k')).toBe(true)
  expect(selectedDecision()).toBe(`attention-${b.id}`)
  expect(press(list, '2')).toBe(true)
  await vi.waitFor(() => expect(decision(b.id).textContent).toContain('answered · Stop'))
  expect((await client.tasks.attention(b.id)).attention).toMatchObject({ status: 'answered', receipt: { option: 'stop' } })
  expect(selectedDecision()).toBeUndefined()
  expect(press(list, '1')).toBe(false)
  expect(inboxCount()).toBe('1')
  expect(press(list, 'j')).toBe(true)
  await client.tasks.cancel(a.id, 'superseded')
  await vi.waitFor(() => expect(decision(a.id)).toBeNull())
  expect(selectedDecision()).toBeUndefined()
  expect(inboxCount()).toBeUndefined()
})

it.each(['profile', 'deployment', 'read only', 'no discovery'] as const)('explains why Attention is read only with %s', async (identity) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  await open('/attention', {
    ...(identity === 'profile' ? { profile: 'reviewer' } : {}),
    ...(identity === 'deployment' ? { token: await deploymentToken('marketing', 'prj_marketing', 'production', { audience: BOARD_URL }) } : {}),
    ...(identity === 'read only' ? { can: '*=read' } : {}),
    transport: async (r, send) => {
      const response = await send()
      if (identity !== 'no discovery' || r.url.replace(/\/$/, '') !== BOARD_URL) return response
      const { task_attention: _, ...discovery } = await response.json()
      return Response.json(discovery)
    },
  })
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(`read only: ${identity === 'no discovery' ? unsupportedWords : readOnlyWords}`))
  expect(decision(a.id).textContent).toContain('Use this draft?')
  expect(choice(a.id)).toBeNull()
  attentionList().focus()
  expect(press(attentionList(), 'j')).toBe(true)
  expect(press(attentionList(), '1')).toBe(false)
})

it.each([403, 409] as const)('shows the board’s %i write refusal without an extra read', async (status) => {
  const { client, open } = await workbench({ attentionResponders: status === 403 ? { work: ['vercel:user:u_other'] } : responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  let reads = 0
  const answer = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    const response = await send()
    if (attentionRead(r)) reads++
    if (answerWrite(r)) answer.resolve(response.status)
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  if (status === 409) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(a.attention.expiresAt) + 1)
  }
  choice(a.id)!.click()
  expect(await answer.promise).toBe(status)
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain(status === 409 ? staleWords : 'only a configured responder acting as themselves with read and post access can answer task attention'))
  expect(decision(a.id).textContent).not.toContain('answering')
  expect(choice(a.id)?.disabled).toBe(true)
  expect(reads).toBe(1)
})

it.each(['read', 'write'] as const)('shows a real 501 on %s and offers no answer', async (operation) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const unsupported = localBoard()
  otherBoards.push(unsupported)
  const a = await hold(client, 'First draft', 'Use this draft?')
  const refused = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    if (!(operation === 'read' ? attentionRead(r) : answerWrite(r))) return send()
    const response = await unsupported.fetch(r)
    refused.resolve(response.status)
    return response
  } })
  if (operation === 'write') {
    await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
    choice(a.id)!.click()
  }
  expect(await refused.promise).toBe(501)
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(unsupportedWords))
  expect(choice(a.id)).toBeNull()
})

it('flags an unseen 404 off-view, renders its words, then unlocks the same request on navigation refresh', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const empty = localBoard({ attentionResponders: responders })
  otherBoards.push(empty)
  const a = await hold(client, 'First draft', 'Use this draft?')
  const writing = Promise.withResolvers<number>()
  const releaseWrite = gate()
  const releaseRead = gate()
  let reads = 0
  await open('/attention', { transport: async (r, send) => {
    if (answerWrite(r)) {
      const response = await empty.fetch(r)
      writing.resolve(response.status)
      await releaseWrite.promise
      return response
    }
    const response = await send()
    if (attentionRead(r) && ++reads === 2) await releaseRead.promise
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  expect(await writing.promise).toBe(404)
  link('Handoffs').click()
  await vi.waitFor(() => expect(location.pathname).toBe('/handoffs'))
  releaseWrite.resolve()
  await vi.waitFor(() => expect(inboxLink().textContent).toContain('refused'))
  expect(reads).toBe(1)
  inboxLink().click()
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(`message not found: #${a.id}`))
  await vi.waitFor(() => expect(inboxLink().textContent).not.toContain('refused'))
  expect(choice(a.id)?.disabled).toBe(true)
  releaseRead.resolve()
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  expect((await client.tasks.attention(a.id)).attention?.id).toBe(a.attention.id)
})

it.each(['feed', 'thread'] as const)('clears an unseen refusal for A when a newer %s root shows B, even if the attention read fails', async (source) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const empty = localBoard({ attentionResponders: responders })
  otherBoards.push(empty)
  const a = await hold(client, 'Draft for review', 'Use A?')
  const beforeAnswer = gate()
  const feed = gate()
  const writing = Promise.withResolvers<number>()
  const refusedRead = Promise.withResolvers<string>()
  const listed = gate()
  let replace = false
  await open('/attention', { transport: async (r, send) => {
    if (source === 'thread' && isFeed(r)) await feed.promise
    if (answerWrite(r)) {
      await beforeAnswer.promise
      const response = await (source === 'feed' ? empty.fetch(r) : send())
      writing.resolve(response.status)
      return response
    }
    if (replace && attentionRead(r)) {
      const response = await empty.fetch(r)
      refusedRead.resolve((await response.clone().json()).error.message)
      return response
    }
    const response = await send()
    if (r.method === 'GET' && new URL(r.url).pathname.endsWith('/tasks') && new URL(r.url).searchParams.get('state') === 'all') listed.resolve()
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  link('Handoffs').click()
  const thread = await vi.waitFor(() => link('Draft for review', lane('Needs attention')))
  await listed.promise
  const replaceA = () => client.tasks.ask(a.id, { ...a.request, question: 'Use B?', replaces: a.attention.id })
  // Until an accepted root shows B, the refused write belongs to the A the page saw.
  if (source === 'thread') await replaceA()
  beforeAnswer.resolve()
  expect(await writing.promise).toBe(source === 'thread' ? 409 : 404)
  await vi.waitFor(() => expect(inboxLink().textContent).toContain('refused'))
  if (source === 'thread') thread.click()
  else await replaceA()
  await vi.waitFor(() => expect(inboxLink().textContent).not.toContain('refused'))
  replace = true
  inboxLink().click()
  const words = await refusedRead.promise
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain(words))
  expect(decision(a.id).textContent).not.toContain(staleWords)
  expect(inboxLink().textContent).not.toContain('refused')
})

it.each(['before', 'after'] as const)('ignores a superseded read that arrives %s the newer response', async (order) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const pending = [0, 1].map(() => ({ captured: gate(), release: gate() }))
  let reads = 0
  await open('/attention', { transport: async (r, send) => {
    const response = await send()
    if (attentionRead(r)) {
      const read = pending[reads++]!
      read.captured.resolve()
      await read.release.promise
    }
    return response
  } })
  await pending[0]!.captured.promise
  link('Handoffs').click()
  await vi.waitFor(() => expect(location.pathname).toBe('/handoffs'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(a.attention.expiresAt) + 1)
  inboxLink().click()
  await pending[1]!.captured.promise
  if (order === 'before') {
    await act(async () => pending[0]!.release.resolve())
    expect(decision(a.id).textContent).toContain('reading request')
  }
  pending[1]!.release.resolve()
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain('read only: the request is stale'))
  await act(async () => pending[0]!.release.resolve())
  expect(decision(a.id).textContent).toContain('read only: the request is stale')
})

it('settles Ship it from the feed without rolling back a newer thread hold', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const feed = gate()
  const answer = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    if (isFeed(r)) await feed.promise
    const response = await send()
    if (answerWrite(r)) answer.resolve(response.status)
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  expect(await answer.promise).toBe(200)
  await client.tasks.block(a.id, 'Wait for translation')
  decision(a.id).querySelector('a')!.click()
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Wait for translation'))
  expect(decision(a.id).textContent).toContain('answering Ship it')
  feed.resolve()
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain('answered · Ship it'))
  expect(decision(a.id).textContent).not.toContain('answering')
  expect(threadPane()?.textContent).toContain('Wait for translation')
  expect(inboxCount()).toBeUndefined()
})

it.each(['same request', 'replacement'] as const)('scopes a late competing 409 to its receipt: %s', async (scenario) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const sendAnswer = gate()
  const releaseRefusal = gate()
  const refused = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    if (!answerWrite(r)) return send()
    await sendAnswer.promise
    const response = await send()
    refused.resolve(response.status)
    await releaseRefusal.promise
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  await client.tasks.answer(a.id, a.attention.id, { option: 'stop', commit })
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain('answered · Stop'))
  sendAnswer.resolve()
  expect(await refused.promise).toBe(409)
  if (scenario === 'replacement') {
    await client.tasks.reopen(a.id)
    await client.tasks.ask(a.id, { ...a.request, question: 'Use the replacement?' })
    await vi.waitFor(() => expect(decision(a.id).textContent).toContain('Use the replacement?'))
  }
  await act(async () => releaseRefusal.resolve())
  if (scenario === 'same request') {
    await vi.waitFor(() => expect(decision(a.id).textContent).toContain(staleWords))
    expect(decision(a.id).textContent).toContain('answered · Stop')
    expect(choice(a.id)).toBeNull()
  } else {
    expect(decision(a.id).textContent).not.toContain(staleWords)
    expect(inboxLink().textContent).not.toContain('refused')
    expect(choice(a.id)?.disabled).toBe(false)
  }
})

it('offers a working unblock for a plain hold after an answered request', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  await client.tasks.answer(a.id, a.attention.id, { option: 'ship', commit })
  const root = await client.tasks.block(a.id, 'Wait for translation')
  expect(root.task?.attentionId).toBe(a.attention.id)
  await open(`/attention?thread=${a.id}`)
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Wait for translation'))
  expect(unblockButton()).toBeDefined()
  unblockButton()!.click()
  await vi.waitFor(() => expect(threadPane()?.textContent).not.toContain('Wait for translation'))
  expect((await client.tasks.list({ state: 'ready' })).tasks.map(({ message }) => message.id)).toContain(a.id)
})

it('keeps a stale request read-only without offering an unblock the board refuses', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(a.attention.expiresAt) + 1)
  await expect(client.tasks.unblock(a.id)).rejects.toMatchObject({ status: 409, code: 'attention_required' })
  await open(`/attention?thread=${a.id}`)
  await vi.waitFor(() => expect(decision(a.id)?.textContent).toContain('read only: the request is stale'))
  await vi.waitFor(() => expect(threadPane()?.textContent).toContain('Use this draft?'))
  expect(unblockButton()).toBeUndefined()
  expect(choice(a.id)).toBeNull()
})

it.each(['read', 'write'] as const)('hides all answer buttons on a 501 with a different code from %s', async (operation) => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const b = await hold(client, 'Second draft', 'Use the second draft?')
  const release = gate()
  const words = 'this deployment has not enabled attention'
  await open('/attention', { transport: async (r, send) => {
    const refused = operation === 'read' ? attentionRead(r) && r.url.endsWith(`/${a.id}/attention`) : answerWrite(r)
    if (!refused) return send()
    await release.promise
    // Model a backend with a different 501 code; all other traffic goes to the local board.
    return Response.json({ error: { code: 'not_implemented', message: words } }, { status: 501 })
  } })
  await vi.waitFor(() => expect(choice(b.id)?.disabled).toBe(false))
  if (operation === 'write') {
    await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
    choice(a.id)!.click()
  }
  release.resolve()
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain(words))
  expect(choice(a.id)).toBeNull()
  expect(choice(b.id)).toBeNull()
})

it('keeps the answering overlay after HTTP success until the real feed confirms', async () => {
  const { client, open } = await workbench({ attentionResponders: responders })
  const a = await hold(client, 'First draft', 'Use this draft?')
  const feed = gate()
  const answer = Promise.withResolvers<number>()
  await open('/attention', { transport: async (r, send) => {
    if (isFeed(r)) await feed.promise
    const response = await send()
    if (answerWrite(r)) answer.resolve(response.status)
    return response
  } })
  await vi.waitFor(() => expect(choice(a.id)?.disabled).toBe(false))
  choice(a.id)!.click()
  expect(await answer.promise).toBe(200)
  expect((await client.tasks.attention(a.id)).attention?.status).toBe('answered')
  expect(decision(a.id).textContent).toContain('answering Ship it')
  expect(choice(a.id)?.disabled).toBe(true)
  expect(inboxCount()).toBe('1')
  feed.resolve()
  await vi.waitFor(() => expect(decision(a.id).textContent).toContain('answered · Ship it'))
  expect(inboxCount()).toBeUndefined()
})
