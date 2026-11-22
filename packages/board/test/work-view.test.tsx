// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { shell } from '../src/inspect/shell.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'

const browser = (window as unknown as import('happy-dom').Window).happyDOM
let visit = 0
let root: Root | undefined
let close: (() => Promise<void>) | undefined

afterEach(async () => {
  root?.unmount()
  await close?.()
  root = undefined
  close = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

// Substitute only the browser-to-proxy transport; reads, writes and live events use the local board.
async function workBoard() {
  const api = localBoard()
  const page = new AbortController()
  const streamClosed = Promise.withResolvers<void>()
  let streaming = false
  close = async () => {
    page.abort()
    if (streaming) await streamClosed.promise
    await api.close()
  }
  const token = await personToken('u_reader', BOARD_URL)
  const clientFor = (token: string) => createBoardClient({ url: BOARD_URL, token, profile: null, fetch: (input, init) => api.fetch(new Request(input, init)) })
  const client = clientFor(token)
  return {
    create: (workId: number | string, text: string, options: { claim?: boolean; priority?: 'urgent'; party?: string } = {}) => {
      const { party = 'blue', ...task } = options
      return client.tasks.create('work', { text, labels: { 'work.id': typeof workId === 'number' ? `wp-${workId}` : workId, party }, ...task })
    },
    client,
    actor: async (id: string) => clientFor(await personToken(id, BOARD_URL)),
    async open(params = '') {
      browser.setViewport({ width: 1280, height: 900 })
      browser.setURL(`http://work-${++visit}.test/work${params}`)
      const html = new DOMParser().parseFromString(shell({ token: 'inspector-test', base: '', profile: null, named: false }), 'text/html')
      document.head.replaceChildren(...html.head.querySelectorAll('meta, style'))
      document.body.innerHTML = '<div id="root"></div>'
      const proxy = `${location.origin}/board`
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const isStream = request.url.startsWith(`${proxy}/events?`)
        if (page.signal.aborted || (request.url !== proxy && !request.url.startsWith(`${proxy}/`))) {
          if (isStream) streamClosed.resolve()
          return Response.json({ error: { code: 'closed', message: 'page closed' } }, { status: 403 })
        }
        if (isStream) streaming = true
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${token}`)
        return api.fetch(new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: AbortSignal.any([page.signal, request.signal]),
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        }))
      })
      vi.resetModules()
      const { App } = await import('../src/inspect/app/App.tsx')
      const mounted = root = createRoot(document.getElementById('root')!)
      flushSync(() => mounted.render(<App />))
    },
  }
}

const queue = () => [...document.querySelectorAll('main h2')].find((h) => h.textContent === 'Queue')!.parentElement!
const headings = () => [...queue().querySelectorAll('h3')].map((h) => h.textContent!.split(' (')[0])
const taskLinks = () => [...queue().querySelectorAll<HTMLAnchorElement>('li a')]
const titles = () => taskLinks().map((link) => link.textContent)
const peek = () => document.querySelector('main aside[aria-label="Work peek"]')

it('keeps the four home sections in order and shows an empty message in each', async () => {
  const { open } = await workBoard()
  await open()
  await vi.waitFor(() => {
    expect([...document.querySelectorAll('main section h2')].map((heading) => [
      heading.textContent,
      heading.closest('section')?.querySelector('[role="status"]')?.textContent,
    ])).toEqual([
      ['Needs you', 'nothing needs you'],
      ['Ready to review', 'nothing to review'],
      ['Running now', 'nothing running'],
      ['Health and spend', 'no health data'],
    ])
  })
})

it('shows known spend alongside two unknown tasks and never presents a missing claim limit as zero', async () => {
  const { create, open } = await workBoard()
  await create('plb-3', 'Metered task', { party: 'unmetered-limit' })
  await create('plb-1', 'Unknown telemetry', { party: 'unmetered-limit' })
  await create('plb-5', 'No telemetry', { party: 'unmetered-limit' })
  await open('?swarm=fixtures')
  await vi.waitFor(() => {
    const rows = [...document.querySelectorAll<HTMLTableRowElement>('main table tr')]
    for (const name of ['unmetered-limit', 'Repo total']) {
      const row = rows.find((row) => row.querySelector('th[scope="row"]')?.textContent === name)
      const cells = [...(row?.cells ?? [])].map((cell) => cell.textContent)
      expect(cells, name).toContain('0 / limit unknown')
      expect(cells, name).toContain('81000 known · 2 unknown')
    }
  })
})

it('opens peek from the URL with absolute claim time, tracker badges and overlap, and clears peek on close', async () => {
  const { create, open } = await workBoard()
  const { task } = await create('plb-6', 'Inspect the overlap', { claim: true })
  await open(`?swarm=fixtures&peek=${task.id}`)
  await vi.waitFor(() => {
    const pane = peek()
    expect(pane?.querySelector('h2')?.textContent).toBe('Inspect the overlap')
    expect(pane?.querySelector('time')?.textContent).toBe(task.task!.claim!.until)
    expect(pane?.textContent).toContain('bd rw-4u5')
    expect(pane?.textContent).toContain('#6')
    expect(pane?.textContent).toContain('branch with plb-5')
    expect(pane?.textContent).toContain('tracker item with plb-3')
  })

  peek()!.querySelector('button')!.click()
  await vi.waitFor(() => {
    expect(new URL(location.href).searchParams.has('peek')).toBe(false)
    expect(peek()).toBeNull()
  })
})

it('replaces a peeked task deleted live with only the no-longer-on-board message', async () => {
  const { create, client, open } = await workBoard()
  const { task } = await create('plb-2', 'Delete this build', { claim: true })
  await open(`?swarm=fixtures&peek=${task.id}`)
  await vi.waitFor(() => {
    const pane = peek()
    expect(pane?.querySelector('h2')?.textContent).toBe('Delete this build')
    expect(pane?.querySelector('time')?.textContent).toBe(task.task!.claim!.until)
    expect(pane?.textContent).toContain('PR #41')
    expect(pane?.textContent).toContain('142k tokens')
  })

  await client.delete(task.id)
  await vi.waitFor(() => {
    expect(peek()?.querySelector('[role="status"]')?.textContent).toBe('no longer on the board')
    expect(peek()?.textContent?.trim()).toBe('no longer on the board')
  })
})

it('/work shows populated groups and removes a deleted task and its now-empty group live', async () => {
  const { create, client, open } = await workBoard()
  const { task: running } = await create(1, 'Run the build', { claim: true })
  await create(2, 'Write release notes')
  await open()
  await vi.waitFor(() => {
    expect(document.querySelector('main h1')?.textContent).toBe('Work')
    expect(headings()).toEqual(['Running', 'Ready to pull'])
    expect(titles()).toEqual(['Run the build', 'Write release notes'])
    expect(taskLinks()[0]?.closest('li')?.textContent).toMatch(/wp-1.*blue/)
  })

  await client.delete(running.id)
  await vi.waitFor(() => {
    expect(titles()).toEqual(['Write release notes'])
    expect(headings()).toEqual(['Ready to pull'])
  })
})

it('keeps a focused queue row in place and peek content intact when urgent work arrives, then reorders on blur', async () => {
  const { create, open } = await workBoard()
  await create(1, 'Earlier task')
  const { task } = await create(2, 'Reading this task')
  await open(`?peek=${task.id}`)
  await vi.waitFor(() => {
    expect(titles()).toEqual(['Earlier task', 'Reading this task'])
    expect(peek()?.querySelector('h2')?.textContent).toBe('Reading this task')
  })
  const details = peek()!.textContent
  const reading = taskLinks()[1]!
  flushSync(() => reading.focus())
  expect(document.activeElement).toBe(reading)

  await create(3, 'Urgent arrival', { priority: 'urgent' })
  await vi.waitFor(() => expect(titles()).toContain('Urgent arrival'))
  expect(titles()).toEqual(['Earlier task', 'Reading this task', 'Urgent arrival'])
  expect(document.activeElement).toBe(reading)
  expect(peek()?.textContent).toBe(details)

  reading.blur()
  await vi.waitFor(() => expect(titles()).toEqual(['Urgent arrival', 'Earlier task', 'Reading this task']))
})

it('/work holds a focused row at the same viewport offset during live regrouping, but does not scroll after blur', async () => {
  const { create, actor, open } = await workBoard()
  const worker = await actor('u_worker')
  const { task: first } = await create(1, 'First ready task')
  await create(2, 'Reading this task')
  await open()
  await vi.waitFor(() => {
    expect(headings()).toEqual(['Ready to pull'])
    expect(titles()).toEqual(['First ready task', 'Reading this task'])
  })

  const queueRegion = queue()
  let scroll = queueRegion
  while (scroll.parentElement && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement
  scroll.scrollTop = 20
  const blockHeight = 40
  const getRect = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.matches('li') || !queueRegion.contains(this)) return getRect.call(this)
    // happy-dom has no layout: model the queue as equal-height group headings and rows.
    const blocks = [...queueRegion.querySelectorAll('h3, li')]
    return new DOMRect(0, blocks.indexOf(this) * blockHeight - scroll.scrollTop, 100, blockHeight)
  })
  const reading = taskLinks()[1]!
  const row = reading.closest('li')!
  flushSync(() => reading.focus())
  expect(document.activeElement).toBe(reading)
  const top = row.getBoundingClientRect().top

  const claim = await worker.tasks.claim(first.id)
  await vi.waitFor(() => expect(headings()).toEqual(['Running', 'Ready to pull']))
  expect(scroll.scrollTop).toBe(20 + blockHeight)
  expect(row.getBoundingClientRect().top).toBe(top)
  expect(document.activeElement).toBe(reading)

  flushSync(() => reading.blur())
  expect(document.activeElement).toBe(document.body)
  await claim.release()
  await vi.waitFor(() => expect(headings()).toEqual(['Ready to pull']))
  expect(scroll.scrollTop).toBe(20 + blockHeight)
  expect(row.getBoundingClientRect().top).toBe(top - blockHeight)
})
