// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import type { SwarmRecords } from '../src/inspect/app/work.ts'
import { shell } from '../src/inspect/shell.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'

const browser = (window as unknown as import('happy-dom').Window).happyDOM
let visit = 0
let root: Root | undefined
let close: (() => Promise<void>) | undefined
const releaseGates: (() => void)[] = []

afterEach(async () => {
  root?.unmount()
  for (const release of releaseGates.splice(0)) release()
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
  const writes: string[] = []
  return {
    writes,
    create: (workId: number | string, text: string, options: { claim?: boolean; priority?: 'urgent'; party?: string; needs?: string[] } = {}) => {
      const { party = 'blue', ...task } = options
      return client.tasks.create('work', { text, labels: { 'work.id': typeof workId === 'number' ? `wp-${workId}` : workId, party }, ...task })
    },
    client,
    actor: async (id: string) => clientFor(await personToken(id, BOARD_URL)),
    async open(params = '', openTasksResponse?: () => Promise<Response>, seed?: (records: SwarmRecords) => void) {
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
        if (request.method !== 'GET' && request.method !== 'HEAD') writes.push(request.method)
        const url = new URL(request.url)
        if (openTasksResponse && request.method === 'GET' && `${url.origin}${url.pathname}` === `${proxy}/tasks` && url.searchParams.get('state') === 'open') {
          return openTasksResponse()
        }
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${token}`)
        return api.fetch(new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: AbortSignal.any([page.signal, request.signal]),
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        }))
      })
      vi.resetModules()
      if (seed) seed((await import('../src/inspect/app/work-fixtures.ts')).fixtureRecords)
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
const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Filter work"]')!
const param = (name: string) => new URLSearchParams(location.search).get(name)
const statuses = () => [...document.querySelectorAll('main [role="status"]')].map((el) => el.textContent)
const row = (title: string) => taskLinks().find((link) => link.textContent === title)!.closest('li')!
const selected = () => taskLinks().find((link) => link.closest('li')?.getAttribute('aria-current') === 'true')?.textContent
const keyHelp = () => document.querySelector('[role="region"][aria-label="Work keyboard shortcuts"]')

function typeFilter(text: string) {
  const input = field()
  flushSync(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, modifiers: KeyboardEventInit = {}) {
  flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...modifiers,
  })))
}

it('shows only matching open rows and an explicit zero when a search finds none', async () => {
  const { create, open } = await workBoard()
  await create(1, 'Build release')
  await create(2, 'Build preview')
  const archived = await create(3, 'Archived release', { claim: true })
  await archived.claim!.complete()
  // Load a closed task in the thread, outside the Queue's open read.
  await open(`?thread=${archived.task.id}`)
  await vi.waitFor(() => {
    expect(document.querySelector('aside[aria-label="Thread"]')?.textContent).toContain('Archived release')
    expect(titles()).toEqual(['Build release', 'Build preview'])
  })

  typeFilter('build release')
  await vi.waitFor(() => {
    expect(titles()).toEqual(['Build release'])
    expect(statuses()).toContain('1 of 2 rows')
  })
  typeFilter('archived release')
  await vi.waitFor(() => {
    expect(titles()).toEqual([])
    expect(statuses()).toContain('0 of 2 rows')
    expect(statuses().join(' ')).toMatch(/no rows match/i)
  })
})

it('keeps the typed filter, its URL, and input focus when work arrives live', async () => {
  const { create, open } = await workBoard()
  await create(1, 'Build release')
  await create(2, 'Publish notes')
  await open()
  await vi.waitFor(() => expect(titles()).toEqual(['Build release', 'Publish notes']))

  typeFilter('build')
  await vi.waitFor(() => {
    expect(titles()).toEqual(['Build release'])
    expect(param('q')).toBe('build')
  })
  await create(3, 'Build preview')
  await vi.waitFor(() => {
    expect(titles()).toEqual(['Build release', 'Build preview'])
    expect(statuses()).toContain('2 of 3 rows')
  })
  expect(field().value).toBe('build')
  expect(param('q')).toBe('build')
  expect(document.activeElement).toBe(field())
})

it('defaults to all open groups and keeps a text search inside the selected saved view', async () => {
  const { create, open } = await workBoard()
  await create('plb-1', 'Deploy approval')
  await create('plb-2', 'Fix failed checks')
  await create('plb-3', 'Review patch')
  await create('plb-4', 'Deploy build', { claim: true })
  await create(5, 'Run benchmarks', { claim: true })
  const { task } = await create(6, 'Prepare package')
  await create(7, 'Publish package', { needs: [task.id] })
  await open('?swarm=fixtures')
  await vi.waitFor(() => expect(headings()).toEqual([
    'Needs you', 'Repair or reconcile', 'Ready to review', 'Running', 'Ready to pull', 'Waiting or parked',
  ]))

  const choose = (name: string) => [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Saved work views"] a')]
    .find((link) => link.textContent === name)!.click()
  choose('Exceptions')
  await vi.waitFor(() => {
    expect(param('view')).toBe('exceptions')
    expect(headings()).toEqual(['Needs you', 'Repair or reconcile'])
    expect(titles()).toEqual(['Deploy approval', 'Fix failed checks'])
  })
  choose('Live claims')
  await vi.waitFor(() => {
    expect(param('view')).toBe('live')
    expect(headings()).toEqual(['Running'])
    expect(titles().sort()).toEqual(['Deploy build', 'Run benchmarks'])
  })
  typeFilter('deploy')
  await vi.waitFor(() => expect(titles()).toEqual(['Deploy build']))
})

it('leaves typing and modified keys alone but lets bare shortcuts navigate visible work', async () => {
  const { create, open } = await workBoard()
  const { task: first } = await create(1, 'Build release', { priority: 'urgent' })
  await create(2, 'Publish notes', { priority: 'urgent' })
  const { task: last } = await create(3, 'Build preview')
  await open('?q=build')
  await vi.waitFor(() => expect(titles()).toEqual(['Build release', 'Build preview']))

  press('j')
  await vi.waitFor(() => expect(selected()).toBe('Build release'))
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    press('j', modifiers)
    expect(selected()).toBe('Build release')
    expect(document.activeElement).toBe(row('Build release'))
  }
  press('/')
  await vi.waitFor(() => expect(document.activeElement).toBe(field()))
  for (const key of ['j', 'k', 'g', '?', ' ', 'Enter']) {
    press(key)
    expect(selected(), key).toBe('Build release')
    expect(document.activeElement, key).toBe(field())
    expect(peek(), key).toBeNull()
    expect(param('peek'), key).toBeNull()
    expect(param('thread'), key).toBeNull()
    expect(keyHelp(), key).toBeNull()
  }

  flushSync(() => field().blur())
  press('j')
  await vi.waitFor(() => expect(selected()).toBe('Build preview'))
  press('k')
  await vi.waitFor(() => expect(selected()).toBe('Build release'))
  for (const dismiss of [' ', 'Escape']) {
    press(' ')
    await vi.waitFor(() => {
      expect(param('peek')).toBe(first.id)
      expect(peek()?.querySelector('h2')?.textContent).toBe('Build release')
    })
    press(dismiss)
    await vi.waitFor(() => {
      expect(param('peek')).toBeNull()
      expect(peek()).toBeNull()
    })
  }
  press('?')
  await vi.waitFor(() => expect(keyHelp()).not.toBeNull())
  press('j')
  press('Enter')
  await vi.waitFor(() => {
    expect(param('thread')).toBe(last.id)
    expect(document.querySelector('aside[aria-label="Thread"]')?.textContent).toContain('Build preview')
  })
})

it('jumps to queue groups and hides a collapsed group without removing its work', async () => {
  const { create, open } = await workBoard()
  await create('plb-1', 'Answer request')
  await create('plb-3', 'Review patch')
  await create('plb-4', 'Run the build', { claim: true })
  await create(5, 'Prepare package', { priority: 'urgent' })
  await create(6, 'Write release notes')
  await open('?swarm=fixtures&party=blue')
  const jumps = { n: 'Answer request', r: 'Review patch', u: 'Run the build', w: 'Prepare package' }
  const all = [...Object.values(jumps), 'Write release notes']
  await vi.waitFor(() => expect(titles()).toEqual(all))

  for (const [key, title] of Object.entries(jumps)) {
    press('g')
    press(key)
    await vi.waitFor(() => {
      expect(document.activeElement, key).toBe(row(title))
      expect(selected(), key).toBe(title)
    })
  }
  press('[')
  await vi.waitFor(() => {
    expect(titles()).toEqual(all.slice(0, 3))
    expect(statuses()).toContain('5 of 5 rows')
    expect(document.activeElement?.textContent).toMatch(/^Ready to pull \(2\)/)
  })
  press(']')
  await vi.waitFor(() => {
    expect(titles()).toEqual(all)
    expect(document.activeElement).toBe(row('Prepare package'))
  })
  press('g')
  press('q')
  await vi.waitFor(() => expect(document.activeElement).toBe(queue().querySelector('h2')))
})

it('opens only web links in new tabs and never sends a write from a work key', async () => {
  const { create, open, writes } = await workBoard()
  await create('plb-2', 'Fix failed checks')
  await create('plb-3', 'Review patch')
  await create(1, 'Task without links')
  await open('?swarm=fixtures', undefined, ({ observations }) => {
    observations['plb-2']!.urls = { evidence: 'http://example.com/checks' }
    observations['plb-3']!.urls!.evidence = 'javascript:'
  })
  const openTab = vi.spyOn(window, 'open').mockReturnValue(null)
  await vi.waitFor(() => expect(titles()).toEqual(['Fix failed checks', 'Review patch', 'Task without links']))
  press('j')
  press('e')
  press('j')
  press('o')
  press('p')
  press('e')
  press('j')
  for (const key of ['o', 'p', 'e']) press(key)
  expect(openTab.mock.calls).toEqual([
    ['http://example.com/checks', '_blank', 'noopener,noreferrer'],
    ['https://example.com/issues/812', '_blank', 'noopener,noreferrer'],
    ['https://example.com/pull/42', '_blank', 'noopener,noreferrer'],
  ])
  for (const key of ['c', 'x', 'd', 'r']) {
    // An unbound printable key may focus the filter; start each on the row.
    flushSync(() => row('Task without links').focus())
    press(key)
  }
  // Wait for a real browser-to-board round trip after the key handlers run.
  await create(2, 'Follow-up task')
  await vi.waitFor(() => expect(titles()).toContain('Follow-up task'))
  expect(writes).toEqual([])
})

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

it('shows loading then the task-list refusal in Queue and peek without presenting an empty Home', async () => {
  const { create, open } = await workBoard()
  const { task } = await create(1, 'Task the reader cannot load')
  const requested = Promise.withResolvers<void>()
  const respond = Promise.withResolvers<void>()
  releaseGates.push(respond.resolve)
  const refusal = 'This board cannot list open tasks'
  const expectNoEmptyBoard = () => {
    const text = document.querySelector('main')?.textContent
    expect(text).not.toMatch(/no longer on the board|nothing on the board|nothing needs you/)
    expect(text).not.toMatch(/0 (need you|ready to review|running|expiring in 30 min)/)
  }

  await open(`?peek=${task.id}`, async () => {
    requested.resolve()
    await respond.promise
    return Response.json({ error: { code: 'forbidden', message: refusal } }, { status: 403 })
  })
  await requested.promise
  await vi.waitFor(() => {
    expect(queue().querySelector('[role="status"]')?.textContent).toBe('loading…')
    expect(peek()?.textContent).toBe('loading…')
  })
  expectNoEmptyBoard()
  respond.resolve()

  await vi.waitFor(() => {
    expect(queue().querySelector('[role="status"]')?.textContent).toBe(refusal)
    expect(peek()?.textContent).toBe(refusal)
    expectNoEmptyBoard()
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

it('holds the focused queue row at its viewport offset when Running now gains a task with peek open', async () => {
  const { create, actor, open } = await workBoard()
  const worker = await actor('u_worker')
  const { task: first } = await create(1, 'First ready task')
  const { task: second } = await create(2, 'Reading this task')
  await open(`?peek=${second.id}`)
  const running = () => [...document.querySelectorAll('main section h2')]
    .find((heading) => heading.textContent === 'Running now')?.closest('section')
  await vi.waitFor(() => {
    expect(running()?.textContent).toContain('nothing running')
    expect(titles()).toEqual(['First ready task', 'Reading this task'])
    expect(peek()?.querySelector('h2')?.textContent).toBe('Reading this task')
  })

  const list = document.querySelector<HTMLElement>('[aria-label="Work board tasks"]')!
  let scroll = queue()
  while (scroll.parentElement && getComputedStyle(scroll).overflowY !== 'auto') scroll = scroll.parentElement
  scroll.scrollTop = 20
  const blockHeight = 40
  const getRect = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.matches('li') || !queue().contains(this)) return getRect.call(this)
    // happy-dom has no layout: include Home above the queue in the stubbed geometry.
    const blocks = [...list.querySelectorAll('h2, h3, h4, li')]
    return new DOMRect(0, blocks.indexOf(this) * blockHeight - scroll.scrollTop, 100, blockHeight)
  })
  const reading = taskLinks()[1]!
  const row = reading.closest('li')!
  flushSync(() => reading.focus())
  expect(document.activeElement).toBe(reading)
  const top = row.getBoundingClientRect().top

  await worker.tasks.claim(first.id)
  await vi.waitFor(() => {
    expect(running()?.querySelector('li a')?.textContent).toBe('First ready task')
    expect(headings()).toEqual(['Running', 'Ready to pull'])
    // Running now adds a party, claimant and row; the queue adds a group heading.
    expect(scroll.scrollTop).toBe(20 + 4 * blockHeight)
    expect(row.getBoundingClientRect().top).toBe(top)
    expect(document.activeElement).toBe(reading)
    expect(peek()?.querySelector('h2')?.textContent).toBe('Reading this task')
  })
})
