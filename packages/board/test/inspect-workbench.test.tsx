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
  const held = await make('Held, lease running', 'urgent')
  await worker.tasks.claim(held.id, { lease: 600 })

  await open('/tasks?state=ready&channel=work', { profile: 'worker' })
  const expected = [assigned.id, first.id, second.id, other.id, foreign.id]
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

async function revocableTasks() {
  const bench = await workbench()
  const { api, client } = bench
  const admin = createBoardClient({ url: BOARD_URL, token: await localUserToken('julian', BOARD_URL), fetch: (input, init) => api.fetch(new Request(input, init)) })
  const { task: secret } = await admin.tasks.create('secret', { text: 'Private task' })
  const { task: publicTask } = await client.tasks.create('work', { text: 'Shared task' })
  await admin.createGrant({ principals: [{ kind: 'everyone' }], can: { secret: [] } })
  const { grant } = await admin.createGrant({ principals: [{ kind: 'user', userId: 'u_reader' }], can: { secret: ['read'] } })
  return { ...bench, secret, publicTask, revoke: () => admin.revokeGrant(grant.id) }
}

it('drops a cached Ready row when a fresh task read omits it after revocation', async () => {
  const { client, open, secret, publicTask, revoke } = await revocableTasks()
  await open('/tasks?state=ready')
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  await revoke()
  expect((await client.tasks.list({ state: 'ready' })).tasks.map(({ message }) => message.id)).toEqual([publicTask.id])
  link('open', document.querySelector('main .tabs')!).click()
  await vi.waitFor(() => expect(location.search).toBe(''), taskRead)
  link('ready', document.querySelector('main .tabs')!).click()
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id]), taskRead)
}, 30_000)

it('drops a cached row when opening its thread is refused after revocation', async () => {
  const { client, open, secret, publicTask, revoke } = await revocableTasks()
  await open('/tasks?state=ready')
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id, secret.id]), taskRead)
  await revoke()
  await expect(client.thread(secret.id)).rejects.toMatchObject({ status: 404 })
  taskRows()[1]!.click()
  await vi.waitFor(() => expect(taskRowIds()).toEqual([publicTask.id]), taskRead)
  expect(document.body.textContent).not.toContain('Private task')
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
  // The thread pane updates independently, proving the live change arrived before blur.
  await vi.waitFor(() => expect([...document.querySelectorAll('dt')].find((el) => el.textContent === 'priority')?.nextElementSibling?.textContent).toBe('urgent'), taskRead)
  expect(taskRowIds()).toEqual([first.id, second.id])
  expect(taskRows()[1]).toBe(reading)
  expect(document.activeElement).toBe(reading)
  reading.blur()
  await vi.waitFor(() => expect(taskRowIds()).toEqual([second.id, first.id]), taskRead)
}, 30_000)

it('keeps a focused Handoff in its original lane when another reader claims it', async () => {
  const { api, as, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Review the release' })
  await open()
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
  await vi.waitFor(() => expect(document.querySelector('main h1')?.textContent).toBe('PRESIDIUM'))
  link('Handoffs').click()
  await vi.waitFor(() => expect(link('Review the release', lane('In progress'))).toBeDefined())
})

it('shows a completed task and its result in the Delivered lane', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Publish the release notes' })
  await (await api.tasks.claim(task.id)).complete('Release notes are live')
  await open()
  await vi.waitFor(() => {
    const delivered = lane('Delivered')
    expect(link('Publish the release notes', delivered)).toBeDefined()
    expect(delivered.textContent).toContain('Delivery: Release notes are live')
  })
})

it('PRESIDIUM shows totals from all task pages', async () => {
  const { api, open } = await workbench()
  // The local protocol caps reads at 200 tasks, so these require three pages.
  for (let offset = 0; offset < 401; offset += 50) {
    await api.tasks.createMany('work', Array.from({ length: Math.min(50, 401 - offset) }, (_, i) => ({ text: `Review item ${offset + i}` })))
  }
  await open('/presidium')
  await vi.waitFor(() => {
    const counts = document.querySelector('main [aria-label="Task counts"]')
    expect(counts?.textContent).toContain('401 ready')
  }, { timeout: 3000 })
})

it('typing over Handoffs focuses the open thread reply', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Check the build' })
  await open(`/?thread=${task.id}`)
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
  for (const [path, title] of [['/presidium', 'PRESIDIUM'], ['/c/work', '#work'], ['/tasks', 'tasks'], ['/attention', 'attention'], ['/settings/access', 'settings'], ['/', 'HANDOFFS']]) {
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

it('lets a person park and unpark an unheld ready task without offering to claim it', async () => {
  const { api, open } = await workbench()
  const { task } = await api.tasks.create('work', { text: 'Check the release' })
  await open(`/?thread=${task.id}`)
  await vi.waitFor(() => expect(document.querySelector('.task-card .task-state')?.textContent).toBe('ready'))
  await vi.waitFor(() => button('more')).then((more) => more.click())
  const park = await vi.waitFor(() => menuItem('park…'))
  expect([...document.querySelectorAll('.task-card button, [role="menuitem"]')].map((item) => item.textContent?.trim()).join(' ')).not.toMatch(/\b(renew|release|complete|claim)\b/i)
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
  await open('/', { transport: async (r, send) => {
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
  await vi.waitFor(() => expect(location.pathname).toBe('/'))
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
  await vi.waitFor(() => expect(location.pathname).toBe('/'))
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
