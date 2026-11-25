// @vitest-environment happy-dom
import { act } from 'react'
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
  const closing = close?.()
  await vi.advanceTimersByTimeAsync(1_000).catch(() => undefined)
  vi.useRealTimers()
  await closing
  root = undefined
  close = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

// Substitute only the browser-to-proxy transport; reads, writes and live events use the local board.
async function workBoard(expiresIn = '1h') {
  const api = localBoard()
  const realTimeout = setTimeout
  const page = new AbortController()
  const streamClosed = Promise.withResolvers<void>()
  let streaming = false
  close = async () => {
    page.abort()
    const bound = (promise: Promise<unknown>) => Promise.race([
      promise,
      new Promise<void>((resolve) => { realTimeout(resolve, 200) }),
    ])
    if (streaming) await bound(streamClosed.promise)
    await bound(api.close())
  }
  const token = await personToken('u_reader', BOARD_URL, expiresIn)
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
    fresh: async () => clientFor(await personToken('u_reader', BOARD_URL, expiresIn)),
    raw: api.fetch.bind(api),
    actor: async (id: string) => clientFor(await personToken(id, BOARD_URL)),
    async open(address = '', openTasksResponse?: () => Promise<Response>, seed?: (records: SwarmRecords) => void, respond?: (request: Request) => Promise<Response | undefined> | Response | undefined, keepUrl = false) {
      browser.setViewport({ width: 1280, height: 900 })
      if (!keepUrl) browser.setURL(`http://work-${++visit}.test${address.startsWith('/') ? address : `/work${address}`}`)
      root?.unmount()
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
        const replaced = await respond?.(request)
        if (replaced) return replaced
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
const taskLinks = () => [...queue().querySelectorAll<HTMLAnchorElement>('li a[href*="thread="]')]
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

const mainTitle = () => document.querySelector('main h1')?.textContent
const boardAddress = new URL(BOARD_URL)
const link = (name: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLAnchorElement>('a')]
  .find((a) => a.textContent === name)
const sidebar = () => document.querySelector('.sidebar')!

function visitScope(path: string) {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

it('keeps Standing Committee rows and health in their own party and shows no work for an unknown party', async () => {
  const { create, open } = await workBoard()
  await create('plb-4', 'Build Blue release', { claim: true })
  await create('plb-2', 'Build rival release', { party: 'default', claim: true })
  await open('/party/blue?swarm=fixtures')
  await vi.waitFor(() => {
    expect(mainTitle()).toBe('Standing Committee')
    expect(titles()).toEqual(['Build Blue release'])
    const health = document.querySelector('main table')?.textContent
    expect(health).toMatch(/Blue Party.*1 \/ 2.*51000 known/)
    expect(health).not.toMatch(/People's Party|142000|193000/)
    expect(document.querySelector('main')?.textContent).not.toContain('Build rival release')
  })

  visitScope('/party/unknown?swarm=fixtures')
  await vi.waitFor(() => {
    expect(statuses()).toContain('no party with that id')
    expect(document.querySelector('main li a[href*="thread="]')).toBeNull()
  })
})

it('asks which party to use in Presidium, reveals rival claims on request, and shows real work without swarm records', async () => {
  const { create, actor, open } = await workBoard()
  const rival = await actor('u_rival')
  await create(1, 'Blue release')
  const { task } = await create(2, 'Rival release', { party: 'default' })
  await rival.tasks.claim(task.id)
  await open('/presidium?swarm=fixtures')
  const chooser = await vi.waitFor(() => {
    expect(mainTitle()).toBe('Presidium')
    expect(document.querySelector('main')?.textContent).toContain('choose a party:')
    expect(link("The People's Party", document.querySelector('main')!)).toBeDefined()
    const blue = link('Blue Party', document.querySelector('main')!)
    expect(blue).toBeDefined()
    return blue!
  })
  chooser.click()
  await vi.waitFor(() => expect(titles()).toEqual(['Blue release']))
  link('all parties')!.click()
  await vi.waitFor(() => {
    expect(titles().sort()).toEqual(['Blue release', 'Rival release'])
    expect(row('Rival release').textContent).toContain('u_rival')
  })

  visitScope('/presidium')
  await vi.waitFor(() => {
    expect(mainTitle()).toBe('Presidium')
    expect(document.querySelector('main')?.textContent).toContain(`${boardAddress.host} · ${boardAddress.pathname}`)
    expect(titles().sort()).toEqual(['Blue release', 'Rival release'])
  })
})

it('names only the Blue Presidium Chapter in the tab, header and sidebar, and keeps the plain subtitle', async () => {
  const { open } = await workBoard()
  await open('/presidium?party=blue&swarm=fixtures')
  for (const [party, name] of [['blue', 'Chapter'], ['default', 'Presidium']] as const) {
    if (party === 'default') visitScope('/presidium?party=default&swarm=fixtures')
    await vi.waitFor(() => {
      expect(mainTitle()).toBe(name)
      expect(document.title).toBe(`${name} · ${boardAddress.host}`)
      expect(document.querySelector('main header')?.textContent).toContain(`Presidium: ${boardAddress.host} repo`)
      const repoLink = link(name, sidebar())
      expect(repoLink?.pathname).toBe('/presidium')
      expect(new URL(repoLink!.href).searchParams.get('party')).toBe(party)
    })
  }
})

it('shows only the Cell claimant’s work and clock, PR and spend, without write controls even in its thread', async () => {
  const { create, actor, open } = await workBoard()
  const other = await actor('u_other')
  const mine = await create('plb-2', 'Repair my build', { claim: true })
  const theirs = await create(2, 'Repair another build')
  await other.tasks.claim(theirs.task.id)
  const claim = mine.task.task!.claim!
  await open(`/cell/${encodeURIComponent(claim.actor)}?party=blue&swarm=fixtures`)
  const expectNoWrites = (scope: ParentNode) => {
    const buttons = [...scope.querySelectorAll('button')].map((button) =>
      [button.getAttribute('aria-label'), button.title, button.textContent].filter(Boolean).join(' '))
    expect(buttons.join('\n')).not.toMatch(/\b(claim|release|accept|pause|resume)\b/i)
  }
  await vi.waitFor(() => {
    expect(mainTitle()).toBe('Cell')
    expect(titles()).toEqual(['Repair my build'])
    expect(document.querySelector('main')?.textContent).not.toContain('Repair another build')
    const own = row('Repair my build')
    expect(own.textContent).toMatch(/expires .*board time/)
    expect(own.querySelector('time')?.textContent).toBe(claim.until)
    expect(own.textContent).toContain('PR #41 open · CI failed')
    expect(own.textContent).toContain('142k tokens · partial')
    const back = link('back to Chapter')
    expect(back?.pathname).toBe('/presidium')
    expect(new URL(back!.href).searchParams.get('party')).toBe('blue')
    expectNoWrites(document.querySelector('main')!)
  })

  taskLinks()[0]!.click()
  await vi.waitFor(() => {
    const thread = document.querySelector('aside[aria-label="Thread"]')!
    expect(thread?.textContent).toContain('Repair my build')
    expect(thread.querySelector('textarea')).toBeNull()
    expect(thread.querySelector('button[title="more"], button[aria-label="more"]')).toBeNull()
    expectNoWrites(thread)
  })
  await mine.claim!.release()
  await vi.waitFor(() => {
    expect(statuses()).toContain('nothing claimed by this cell')
    expect(titles()).toEqual([])
  })
})

it('keeps the Cell thread pane scoped to its claimant as claims change live', async () => {
  const { create, actor, open } = await workBoard()
  const bob = await actor('u_bob')
  const aliceText = 'Prepare the release notes'
  const bobText = 'Investigate the build failure'
  const alice = await create(1, aliceText, { claim: true })
  const { task: bobsTask } = await create(2, bobText)
  await bob.tasks.claim(bobsTask.id)
  const cellPath = `/cell/${encodeURIComponent(alice.task.task!.claim!.actor)}`
  const thread = () => document.querySelector('aside[aria-label="Thread"]')
  const expectOutsideCell = (taskText: string) => {
    expect(thread()?.textContent).not.toContain(taskText)
    expect(thread()?.textContent?.trim()).toBe('not in this cell close')
  }

  await open(`${cellPath}?party=blue&thread=${bobsTask.id}`)
  await vi.waitFor(() => {
    expect(titles()).toEqual([aliceText])
    expectOutsideCell(bobText)
  })

  taskLinks()[0]!.click()
  await vi.waitFor(() => {
    expect(param('thread')).toBe(alice.task.id)
    expect(thread()?.textContent).toContain(aliceText)
  })

  await alice.claim!.release()
  await vi.waitFor(() => {
    expect(statuses()).toContain('nothing claimed by this cell')
    expect(param('thread')).toBe(alice.task.id)
    expectOutsideCell(aliceText)
  })

  link('close', thread()!)!.click()
  await vi.waitFor(() => {
    expect(thread()).toBeNull()
    expect(param('thread')).toBeNull()
    expect(location.pathname).toBe(cellPath)
    expect(param('party')).toBe('blue')
  })
})

it('hides the Cell thread pane when the thread read has already reassigned the task', async () => {
  const { create, actor, client, open } = await workBoard()
  const bob = await actor('u_bob')
  const text = 'Prepare the release notes'
  const alice = await create(1, text, { claim: true })
  const cellActor = alice.task.task!.claim!.actor
  const stale = await client.tasks.list({ state: 'open' })
  await alice.claim!.release()
  await bob.tasks.claim(alice.task.id)
  const thread = () => document.querySelector('aside[aria-label="Thread"]')
  await open(`/cell/${encodeURIComponent(cellActor)}?party=blue&thread=${alice.task.id}&swarm=fixtures`, async () => {
    return Response.json(stale)
  })
  await vi.waitFor(() => {
    expect(thread()?.textContent).not.toContain(text)
    expect(thread()?.textContent?.trim()).toBe('not in this cell close')
  })
})

it('shows the open-task refusal in the Cell thread pane instead of loading forever', async () => {
  const { create, open } = await workBoard()
  const mine = await create(1, 'Task the cell cannot list', { claim: true })
  const cellActor = mine.task.task!.claim!.actor
  const requested = Promise.withResolvers<void>()
  const respond = Promise.withResolvers<void>()
  releaseGates.push(respond.resolve)
  const refusal = 'This board cannot list open tasks'
  const thread = () => document.querySelector('aside[aria-label="Thread"]')
  await open(`/cell/${encodeURIComponent(cellActor)}?party=blue&thread=${mine.task.id}&swarm=fixtures`, async () => {
    requested.resolve()
    await respond.promise
    return Response.json({ error: { code: 'forbidden', message: refusal } }, { status: 403 })
  })
  await requested.promise
  await vi.waitFor(() => {
    expect(thread()?.querySelector('[role="status"]')?.textContent).toContain('loading…')
  })
  respond.resolve()
  await vi.waitFor(() => {
    expect(thread()?.textContent).not.toContain('Task the cell cannot list')
    expect(thread()?.textContent).not.toContain('loading…')
    expect(thread()?.textContent?.trim()).toBe(`${refusal} close`)
  })
})

it('never shows a cached task missing from the latest read in any scope and links the claimant to their Cell', async () => {
  const { create, client, open } = await workBoard()
  const old = await create(1, 'Old claim', { claim: true })
  const current = await create(2, 'Current claim', { claim: true })
  const claimant = current.task.task!.claim!.actor
  let readable = old.task.id
  // Change the proxy's open list while the task itself remains open and cached.
  await open('/party/blue?swarm=fixtures', async () => {
    const page = await client.tasks.list({ state: 'open' })
    return Response.json({ ...page, tasks: page.tasks.filter(({ message }) => message.id === readable) })
  })
  await vi.waitFor(() => expect(titles()).toEqual(['Old claim']))

  readable = current.task.id
  visitScope('/presidium?party=blue&swarm=fixtures')
  const onlyCurrent = () => {
    expect(titles()).toEqual(['Current claim'])
    expect(document.querySelector('main')?.textContent).not.toContain('Old claim')
  }
  await vi.waitFor(onlyCurrent)
  const cell = link('u_reader', row('Current claim'))
  expect(cell?.pathname).toBe(`/cell/${encodeURIComponent(claimant)}`)
  cell!.click()
  await vi.waitFor(() => {
    expect(mainTitle()).toBe('Cell')
    onlyCurrent()
  })
  visitScope('/party/blue?swarm=fixtures')
  await vi.waitFor(() => {
    expect(mainTitle()).toBe('Standing Committee')
    onlyCurrent()
  })
})

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

it('focuses the Work filter when typing on the body and the reply composer when typing in an open thread', async () => {
  const { create, open } = await workBoard()
  const { task } = await create(1, 'Check the build')
  await open()
  await vi.waitFor(() => {
    expect(titles()).toEqual(['Check the build'])
    expect(field()).not.toBeNull()
  })

  expect(param('thread')).toBeNull()
  flushSync(() => (document.activeElement as HTMLElement).blur())
  expect(document.activeElement).toBe(document.body)
  press('a')
  expect(document.activeElement).toBe(field())

  taskLinks()[0]!.click()
  const { heading, reply } = await vi.waitFor(() => {
    const pane = document.querySelector('aside[aria-label="Thread"]')
    const heading = pane?.querySelector('h1')
    const reply = pane?.querySelector('textarea[placeholder="reply to thread…"]')
    expect(param('thread')).toBe(task.id)
    expect(heading?.textContent).toBe('task')
    expect(reply).toBeTruthy()
    return { heading: heading!, reply: reply! }
  })

  flushSync(() => heading.focus())
  expect(document.activeElement).toBe(heading)
  press('a')
  expect(document.activeElement).toBe(reply)
})

it('lets Space activate a focused thread-pane button and still focuses the reply composer from a letter', async () => {
  const { create, open } = await workBoard()
  const { task } = await create(1, 'Check the build')
  await open()
  await vi.waitFor(() => expect(titles()).toEqual(['Check the build']))

  taskLinks()[0]!.click()
  const { heading, reply, closeThread } = await vi.waitFor(() => {
    const pane = document.querySelector('aside[aria-label="Thread"]')
    const heading = pane?.querySelector('h1')
    const reply = pane?.querySelector('textarea[placeholder="reply to thread…"]')
    const closeThread = pane?.querySelector<HTMLButtonElement>('button[aria-label="Close thread"]')
    expect(param('thread')).toBe(task.id)
    expect(heading?.textContent).toBe('task')
    expect(reply).toBeTruthy()
    expect(closeThread).toBeTruthy()
    return { heading: heading!, reply: reply!, closeThread: closeThread! }
  })

  flushSync(() => heading.focus())
  expect(document.activeElement).toBe(heading)
  press('a')
  expect(document.activeElement).toBe(reply)

  flushSync(() => closeThread.focus())
  expect(document.activeElement).toBe(closeThread)
  press(' ')
  expect(document.activeElement).toBe(closeThread)
  // Space activates a focused button on keyup; happy-dom does not, so click the still-focused control.
  closeThread.click()
  await vi.waitFor(() => {
    expect(param('thread')).toBeNull()
    expect(document.querySelector('aside[aria-label="Thread"]')).toBeNull()
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
    for (const name of ['unmetered-limit', 'Total']) {
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

it('lists the task trace in peek, oldest first, and copies the filtered lines', async () => {
  const { create, client, open } = await workBoard()
  const { task } = await create('plb-133', 'Trace the barn')
  await client.reply(task.id, 'the notes')
  await client.label(task.id, { set: { 'review.verdict': 'pass', 'review.head': 'abc123', 'pr.number': '12' } })
  const { actor } = await client.me()
  const claim = await client.tasks.claim(task.id, {
    binding: {
      controller: { principal: actor, actor },
      owner: { principal: actor, actor },
      provider: 'fixture-provider',
      model: 'fixture-model',
      session: 'sess-1',
      branch: 'plb/plb-133',
      worktree: 'worktrees/plb-133',
      baseCommit: 'a'.repeat(40),
    },
  })
  await claim.renew()
  await claim.release()
  await open(`?peek=${task.id}`)
  await vi.waitFor(() => expect(peek()?.querySelector('h2')?.textContent).toBe('Trace the barn'))
  flushSync(() => [...peek()!.querySelectorAll('button')].find((button) => button.textContent === 'trace')!.click())
  const rows = () => [...peek()!.querySelectorAll('.trace-row')]
  await vi.waitFor(() => {
    const lines = rows().map((row) => row.textContent ?? '')
    const letter = lines.findIndex((line) => line.includes('letter Trace the barn'))
    const claimed = lines.findIndex((line) => line.includes('claimed agent fixture-provider model fixture-model session sess-1 branch plb/plb-133'))
    expect(letter).toBeGreaterThanOrEqual(0)
    expect(letter).toBeLessThan(claimed)
    expect(lines.some((line) => line.includes('review.verdict pass'))).toBe(true)
    expect(lines.some((line) => line.includes('review.head abc123'))).toBe(true)
    expect(lines.some((line) => line.includes('pr.number 12'))).toBe(true)
    expect(lines.some((line) => line.includes('renewed'))).toBe(true)
    expect(lines.some((line) => line.includes('released'))).toBe(true)
    expect(lines.some((line) => line.includes('reply the notes'))).toBe(true)
    expect(rows().every((row) => row.querySelector('time')?.dateTime && row.querySelector('.trace-actor')?.textContent && row.querySelector('.trace-files'))).toBe(true)
  })
  const select = peek()!.querySelector<HTMLSelectElement>('select[aria-label="trace kind"]')!
  flushSync(() => {
    select.value = 'review'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(rows().map((row) => row.getAttribute('data-kind'))).toEqual(['review', 'review'])
  const written: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written.push(text) } } })
  flushSync(() => peek()!.querySelector<HTMLButtonElement>('button[aria-label="copy trace"]')!.click())
  await vi.waitFor(() => expect(written[0]).toContain('review.verdict pass'))
  expect(written[0]).toContain('review.head abc123')
  expect(written[0]).not.toContain('the notes')
  expect(written[0]).toContain(rows()[0]!.querySelector('time')!.dateTime)
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

it('/work holds a focused row at the same viewport offset when the page fits the viewport', async () => {
  const { create, actor, open } = await workBoard()
  const worker = await actor('u_worker')
  const { task: first } = await create(1, 'First ready task')
  await create(2, 'Reading this task')
  await open()
  await vi.waitFor(() => {
    expect(headings()).toEqual(['Ready to pull'])
    expect(titles()).toEqual(['First ready task', 'Reading this task'])
  })

  const scroll = document.querySelector<HTMLElement>('main .work-view')!
  const list = scroll.querySelector<HTMLElement>('[tabindex]')!
  const blockHeight = 40
  const viewport = 900
  const extraBelow = () => {
    const pad = (el: HTMLElement | null) => el ? parseFloat(el.style.paddingBottom) || 0 : 0
    let extra = pad(scroll) + pad(list)
    for (const root of [scroll, list]) {
      for (const child of root.children) {
        if (!(child instanceof HTMLElement) || child.matches('section, p')) continue
        extra += parseFloat(child.style.height) || 0
      }
    }
    return extra
  }
  const blocksHeight = () =>
    [...scroll.querySelectorAll('section h2, section li[data-task-id]')].length * blockHeight
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => viewport })
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => blocksHeight() + extraBelow() })
  let y = 0
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => y,
    set(value) {
      const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      y = Math.max(0, Math.min(Number(value) || 0, max))
    },
  })
  const getRect = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.matches('li[data-task-id]') || !scroll.contains(this)) return getRect.call(this)
    const blocks = [...scroll.querySelectorAll('section h2, section li[data-task-id]')]
    return new DOMRect(0, blocks.indexOf(this) * blockHeight - scroll.scrollTop, 100, blockHeight)
  })
  const reading = taskLinks()[1]!
  const row = reading.closest('li')!
  flushSync(() => reading.focus())
  expect(document.activeElement).toBe(reading)
  expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight)
  const top = row.getBoundingClientRect().top

  const claim = await worker.tasks.claim(first.id)
  await vi.waitFor(() => expect(headings()).toEqual(['Running', 'Ready to pull']))
  expect(row.getBoundingClientRect().top).toBe(top)
  expect(document.activeElement).toBe(reading)

  await claim.release()
  await vi.waitFor(() => expect(headings()).toEqual(['Ready to pull']))
  expect(row.getBoundingClientRect().top).toBe(top)
  expect(scroll.scrollHeight).toBe(blocksHeight())
  expect(document.activeElement).toBe(reading)
})

it('/work ignores a focused row that was scrolled offscreen during live regrouping', async () => {
  const { create, actor, open } = await workBoard()
  const worker = await actor('u_worker')
  const { task: first } = await create(1, 'First ready task')
  await create(2, 'Reading this task')
  await open()
  await vi.waitFor(() => {
    expect(headings()).toEqual(['Ready to pull'])
    expect(titles()).toEqual(['First ready task', 'Reading this task'])
  })

  const scroll = document.querySelector<HTMLElement>('main .work-view')!
  const queueRegion = queue()
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
  scroll.scrollTop = 200
  expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(0)
  const top = row.getBoundingClientRect().top
  const y = scroll.scrollTop

  await worker.tasks.claim(first.id)
  await vi.waitFor(() => expect(headings()).toEqual(['Running', 'Ready to pull']))
  expect(scroll.scrollTop).toBe(y)
  expect(row.getBoundingClientRect().top).toBe(top + blockHeight)
  expect(document.activeElement).toBe(reading)
})

it('holds the focused peek at its viewport offset during a live regroup while a queue row is hovered', async () => {
  const { create, actor, open } = await workBoard()
  const worker = await actor('u_worker')
  await create(1, 'First ready task')
  const { task: second } = await create(2, 'Reading this task')
  await open(`?peek=${second.id}`)
  browser.setViewport({ width: 800, height: 900 })
  await vi.waitFor(() => {
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
    const blocks = [...list.querySelectorAll('h2, h3, h4, li')]
    if (this.matches('li') && list.contains(this)) {
      return new DOMRect(0, blocks.indexOf(this) * blockHeight - scroll.scrollTop, 100, blockHeight)
    }
    if (this === peek()) {
      // happy-dom has no layout: stacked peek sits below the list in the same scroller.
      return new DOMRect(0, blocks.length * blockHeight - scroll.scrollTop, 100, 120)
    }
    return getRect.call(this)
  })
  const heading = peek()!.querySelector('h2')!
  flushSync(() => heading.focus())
  expect(document.activeElement).toBe(heading)
  const hovered = taskLinks()[0]!.closest('li')!
  list.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
  hovered.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  const top = peek()!.getBoundingClientRect().top

  await worker.tasks.claim(second.id)
  await vi.waitFor(() => {
    expect(headings()).toEqual(['Running', 'Ready to pull'])
    expect(peek()?.querySelector('h2')?.textContent).toBe('Reading this task')
  })
  expect(peek()!.getBoundingClientRect().top).toBe(top)
  expect(document.activeElement).toBe(heading)
})
const repoNav = () => document.querySelector('main nav[aria-label="Repos"]')
const repoEntry = (tag: string) => sidebar().querySelector(`section[aria-label="repo ${tag}"]`)

it('shows every repo on one board: a repo on each row, a sidebar entry per repo, and one repo at /r/<tag>', async () => {
  const { client, open } = await workBoard()
  await client.post('config/repos', JSON.stringify([{ tag: 'rdn', name: 'RemiDarkNET', repo: 'acme/darknet' }, { tag: 'plb', name: 'Politburo' }]))
  await client.tasks.create('rdn/backlog', { text: 'Audit the profile client' })
  await client.tasks.create('plb/issues', { text: 'Show the repo on each row' })
  await client.tasks.create('work', { text: 'Ship the canary', labels: { 'work.id': 'rdn-90' } })
  await open('/work')
  await vi.waitFor(() => {
    expect(titles().sort()).toEqual(['Audit the profile client', 'Ship the canary', 'Show the repo on each row'])
    expect(row('Audit the profile client').querySelector('.repo')?.textContent).toBe('rdn')
    expect(row('Ship the canary').querySelector('.repo')?.textContent).toBe('rdn')
    expect(row('Show the repo on each row').querySelector('.repo')?.textContent).toBe('plb')
    // Named by config/repos, in its order, with its channels under it and its counts.
    expect([...sidebar().querySelectorAll('section[aria-label^="repo "]')].map((el) => el.getAttribute('aria-label'))).toEqual(['repo rdn', 'repo plb'])
    expect(repoEntry('rdn')?.textContent).toContain('RemiDarkNET')
    expect(repoEntry('rdn')?.querySelector('a[href="/r/rdn"] .count')?.textContent).toBe('0 · 0 · 2')
    expect(repoEntry('rdn')?.querySelector('a[href="/c/rdn/backlog"] .name')?.textContent).toBe('#backlog')
    expect(repoEntry('plb')?.querySelector('a[href="/c/plb/issues"] .name')?.textContent).toBe('#issues')
    // Repo channels leave the plain channel list.
    expect(sidebar().querySelector('section:not([aria-label]) a[href="/c/rdn/backlog"]')).toBeNull()
  })

  link('RemiDarkNET', repoNav()!)!.click()
  await vi.waitFor(() => {
    expect(location.pathname).toBe('/r/rdn')
    expect(mainTitle()).toBe('RemiDarkNET')
    expect(titles().sort()).toEqual(['Audit the profile client', 'Ship the canary'])
  })
  link('all repos', repoNav()!)!.click()
  await vi.waitFor(() => expect(titles()).toHaveLength(3))
})

it('folds a repo’s channels from its row and keeps that for the board', async () => {
  const { client, open } = await workBoard()
  await client.post('config/repos', JSON.stringify([{ tag: 'rdn', name: 'RemiDarkNET', repo: 'acme/darknet' }, { tag: 'plb', name: 'Politburo' }]))
  await client.tasks.create('rdn/backlog', { text: 'Audit the profile client' })
  await client.tasks.create('plb/issues', { text: 'Show the repo on each row' })
  await open('/work')
  const channel = (tag: string, path: string) => repoEntry(tag)?.querySelector(`a[href="/c/${path}"] .name`)
  await vi.waitFor(() => expect(channel('rdn', 'rdn/backlog')?.textContent).toBe('#backlog'))
  const toggle = () => repoEntry('rdn')?.querySelector<HTMLButtonElement>('button[aria-expanded]')
  flushSync(() => toggle()!.click())
  expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  expect(channel('rdn', 'rdn/backlog')).toBeNull()
  expect(channel('plb', 'plb/issues')?.textContent).toBe('#issues')
  // A later task in the same repo does not open it again.
  await client.tasks.create('rdn/backlog', { text: 'A later task' })
  await vi.waitFor(() => expect(titles()).toContain('A later task'))
  expect(channel('rdn', 'rdn/backlog')).toBeNull()
  await open('/work', undefined, undefined, undefined, true)
  await vi.waitFor(() => {
    expect(repoEntry('rdn')?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    expect(repoEntry('rdn')?.querySelector('a[href="/c/rdn/backlog"]')).toBeNull()
  })
  flushSync(() => repoEntry('rdn')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  expect(repoEntry('rdn')?.querySelector('a[href="/c/rdn/backlog"] .name')?.textContent).toBe('#backlog')
  const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
  try {
    flushSync(() => repoEntry('rdn')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    expect(repoEntry('rdn')?.querySelector('a[href="/c/rdn/backlog"]')).toBeNull()
  } finally {
    setItem.mockRestore()
  }
})

it('names the repo, not its tag, in the tab on /r/<tag>', async () => {
  const { client, open } = await workBoard()
  await client.post('config/repos', JSON.stringify([{ tag: 'rdn', name: 'RemiDarkNET', repo: 'acme/darknet' }]))
  await client.tasks.create('rdn/backlog', { text: 'Audit the profile client' })
  await open('/r/rdn')
  await vi.waitFor(() => expect(document.title).toBe(`RemiDarkNET · ${boardAddress.host}`))
})

it('filters the queue by repo and counts each repo in Health', async () => {
  const { client, open } = await workBoard()
  await client.tasks.create('rdn/backlog', { text: 'Audit the profile client' })
  await client.tasks.create('plb/issues', { text: 'Show the repo on each row' })
  await open('/work?repo=plb')
  await vi.waitFor(() => {
    expect(titles()).toEqual(['Show the repo on each row'])
    expect(document.querySelector('main')?.textContent).toContain('repo: plb (remove)')
    const byRepo = [...document.querySelectorAll('main table tbody[aria-label="By repo"] th')].map((th) => th.textContent)
    // Health covers the whole scope, not the filter.
    expect(byRepo).toEqual(['plb', 'rdn'])
  })
})

it('answers a needs_input hold from the Needs you row: the reply is the viewer\'s and the row leaves', async () => {
  const { client, open } = await workBoard()
  const { task } = await client.tasks.create('rdn/backlog', { text: 'Decide the screenshot rule' })
  await client.tasks.block(task.id, 'Should logic-only PRs skip the screenshot?', { kind: 'needs_input' })
  await open('/work')
  const box = await vi.waitFor(() => {
    const needs = document.querySelector('#work-needs')
    expect(needs?.textContent).toContain('Decide the screenshot rule')
    expect(needs?.textContent).toContain('Should logic-only PRs skip the screenshot?')
    const area = needs?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')
    expect(area).toBeTruthy()
    return area!
  })
  setField(box, 'Yes, skip them')
  flushSync(() => box.closest('form')!.querySelector('button')!.click())
  await vi.waitFor(() => expect(document.querySelector('#work-needs')?.textContent).toContain('nothing needs you'))
  const thread = await client.thread(task.id)
  expect(thread.replies.find((message) => message.re === task.id)).toMatchObject({ text: 'Yes, skip them', by: { actor: (await client.me()).actor } })
  expect(thread.message.task).toMatchObject({ state: 'ready', blocked: null })
})

it('answers an awaiting_approval hold from Peek', async () => {
  const { client, open } = await workBoard()
  const { task } = await client.tasks.create('rdn/backlog', { text: 'Approve the deploy' })
  await client.tasks.block(task.id, 'Ship this build?', { kind: 'awaiting_approval' })
  await open('/work')
  const peekButton = await vi.waitFor(() => {
    const needs = document.querySelector('#work-needs')
    expect(needs?.textContent).toContain('Ship this build?')
    const button = needs?.querySelector<HTMLButtonElement>('button[aria-expanded]')
    expect(button).toBeTruthy()
    return button!
  })
  flushSync(() => peekButton.click())
  const box = peek()?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')
  expect(box).toBeTruthy()
  setField(box!, 'Ship it')
  flushSync(() => box!.closest('form')!.querySelector('button')!.click())
  await vi.waitFor(() => {
    expect(document.querySelector('#work-needs')?.textContent).toContain('nothing needs you')
    expect(peek()?.querySelector('textarea[aria-label="Answer"]')).toBeNull()
  })
  const thread = await client.thread(task.id)
  expect(thread.replies.find((message) => message.re === task.id)?.text).toBe('Ship it')
  expect(thread.message.task?.state).toBe('ready')
})

it('shows the board\'s words when the answer\'s unblock is refused', async () => {
  const { client, open, raw } = await workBoard()
  const { task } = await client.tasks.create('work', { text: 'Decide the rule', labels: { 'work.id': 'wp-9', party: 'blue' } })
  await client.tasks.block(task.id, 'Which rule?', { kind: 'needs_input' })
  const token = await personToken('u_reader', BOARD_URL)
  await open('/work', undefined, undefined, async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'POST' || !url.pathname.endsWith('/unblock')) return undefined
    const headers = new Headers()
    headers.set('authorization', `Bearer ${token}`)
    headers.set('x-board-can', '*=read')
    headers.set('content-type', 'application/json')
    return raw(new Request(`${BOARD_URL}${url.pathname.slice('/board'.length)}`, { method: 'POST', headers, body: '{}' }))
  })
  const box = await vi.waitFor(() => {
    const area = document.querySelector<HTMLTextAreaElement>('#work-needs textarea[aria-label="Answer"]')
    expect(area).toBeTruthy()
    return area!
  })
  setField(box, 'The first one')
  flushSync(() => box.closest('form')!.querySelector('button')!.click())
  await vi.waitFor(() => {
    expect(document.querySelector('#work-needs')?.textContent).toContain(`#${task.id} is someone else's task`)
  })
  const thread = await client.thread(task.id)
  expect(thread.replies.find((message) => message.re === task.id)?.text).toBe('The first one')
  expect(thread.message.task).toMatchObject({ state: 'blocked', blocked: { kind: 'needs_input' } })
})

function setField(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  flushSync(() => {
    el.focus()
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('starts a task for a person from the composer: held with the question, never ready for agents', async () => {
  const { client, open, actor } = await workBoard()
  await client.createChannel('rdn/backlog')
  // Hold the block so a claim-next that is already waiting can take a task left ready.
  await open('/c/rdn/backlog', undefined, undefined, async (request) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/block'))
      await new Promise((resolve) => setTimeout(resolve, 400))
    return undefined
  })
  const composer = await vi.waitFor(() => {
    const area = document.querySelector<HTMLTextAreaElement>('main textarea')
    expect(area).not.toBeNull()
    return area!
  })
  const button = (words: string) => [...document.querySelectorAll<HTMLButtonElement>('main button')]
    .find((b) => b.textContent?.trim() === words || b.title === words)!
  flushSync(() => button('start it as a task').click())
  flushSync(() => button('needs, for').click())
  setField(document.querySelector<HTMLInputElement>('input[aria-label="ask a person"]')!, 'Keep the screenshot rule for logic-only PRs?')
  setField(composer, 'Decide the screenshot rule')
  const other = await actor('u_reader')
  const stop = new AbortController()
  let taken: string | null = null
  const waiting = other.tasks.claim({ channel: 'rdn/backlog', wait: 30 }, { signal: stop.signal }).then(
    (claimed) => { taken = claimed ? claimed.task.id : 'none' },
    () => { taken = 'stopped' },
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  flushSync(() => button('start task').click())

  visitScope('/work')
  await vi.waitFor(() => {
    const needs = document.querySelector('#work-needs')
    expect(needs?.textContent).toContain('Decide the screenshot rule')
    expect(needs?.textContent).toContain('Keep the screenshot rule for logic-only PRs?')
    expect(needs?.querySelector('textarea[aria-label="Answer"]')).toBeTruthy()
    expect(document.querySelector('#work-queue-waiting')?.closest('section')?.textContent ?? '').not.toContain('Decide the screenshot rule')
  })
  // On the board itself, not just on the page. Claim-next was already waiting and did not take it.
  const page = await client.tasks.list({ channel: 'rdn/backlog' })
  expect(page.tasks.map(({ message }) => [message.task?.state, message.task?.blocked?.kind])).toEqual([['blocked', 'needs_input']])
  expect(taken).toBeNull()
  stop.abort()
  await waiting
})

it('shows an ask-a-person failure on the post and does not leave the task ready', async () => {
  const { client, open } = await workBoard()
  await client.createChannel('rdn/backlog')
  await open('/c/rdn/backlog', undefined, undefined, (request) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/block'))
      return Response.json({ error: { code: 'task_claimed', message: 'claimed' } }, { status: 409 })
    return undefined
  })
  const composer = await vi.waitFor(() => {
    const area = document.querySelector<HTMLTextAreaElement>('main textarea')
    expect(area).not.toBeNull()
    return area!
  })
  const button = (words: string) => [...document.querySelectorAll<HTMLButtonElement>('main button')]
    .find((b) => b.textContent?.trim() === words || b.title === words)!
  flushSync(() => button('start it as a task').click())
  flushSync(() => button('needs, for').click())
  setField(document.querySelector<HTMLInputElement>('input[aria-label="ask a person"]')!, 'Keep the screenshot rule?')
  setField(composer, 'Decide the screenshot rule')
  flushSync(() => button('start task').click())
  await vi.waitFor(() => expect(document.querySelector('.message.pending.failed')?.textContent).toContain('someone holds this task'))
  const openTasks = await client.tasks.list({ channel: 'rdn/backlog' })
  expect(openTasks.tasks).toEqual([])
  const page = await client.tasks.list({ channel: 'rdn/backlog', state: 'failed' })
  expect(page.tasks.map(({ message }) => message.task?.state)).toEqual(['failed'])
})

it('does not show a work id as a repo the board does not list', async () => {
  const { client, open } = await workBoard()
  await client.tasks.create('work', { text: 'Package task', labels: { 'work.id': 'wp-1' } })
  await client.tasks.create('rdn', { text: 'Bare channel' })
  await client.tasks.create('rdn/backlog', { text: 'Backlog item', labels: { 'work.id': 'abcdefghijklmnopq-2' } })
  await open('/work')
  await vi.waitFor(() => {
    expect(row('Package task').querySelector('.repo')?.textContent).toBe('no repo')
    expect(row('Bare channel').querySelector('.repo')?.textContent).toBe('no repo')
    expect(row('Backlog item').querySelector('.repo')?.textContent).toBe('rdn')
    expect(sidebar().querySelector('section[aria-label="repo wp"]')).toBeNull()
    expect(repoEntry('rdn')?.querySelector('a[href="/r/rdn"] .count')?.textContent).toBe('0 · 0 · 1')
  })
})

const minute = 60_000
const runningCount = () => document.querySelector('.work-counts')?.textContent ?? ''
const rdnCount = () => repoEntry('rdn')?.querySelector('.count')?.textContent

it('shows a claim with no progress as repair, and a reply puts it back in running', async () => {
  const board = await workBoard('6h')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const start = Date.now()
  const { task } = await board.client.tasks.create('rdn/backlog', { text: 'Wait on approval' })
  let held = await board.client.tasks.claim(task.id, { lease: 3600 })
  vi.setSystemTime(start + 30 * minute)
  await board.client.reply(task.id, 'still on the approval')
  vi.setSystemTime(start + 40 * minute)
  held = await held.renew(3600)
  // The root is older than an hour. The reply is not, so the claim is still running.
  vi.setSystemTime(start + 70 * minute)
  await board.open('/work')
  await vi.waitFor(() => {
    expect(headings()).toContain('Running')
    expect(headings()).not.toContain('Repair or reconcile')
    expect(runningCount()).toContain('1 running')
    expect(rdnCount()).toBe('0 · 1 · 0')
    expect(row('Wait on approval').textContent).not.toContain('no progress')
  })
  // Moving the clock alone does not re-render. The page clock does, without a reload.
  vi.setSystemTime(start + 30 * minute + 61 * minute)
  expect(headings()).toContain('Running')
  expect(row('Wait on approval').textContent).not.toContain('no progress')
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
  await vi.waitFor(() => {
    expect(headings()).toContain('Repair or reconcile')
    expect(headings()).not.toContain('Running')
    expect(row('Wait on approval').textContent).toContain('no progress for 1h')
    expect(runningCount()).toContain('0 running')
    expect(rdnCount()).toBe('0 · 0 · 0')
  })
  await (await board.fresh()).reply(task.id, 'approval landed')
  await vi.waitFor(() => {
    expect(headings()).toContain('Running')
    expect(headings()).not.toContain('Repair or reconcile')
    expect(runningCount()).toContain('1 running')
    expect(rdnCount()).toBe('0 · 1 · 0')
    expect(row('Wait on approval').textContent).not.toContain('no progress')
  })
}, 30_000)

it('treats a root edit or a label change as progress on a claim', async () => {
  const board = await workBoard('6h')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const start = Date.now()
  const edited = (await board.client.tasks.create('rdn/backlog', { text: 'Wait on the edit' })).task
  const labeled = (await board.client.tasks.create('rdn/backlog', { text: 'Wait on the label' })).task
  const editClaim = await board.client.tasks.claim(edited.id, { lease: 3600 })
  const labelClaim = await board.client.tasks.claim(labeled.id, { lease: 3600 })
  vi.setSystemTime(start + 10 * minute)
  await editClaim.renew(3600)
  await labelClaim.renew(3600)
  vi.setSystemTime(start + 15 * minute)
  await board.open('/work')
  await vi.waitFor(() => {
    expect(headings()).toEqual(['Running'])
    expect(rdnCount()).toBe('0 · 2 · 0')
  })
  vi.setSystemTime(start + 61 * minute)
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
  await vi.waitFor(() => {
    expect(row('Wait on the edit').textContent).toContain('no progress for 1h')
    expect(row('Wait on the label').textContent).toContain('no progress for 1h')
    expect(rdnCount()).toBe('0 · 0 · 0')
  })
  const live = await board.fresh()
  await live.edit(edited.id, 'Wait on the edit\nstill here')
  await live.label(labeled.id, { set: { note: 'awake' } })
  await vi.waitFor(() => {
    expect(row('Wait on the edit').textContent).not.toContain('no progress')
    expect(row('Wait on the label').textContent).not.toContain('no progress')
    expect(headings()).toContain('Running')
    expect(headings()).not.toContain('Repair or reconcile')
    expect(rdnCount()).toBe('0 · 2 · 0')
  })
}, 30_000)

it('counts a label change made before the page opened', async () => {
  const board = await workBoard('6h')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const start = Date.now()
  const { task } = await board.client.tasks.create('rdn/backlog', { text: 'Wait on a label' })
  const held = await board.client.tasks.claim(task.id, { lease: 3600 })
  vi.setSystemTime(start + 50 * minute)
  await held.renew(3600)
  // The root is older than an hour. The label is not, and the page has not seen the event.
  vi.setSystemTime(start + 70 * minute)
  await board.client.label(task.id, { set: { note: 'awake' } })
  await board.open('/work')
  await vi.waitFor(() => {
    expect(headings()).toContain('Running')
    expect(headings()).not.toContain('Repair or reconcile')
    expect(row('Wait on a label').textContent).not.toContain('no progress')
    expect(runningCount()).toContain('1 running')
    expect(rdnCount()).toBe('0 · 1 · 0')
  })
}, 30_000)
