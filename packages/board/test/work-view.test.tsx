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
  const client = createBoardClient({ url: BOARD_URL, token, profile: null, fetch: (input, init) => api.fetch(new Request(input, init)) })
  return {
    create: (n: number, text: string, options: { claim?: boolean; priority?: 'urgent' } = {}) =>
      client.tasks.create('work', { text, labels: { 'work.id': `wp-${n}`, party: 'blue' }, ...options }),
    client,
    async open() {
      browser.setViewport({ width: 1280, height: 900 })
      browser.setURL(`http://work-${++visit}.test/work`)
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

const headings = () => [...document.querySelectorAll('main section h2')].map((h) => h.textContent!.split(' (')[0])
const taskLinks = () => [...document.querySelectorAll<HTMLAnchorElement>('main section li a')]
const titles = () => taskLinks().map((link) => link.textContent)

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

it('keeps a focused row in place when urgent work arrives, then reorders on blur', async () => {
  const { create, open } = await workBoard()
  await create(1, 'Earlier task')
  await create(2, 'Reading this task')
  await open()
  await vi.waitFor(() => expect(titles()).toEqual(['Earlier task', 'Reading this task']))
  const reading = taskLinks()[1]!
  flushSync(() => reading.focus())
  expect(document.activeElement).toBe(reading)

  await create(3, 'Urgent arrival', { priority: 'urgent' })
  await vi.waitFor(() => expect(titles()).toContain('Urgent arrival'))
  expect(titles()).toEqual(['Earlier task', 'Reading this task', 'Urgent arrival'])
  expect(document.activeElement).toBe(reading)

  reading.blur()
  await vi.waitFor(() => expect(titles()).toEqual(['Urgent arrival', 'Earlier task', 'Reading this task']))
})
