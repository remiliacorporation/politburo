import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { applyEvent, initialState, merge, type State } from '../src/inspect/app/store.ts'
import { BOARD_URL, personToken, testBoard } from './harness.ts'

const board = testBoard()
let Home: typeof import('../src/inspect/app/home.tsx').Home

beforeAll(async () => {
  // The inspector's modules take the navigation base and proxy origin from the page.
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', new URL('http://127.0.0.1:4747/'))
  vi.stubGlobal('addEventListener', () => {})
  Home = (await import('../src/inspect/app/home.tsx')).Home
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await board.store.close()
})

const home = (state: State, now = Date.now()) => renderToStaticMarkup(<Home state={state} now={now} lead={null} />)
const prerequisites = (html: string) => html.match(/<ul[^>]*aria-label="Prerequisites"[^>]*>(.*?)<\/ul>/s)?.[1] ?? ''

it('follows a prerequisite from its board claim to its delivery, even if a stale list arrives', async () => {
  const access = { url: BOARD_URL, token: await personToken(), fetch: (input: RequestInfo | URL, init?: RequestInit) => board.fetch(new Request(input, init)) }
  const team = createBoardClient({ ...access, profile: null })
  const runner = createBoardClient({ ...access, profile: 'runner' })
  const { task: bundle } = await team.tasks.create('build', { text: 'Bundle the site', labels: { state: 'completed', step: 'approved' } })
  const { task: publish } = await team.tasks.create('release', { text: 'Publish the site', needs: [bundle.id] })
  await team.reply(bundle.id, 'Approved, shipped!')

  const page = await team.tasks.list({ state: 'all' })
  const roots = page.tasks.map(({ message }) => message)
  let state = merge(initialState, roots)
  // Start at a feed cursor, not the task list's pagination cursor.
  let cursor = (await team.poll({ last: 1 })).cursor
  const follow = async () => {
    const { events, cursor: next } = await team.poll({ after: cursor, all: true })
    state = events.reduce(applyEvent, state)
    cursor = next
  }

  const waiting = home(merge(initialState, [publish]))
  expect(prerequisites(waiting)).toContain(`href="/?thread=${bundle.id}"`)
  expect(prerequisites(waiting)).toContain('Open thread for details')
  expect(prerequisites(home(state))).toContain('>ready</span>')
  expect(home(state)).not.toContain('Approved, shipped!')
  expect(home(state)).not.toContain('step=approved')

  const claim = (await runner.tasks.claim(bundle.id, { lease: 300 }))!
  await follow()
  state = merge(state, roots) // the task page was answered before the live claim
  const held = prerequisites(home(state))
  expect(held).toContain('>claimed</span>')
  expect(held).toContain('Held by')
  expect(held).toContain('vercel:user:u_julian+runner')
  expect(held).toContain(`<time dateTime="${claim.until}">`)
  const lapsed = prerequisites(home(state, Date.parse(claim.until)))
  expect(lapsed).toContain('Lease ended')
  expect(lapsed).not.toContain('Held by')

  await claim.complete('Bundle digest recorded in the build log.')
  await follow()
  state = merge(state, roots) // an even older page cannot undo delivery or readiness
  const delivered = home(state)
  expect(prerequisites(delivered)).toContain('>completed</span>')
  expect(prerequisites(delivered)).toContain('Delivery:</strong> Bundle digest recorded in the build log.')
  expect(delivered).toMatch(/Publish the site<\/a>.*?>ready<\/span>/s)
  expect(delivered).not.toContain('Held by')
})
