import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageView, ScheduleView } from '../src/api/routes.ts'
import { createBoardClient } from '../src/client/client.ts'
import { BOARD_URL, localBoard, personToken } from './harness.ts'

// The page's data module, as the page runs it: one handle on the inspector's proxy, which is
// faked here. What the page asks the board, and what it keeps, are what a person at it sees.

type Asked = { method: string; path: string; query: Record<string, string>; body: unknown }
const asked: Asked[] = []
/** What the board answers next for a route, by `METHOD /path`: each is used once, then the route's usual answer. */
const next = new Map<string, (() => Response | Promise<Response>)[]>()
const refuse = (status: number, code: string, message: string) => () => Response.json({ error: { code, message } }, { status })

const schedule = (text: string): ScheduleView =>
  ({ id: 's1', channel: 'dev', re: null, text, labels: {}, noSync: false, attachments: [], first: '2026-10-01T12:00:00.000Z', every: null, until: null, times: null, sent: 0, next: '2026-10-01T12:00:00.000Z', last: null, state: 'pending', canceled: null, createdAt: '2026-10-01T10:00:00.000Z' }) as unknown as ScheduleView

/** A new task's root, as the board answers it. */
const taskRoot = (body: { channel: string; text: string; needs?: string[] }): MessageView =>
  ({
    id: '50',
    version: 50,
    revision: 50,
    channel: body.channel,
    text: body.text,
    re: null,
    replyTo: null,
    thread: 't50',
    labels: { 'board.task': 'waiting' },
    reactions: {},
    by: { actor: 'local:user:julian', principal: 'local:user:julian', profile: null },
    noSync: false,
    origin: null,
    from: null,
    blocks: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: null,
    task: { state: 'waiting', priority: 'normal', owner: 'local:user:julian', by: 'local:user:julian', for: null, needs: body.needs ?? [], epoch: 0, claim: null, blocked: null, result: null, reason: null },
  }) as MessageView

const usual: Record<string, (body: unknown) => Response> = {
  // Who the page is, which the handle asks before it makes a task.
  'GET /me': () => Response.json({ actor: 'local:user:julian', principal: 'local:user:julian', kind: 'person', handle: 'julian', name: 'julian', avatar: null, profile: null, expiresAt: null, can: { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] } }),
  'POST /tasks': (body) => Response.json({ task: taskRoot(body as Parameters<typeof taskRoot>[0]) }, { status: 201 }),
  'POST /attachments': () => Response.json({ attachment: { id: 'a'.repeat(22), name: 'trace.log', type: 'text/plain', size: 5 } }, { status: 201 }),
  'POST /schedules': (body) => Response.json({ schedule: schedule((body as { text: string }).text) }, { status: 201 }),
  'GET /schedules': () => Response.json({ schedules: [] }),
}

let page: typeof import('../src/inspect/app/board.ts')

beforeAll(async () => {
  // What a browser gives the page: where it is, its document, and a fetch, which here is the proxy.
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', new URL('http://127.0.0.1:4747/'))
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 0))
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const path = url.pathname.slice('/board'.length)
    const method = request.method
    // What it carries, when that's JSON: a file's bytes are not.
    const body = await request
      .text()
      .then((text) => (text ? (JSON.parse(text) as unknown) : null))
      .catch(() => null)
    asked.push({ method, path, query: Object.fromEntries(url.searchParams), body })
    const route = `${method} ${path}`
    return next.get(route)?.shift()?.() ?? usual[route]?.(body) ?? Response.json({ error: { code: 'not_found', message: `no ${route} here` } }, { status: 404 })
  })
  page = await import('../src/inspect/app/board.ts')
})

const posts = (path: string) => asked.filter((request) => request.method === 'POST' && request.path === path).map((request) => request.body)

describe("the inspector's page, sending later", () => {
  it('keeps a schedule the board refused, with everything typed, and schedules it again on retry', async () => {
    next.set('POST /schedules', [refuse(403, 'forbidden', "this token can't post in dev")])
    const file = new File(['trace'], 'trace.log', { type: 'text/plain' })
    await page.send({ channel: 'dev', re: null, text: 'Morning recap', noSync: true, labels: { kind: 'recap' }, files: [file], later: { in: '2h', every: '1d' } })

    // Nothing is lost: it's a post that didn't go, as a refused send is, with why and what it would have sent.
    const [kept] = page.getState().pending
    expect(kept).toMatchObject({
      channel: 'dev',
      re: null,
      text: 'Morning recap',
      noSync: true,
      labels: { kind: 'recap' },
      files: [{ name: 'trace.log', size: 5 }],
      later: { in: '2h', every: '1d' },
      error: "this token can't post in dev",
    })
    expect(page.getState().pending).toHaveLength(1)

    await page.retry(kept!)
    // The retry asked for the same schedule, its file with it, and the board kept it: nothing is pending.
    expect(page.getState().pending).toEqual([])
    const wanted = { channel: 'dev', text: 'Morning recap', noSync: true, labels: { kind: 'recap' }, attachments: ['a'.repeat(22)], in: '2h', every: '1d' }
    expect(posts('/schedules')).toEqual([wanted, wanted])
    // A schedule is not a post: nothing was sent to the channel on the way.
    expect(posts('/messages')).toEqual([])
  })

  it('leaves no pending post behind a schedule the board kept, and a reply later names its thread', async () => {
    asked.length = 0
    await page.send({ channel: 'dev', re: '812', text: 'Still broken?', noSync: false, labels: {}, later: { at: '2026-10-02T09:00:00.000Z' } })
    expect(page.getState().pending).toEqual([])
    expect(posts('/schedules')).toEqual([{ re: '812', text: 'Still broken?', at: '2026-10-02T09:00:00.000Z' }])
  })

  it('discards one you give up on', async () => {
    next.set('POST /schedules', [refuse(400, 'invalid_request', 'durations look like 30s, 30m, 12h, or 1d')])
    await page.send({ channel: 'dev', re: null, text: 'Typo', noSync: false, labels: {}, later: { in: '2h' } })
    const [kept] = page.getState().pending
    expect(kept).toMatchObject({ text: 'Typo', error: 'durations look like 30s, 30m, 12h, or 1d' })
    page.discard(kept!.key)
    expect(page.getState().pending).toEqual([])
  })
})

describe("the inspector's page, starting a task", () => {
  it('keeps a task the board refused, with what it needs, and starts it again on retry', async () => {
    next.set('POST /tasks', [refuse(400, 'invalid_needs', "needs: #9999 isn't a task")])
    const file = new File(['trace'], 'trace.log', { type: 'text/plain' })
    await page.send({ channel: 'work', re: null, text: 'publish the release', noSync: false, labels: { step: 'ship' }, files: [file], task: { needs: ['9999'], for: null } })

    // As a refused send: the post stays, with why, and with what made it a task.
    const [kept] = page.getState().pending
    expect(kept).toMatchObject({ channel: 'work', text: 'publish the release', labels: { step: 'ship' }, files: [{ name: 'trace.log', size: 5 }], task: { needs: ['9999'], for: null }, error: "needs: #9999 isn't a task" })

    await page.retry(kept!)
    expect(page.getState().pending).toEqual([])
    // Its file goes with it, in the one write that makes the task.
    const wanted = { channel: 'work', text: 'publish the release', labels: { step: 'ship' }, attachments: ['a'.repeat(22)], needs: ['9999'], for: null }
    expect(posts('/tasks')).toMatchObject([wanted, wanted])
    // The task the board answered is the page's now.
    expect(page.getState().messages['50']).toMatchObject({ text: 'publish the release', task: { state: 'waiting', needs: ['9999'] } })
  })
})

describe("the inspector's page, reading work control", () => {
  beforeEach(async () => {
    vi.resetModules()
    page = await import('../src/inspect/app/board.ts')
  })

  function twoStatusReads() {
    const old = Promise.withResolvers<Response>()
    const newer = Promise.withResolvers<Response>()
    next.set('GET /control', [() => old.promise, () => newer.promise])
    return { old, newer, first: page.loadStatus(), second: page.loadStatus() }
  }

  it('takes a later pause epoch from a slower, older status read', async () => {
    const { old, newer, first, second } = twoStatusReads()
    newer.resolve(Response.json({ paused: false, pauseEpoch: 0 }))
    await second
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 0 })
    old.resolve(Response.json({ paused: true, pauseEpoch: 1 }))
    await first
    expect(page.getState().status).toEqual({ paused: true, pauseEpoch: 1 })
  })

  it('does not revert the pause epoch on a newer status read', async () => {
    const { old, newer, first, second } = twoStatusReads()
    old.resolve(Response.json({ paused: true, pauseEpoch: 1 }))
    await first
    expect(page.getState().status).toEqual({ paused: true, pauseEpoch: 1 })
    newer.resolve(Response.json({ paused: false, pauseEpoch: 0 }))
    await second
    expect(page.getState().status).toEqual({ paused: true, pauseEpoch: 1 })
  })

  it('keeps the newer refusal in the header when the older refusal arrives last', async () => {
    const { old, newer, first, second } = twoStatusReads()
    newer.resolve(refuse(503, 'unavailable', 'status is temporarily unavailable')())
    await second
    expect(page.getState().statusRefused).toBe('status is temporarily unavailable')
    old.resolve(refuse(403, 'forbidden', 'status access was denied')())
    await first
    expect(page.getState().statusRefused).toBe('status is temporarily unavailable')
  })

  it('does not show a refusal older than a successful status read', async () => {
    const { old, newer, first, second } = twoStatusReads()
    newer.resolve(Response.json({ paused: false, pauseEpoch: 0 }))
    await second
    old.resolve(refuse(503, 'unavailable', 'status is temporarily unavailable')())
    await first
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 0 })
    expect(page.getState().statusRefused).toBeNull()
  })

  it('keeps the last successful status even if a pending newer read fails', async () => {
    const { old, newer, first, second } = twoStatusReads()
    old.resolve(Response.json({ paused: true, pauseEpoch: 1 }))
    await first
    expect(page.getState().status).toEqual({ paused: true, pauseEpoch: 1 })
    newer.resolve(refuse(503, 'unavailable', 'status is temporarily unavailable')())
    await second
    expect(page.getState().statusRefused).toBe('status is temporarily unavailable')
    expect(page.getState().status).toEqual({ paused: true, pauseEpoch: 1 })
  })

  // Get real status snapshots, then deliver them through the proxy in the order each race needs.
  async function snapshots() {
    const api = localBoard()
    try {
      const token = await personToken('u_reader', BOARD_URL)
      const client = createBoardClient({ url: BOARD_URL, token, fetch: (input, init) => api.fetch(new Request(input, init)) })
      const sample = () => api.fetch(new Request(`${BOARD_URL}/control`, { headers: { authorization: `Bearer ${token}` } }))
      const initial = await sample()
      await client.pause('maintenance')
      const paused = await sample()
      await client.resume('finished')
      return { initial, paused, running: await sample() }
    } finally {
      await api.close()
    }
  }

  it('updates status but keeps the refusal from a newer read', async () => {
    const { paused } = await snapshots()
    const { old, newer, first, second } = twoStatusReads()
    newer.resolve(refuse(503, 'unavailable', 'status is temporarily unavailable')())
    await second
    expect(page.getState().statusRefused).toBe('status is temporarily unavailable')
    old.resolve(paused)
    await first
    expect(page.getState().status).toEqual({ paused: true, pauseEpoch: 1 })
    expect(page.getState().statusRefused).toBe('status is temporarily unavailable')
  })

  it('clears a shown refusal when the newer status read succeeds', async () => {
    const { initial } = await snapshots()
    const { old, newer, first, second } = twoStatusReads()
    old.resolve(refuse(503, 'unavailable', 'status is temporarily unavailable')())
    await first
    expect(page.getState().statusRefused).toBe('status is temporarily unavailable')
    newer.resolve(initial)
    await second
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 0 })
    expect(page.getState().statusRefused).toBeNull()
  })

  it('takes running over paused in the same epoch, regardless of read or delivery order', async () => {
    const { old, newer, first, second } = twoStatusReads()
    const { paused, running } = await snapshots()
    const stalePause = paused.clone()
    // The read issued first can sample the board after the other read did.
    newer.resolve(paused)
    await second
    expect(page.getState().status).toEqual({ paused: true, pauseEpoch: 1 })
    old.resolve(running)
    await first
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 1 })
    next.set('GET /control', [() => stalePause])
    await page.loadStatus()
    expect(page.getState().status).toEqual({ paused: false, pauseEpoch: 1 })
  })

  it('does not apply a pause answer from the identity used before switching away and back', async () => {
    const old = Promise.withResolvers<Response>()
    next.set('POST /control/pause', [() => old.promise])
    const writing = page.changePause(true, 'update the worker fleet')
    expect(await page.setProfile({ name: 'reviewer' })).toBe(true)
    expect(await page.setProfile(null)).toBe(true)
    const before = page.getState().status
    old.resolve(Response.json({ paused: true, pauseEpoch: 2 }))
    await writing
    expect(posts('/control/pause')).toContainEqual({ reason: 'update the worker fleet' })
    expect(page.getState().status).toEqual(before)
  })
})

/** A message as the board answers one: a root in `channel`, or a reply to `re`. */
const posted = (id: string, channel: string, text: string, re: string | null = null): MessageView => {
  const { task: _task, ...message } = taskRoot({ channel, text })
  return { ...message, id, version: Number(id), revision: Number(id), re, thread: `t${re ?? id}`, labels: {} } as MessageView
}
const gets = (path: string) => asked.filter((request) => request.method === 'GET' && request.path === path).map((request) => request.query)

describe("the inspector's page, reading", () => {
  it('sees a post made while the sidebar is still loading its channels', async () => {
    next.set('GET /channels', [
      () => Response.json({ channels: [{ path: 'dev', threads: 0, messages: 0, lastIndex: 0 }], cursor: '63', next: 'dev' }),
      () => Response.json({ channels: [{ path: 'ops' }], cursor: '65', next: null }),
    ])
    // A post in dev landed after its page of channels was read, but before the last page.
    const message = posted('64', 'dev', 'osprey nests here')
    const event = { cursor: '64', type: 'message.posted', createdAt: message.createdAt, payload: {}, message }
    next.set('GET /events', [() => Response.json({ events: gets('/events')[0]?.after === '63' ? [event] : [], cursor: '65' })])
    asked.length = 0
    await page.boot()
    await vi.waitFor(() => expect(page.getState().channels.dev).toMatchObject({ threads: 1, messages: 1, lastIndex: 64 }))
    expect(page.getState().messages['64']?.text).toBe(message.text)
  })

  it("asks the board for the threads a filter finds and reads the longer ones whole, and asks a board that can't find them that way once", async () => {
    const root = posted('80', 'ops', 'falcon on the roof')
    const last = posted('83', 'ops', 'gone again', '80')
    usual['GET /threads'] = () => Response.json({ threads: [{ message: root, replies: 3, last }], cursor: '83', older: null })
    usual['GET /messages/80'] = () => Response.json({ message: root, replies: [posted('81', 'ops', 'a falcon?', '80'), posted('82', 'ops', 'yes, a falcon', '80'), last], cursor: '83', schedules: [] })
    asked.length = 0
    await page.loadFiltered('ops', { text: 'falcon', label: [] })
    // The threads with a match, in that channel, then the one longer than its summary: the match may be any message of it.
    expect(gets('/threads')).toEqual([{ channel: 'ops', text: 'falcon', limit: '50' }])
    expect(gets('/messages/80')).toEqual([{}])
    expect(gets('/messages')).toEqual([])
    expect(Object.keys(page.getState().messages)).toEqual(expect.arrayContaining(['80', '81', '82', '83']))

    // A board with no index for it says so, and is asked once: the next filter of its kind shows what's loaded.
    next.set('GET /threads', [refuse(501, 'not_supported', "Vercel's boards don't support reading threads by text yet")])
    asked.length = 0
    await page.loadFiltered('ops', { text: 'kestrel', label: [] })
    await page.loadFiltered('ops', { text: 'merlin', label: [] })
    expect(gets('/threads')).toEqual([{ channel: 'ops', text: 'kestrel', limit: '50' }])
    // What it does find threads by is still asked: a label, there.
    await page.loadFiltered('ops', { label: ['state=open'] })
    expect(gets('/threads').at(-1)).toEqual({ channel: 'ops', label: 'state=open', limit: '50' })
  })
})
