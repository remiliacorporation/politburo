// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { ActorName } from '../src/inspect/app/actor-name.tsx'
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

// A mob is a person whose user id is the mob id (`21-CAT`). Profile names cannot
// start with a digit, so the board records the mob on the actor id itself.
async function mobBoard() {
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
  const clientFor = async (user: string) => createBoardClient({
    url: BOARD_URL,
    token: await personToken(user, BOARD_URL),
    profile: null,
    fetch: (input, init) => api.fetch(new Request(input, init)),
  })
  const client = await clientFor('u_reader')
  const writes: string[] = []
  return {
    writes,
    client,
    mob: (id: string) => clientFor(id),
    async open(address: string, respond?: (request: Request) => Promise<Response | undefined> | Response | undefined, seed = false) {
      browser.setViewport({ width: 1280, height: 900 })
      browser.setURL(`http://mobs-${++visit}.test${address}`)
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
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${token}`)
        return api.fetch(new Request(`${BOARD_URL}${request.url.slice(proxy.length)}`, {
          method: request.method, headers, signal: AbortSignal.any([page.signal, request.signal]),
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
        }))
      })
      vi.resetModules()
      if (seed) {
        const fixtures = (await import('../src/inspect/app/work-fixtures.ts')).fixtureRecords
        fixtures.observations['rdn-4'] = { contract: 'valid', pr: { number: 4, state: 'open', checks: 'fail' } }
      }
      const { App } = await import('../src/inspect/app/App.tsx')
      const mounted = root = createRoot(document.getElementById('root')!)
      flushSync(() => mounted.render(<App />))
    },
  }
}

const config = {
  names: {
    mob_species: {
      passive: { research: ['SHEEP'] },
      neutral: { build: ['BEE'] },
      hostile: { raid: ['CREEPER'] },
      boss: ['CAT', 'DRAGON'],
    },
  },
}

const card = (id: string) => [...document.querySelectorAll('main a')].find((link) => link.textContent === id)?.closest('article')
const parties = () => [...document.querySelectorAll('.mob-map > section > h2')].map((heading) => heading.textContent)
const svgWidth = (img: Element | null | undefined) => img ? decodeURIComponent(img.getAttribute('src') ?? '') : ''

it('maps seeded mobs by party and repo, with heads, sprites, holds, and a cell link', async () => {
  const { client, mob, open, writes } = await mobBoard()
  const cat = await mob('21-CAT')
  const made = await cat.tasks.create('rdn/work', {
    text: 'Fix the gate', labels: { 'work.id': 'rdn-9', party: 'blue', 'pr.number': '12' }, claim: true, lease: 600,
  })
  await (await mob('21-CAT.PICKAXE')).post('rdn/work', 'sprite on the gate')
  await (await mob('41-CREEPER')).tasks.create('rdn/work', {
    text: 'Raid the mirror', labels: { 'work.id': 'rdn-4', party: 'blue', 'pr.number': '4' }, claim: true, lease: 600,
  })
  await (await mob('30-BEE')).tasks.create('web/work', {
    text: 'Port the ledger', labels: { 'work.id': 'web-2', party: 'red' }, claim: true, lease: 600,
  })
  await (await mob('40-FOX')).post('rdn/work', 'fox is here')
  await client.post('config/party', JSON.stringify(config))
  await open('/mobs?swarm=fixtures', undefined, true)

  const catCard = await vi.waitFor(() => {
    expect(document.querySelector('main h1')?.textContent).toBe('mobs')
    const found = card('21-CAT')
    expect(found?.textContent).toContain('class boss')
    return found!
  })
  expect(parties()).toEqual(['blue', 'red', 'no party'])
  const blue = document.querySelector('.mob-map > section')!
  expect([...blue.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual(['rdn'])
  expect([...blue.querySelectorAll('article a')].map((link) => link.textContent)).toEqual(['21-CAT', '41-CREEPER'])
  expect([...document.querySelectorAll('.mob-map > section')[1]!.querySelectorAll('article a')].map((link) => link.textContent)).toEqual(['30-BEE'])
  expect([...document.querySelectorAll('.mob-map > section')[2]!.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual(['no repo'])

  expect(catCard.textContent).toContain('species CAT')
  expect(catCard.textContent).toContain('class boss')
  expect(catCard.textContent).toContain('party blue')
  expect(catCard.textContent).toContain('repo rdn')
  expect(catCard.textContent).toContain('holds rdn-9 Fix the gate')
  expect(catCard.textContent).toMatch(/expires in \d+m/)
  expect(catCard.textContent).toContain('PR #12')
  expect(catCard.textContent).toContain('running')
  expect(catCard.textContent).toContain('21-CAT.PICKAXE')
  const head = catCard.querySelector('img.pixel')
  expect(head?.getAttribute('width')).toBe('64')
  expect(svgWidth(head)).toContain('width="64"')
  const tool = catCard.querySelector('.mob-sprites img')
  expect(tool?.getAttribute('width')).toBe('16')
  expect(svgWidth(tool)).toContain('width="16"')

  const creeper = card('41-CREEPER')!
  expect(creeper.textContent).toContain('class hostile')
  expect(creeper.textContent).toContain('stalled')
  expect(creeper.textContent).toContain('CI failed')
  expect(creeper.textContent).toContain('holds rdn-4 Raid the mirror')

  const bee = card('30-BEE')!
  expect(bee.textContent).toContain('class neutral')
  expect(bee.textContent).toContain('party red')
  expect(bee.textContent).toContain('repo web')
  expect(bee.textContent).toContain('no PR')
  expect(bee.textContent).toContain('running')

  const fox = card('40-FOX')!
  expect(fox.textContent).toContain('class unknown')
  expect(fox.textContent).toContain('holds nothing')
  expect(fox.textContent).toContain('no claim')
  expect(fox.textContent).toContain('idle')
  expect(fox.textContent).toContain('no sprites')

  const partiesHeading = [...document.querySelectorAll('.sidebar h2')].find((heading) => heading.textContent === 'parties')
  expect(partiesHeading?.nextElementSibling?.textContent).toBe('mobs')
  expect(partiesHeading?.nextElementSibling?.getAttribute('aria-current')).toBe('page')
  expect(document.querySelector('main textarea')).toBeNull()
  expect(writes).toEqual([])

  const actor = made.task.task?.claim?.actor
  expect(decodeURIComponent(catCard.querySelector('a')!.getAttribute('href')!)).toContain(`/cell/${actor}`)
  catCard.querySelector('a')!.click()
  await vi.waitFor(() => {
    expect(location.pathname).toContain('/cell/')
    expect(document.querySelector('main')!.textContent).toContain('Fix the gate')
    expect(document.querySelector('main')!.textContent).not.toContain('Port the ledger')
  })
  expect(writes).toEqual([])
})

it('maps a lowercase handle as it was written, with its head and sprite', async () => {
  const { mob, open } = await mobBoard()
  await (await mob('311-bee')).post('rdn/work', 'bee is here')
  await (await mob('311-bee.pickaxe')).post('rdn/work', 'sprite on the bee')
  await open('/mobs')
  const bee = await vi.waitFor(() => {
    expect(document.querySelector('main')!.textContent).not.toContain('no mobs')
    const found = card('311-bee')
    expect(found).toBeTruthy()
    return found!
  })
  expect(document.body.textContent).not.toContain('311-BEE')
  expect(bee.textContent).toContain('species BEE')
  expect(bee.textContent).toContain('311-bee.pickaxe')
  expect(bee.querySelector('img.pixel')?.getAttribute('width')).toBe('64')
  expect(svgWidth(bee.querySelector('img.pixel'))).toContain('width="64"')
  const tool = bee.querySelector('.mob-sprites img')
  expect(tool?.getAttribute('width')).toBe('16')
  expect(svgWidth(tool)).toContain('width="16"')
})

it('draws a name icon for a lowercase actor id and leaves the name as written', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const mounted = createRoot(host)
  const written = 'team:user:311-bee'
  flushSync(() => mounted.render(<ActorName name={written} />))
  expect(host.textContent).toBe(written)
  expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('BEE')
  flushSync(() => mounted.render(<ActorName name="team:user:311-bee.pickaxe" />))
  expect(host.textContent).toBe('team:user:311-bee.pickaxe')
  expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('PICKAXE')
  flushSync(() => mounted.render(<ActorName name="rival-bee" />))
  expect(host.textContent).toBe('rival-bee')
  expect(host.querySelector('svg')).toBeNull()
  mounted.unmount()
  host.remove()
})

it('uses the default species pools when the board has no party config', async () => {
  const { mob, open } = await mobBoard()
  await (await mob('21-CAT')).post('rdn/work', 'cat is here')
  await open('/mobs')
  await vi.waitFor(() => expect(card('21-CAT')?.textContent).toContain('class passive'))
  expect(document.querySelector('.toast')).toBeNull()
})

it('shows a refused actor list and still maps mobs that hold a claim', async () => {
  const { mob, open } = await mobBoard()
  await (await mob('21-CAT')).tasks.create('rdn/work', {
    text: 'Fix the gate', labels: { 'work.id': 'rdn-9', party: 'blue' }, claim: true, lease: 600,
  })
  await open('/mobs', (request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/board/actors')
      return Response.json({ error: { code: 'unavailable', message: 'actors are down' } }, { status: 500 })
  })
  await vi.waitFor(() => {
    expect(document.querySelector('main')!.textContent).toContain('actors are down')
    expect(card('21-CAT')?.textContent).toContain('running')
  })
})

it('shows a refused party config and does not guess a class', async () => {
  const { mob, open } = await mobBoard()
  await (await mob('21-CAT')).post('rdn/work', 'cat is here')
  await open('/mobs', (request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/board/threads' && url.searchParams.get('channel') === 'config/party')
      return Response.json({ error: { code: 'forbidden', message: 'party config is sealed' } }, { status: 403 })
  })
  await vi.waitFor(() => {
    expect(document.querySelector('main')!.textContent).toContain('party config is sealed')
    expect(card('21-CAT')?.textContent).toContain('class unknown')
  })
})
