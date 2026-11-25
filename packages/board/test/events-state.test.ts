import { describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.default.ts'
import { createBoardClient } from '../src/client/client.ts'
import { board, type EventsState, type ExplainPrincipal } from '../src/server/index.default.ts'

// What a UI on a handle needs beside the data: whether the feed is connected, the permission
// names a grant takes, and the type of the principal `explain` asks about.

const URL_ = 'https://board.example/api/board'
const event = { cursor: '2', type: 'channel.created', createdAt: '2026-10-01T00:00:00.000Z', payload: { channel: 'dev', by: { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null } } }

const down = (): Response => {
  throw new TypeError('fetch failed')
}

/** A stream that says it is connected and then stays open until the caller stops. */
function heldConnected(signal: AbortSignal | undefined) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': connected\n\n'))
      const stop = () => { try { controller.close() } catch { /* already closed */ } }
      if (signal?.aborted) stop()
      else signal?.addEventListener('abort', stop, { once: true })
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

/** A stream that connects and then drops, the way a proxy can reset a live feed. */
function connectedThenDrop() {
  let sent = false
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode(': connected\n\n'))
        return
      }
      controller.error(new Error('dropped'))
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

/**
 * A board elsewhere, as its `/events` behaves: `scripted` answers come first, in turn. After them
 * a stream says `: connected` and stays open, and a poll that asks without waiting is answered at
 * once with nothing new. A poll that waits is held until it's aborted. `waits` is what each poll asked for.
 */
function remote(scripted: (() => Response)[] = []) {
  const waits: (string | null)[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const stream = new Headers(init?.headers).get('accept') === 'text/event-stream'
    if (!stream) waits.push(url.searchParams.get('wait'))
    const answer = scripted.shift()
    if (answer) return answer()
    if (stream) return heldConnected(init?.signal ?? undefined)
    if ((url.searchParams.get('wait') ?? '0') === '0') return Response.json({ events: [], cursor: url.searchParams.get('after') ?? '1' })
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  }) as typeof globalThis.fetch
  return { fetch, waits }
}

/** Follows `events` until the test stops it, keeping what `onState` hears and what arrives. */
function follow(events: (opts: { signal: AbortSignal; onState: (state: EventsState) => void }) => AsyncGenerator<unknown>) {
  const states: EventsState[] = []
  const seen: unknown[] = []
  const stop = new AbortController()
  const done = (async () => {
    for await (const one of events({ signal: stop.signal, onState: (state) => states.push(state) })) seen.push(one)
  })().catch(() => {})
  return { states, seen, stop: () => (stop.abort(), done) }
}

describe('events, told whether it is connected', () => {
  it('is live as soon as the stream says it is connected, and does not long-poll', async () => {
    const { fetch, waits } = remote()
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.states).toEqual(['live']))
    expect(waits).toEqual([])
    await feed.stop()
    expect(feed.states).toEqual(['live'])
  })

  it('is retrying while the stream cannot be reached, and live again as soon as it connects', async () => {
    const { fetch, waits } = remote([down, down])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    // Each change once: a board that can't be reached is never live, and the second failure isn't news.
    await vi.waitFor(() => expect(feed.states).toEqual(['retrying', 'live']), { timeout: 5000 })
    // The retry opened the stream again. It did not sit out a quiet board's 25 second poll.
    expect(waits).toEqual([])
    await feed.stop()
  }, 10_000)

  it('reconnects a stream that drops, without waiting out a long-poll', async () => {
    const { fetch, waits } = remote([connectedThenDrop])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.states).toEqual(['live', 'retrying', 'live']), { timeout: 5000 })
    expect(waits).toEqual([])
    await feed.stop()
  }, 10_000)

  it('yields the events a stream carries, and goes on from its cursor', async () => {
    const body = `: connected\n\nid: 2\nevent: board\ndata: ${JSON.stringify(event)}\n\n`
    const { fetch, waits } = remote([() => new Response(body, { headers: { 'content-type': 'text/event-stream' } })])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.seen).toMatchObject([{ type: 'channel.created', cursor: '2' }]))
    await feed.stop()
    expect(feed.states).toEqual(['live'])
    expect(waits).toEqual([])
  })

  it('long-polls when a proxy buffers the stream and no connected line arrives', async () => {
    let released = false
    const waits: (string | null)[] = []
    const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const stream = new Headers(init?.headers).get('accept') === 'text/event-stream'
      if (stream) {
        return new Response(new ReadableStream({
          cancel() { released = true },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      // A poll before the stream was given up is not the fallback: hold it so this fails without one.
      if (!released) return hang(init)
      waits.push(url.searchParams.get('wait'))
      if ((url.searchParams.get('wait') ?? '0') === '0') return Response.json({ events: [event], cursor: '2' })
      return hang(init)
    }) as typeof globalThis.fetch
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.seen).toMatchObject([{ type: 'channel.created', cursor: '2' }]), { timeout: 8000 })
    expect(feed.states).toEqual(['polling'])
    expect(waits[0]).toBe('0')
    await feed.stop()
  }, 12_000)

  it('tells a client on the stream the same: retrying when it fails, live when the stream opens', async () => {
    const stream = () => new Response(`id: 2\nevent: board\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    const { fetch } = remote([down, stream])
    const client = createBoardClient({ url: URL_, fetch })
    const feed = follow((opts) => client.events({ after: '1' }, opts))
    await vi.waitFor(() => expect(feed.seen).toMatchObject([{ type: 'channel.created' }]), { timeout: 5000 })
    await feed.stop()
    expect(feed.states).toEqual(['retrying', 'live'])
  }, 10_000)
})

describe('what a grant form takes from the package', () => {
  it('lists the permission names, in the order the board shows them', () => {
    expect(PERMISSIONS).toEqual(['read', 'post', 'react', 'label', 'sync', 'manage'])
  })
})

// `ExplainPrincipal` is a type, so the type check is its test: without the export, this line fails `pnpm typecheck`.
const whom: ExplainPrincipal = { project: 'web', environment: 'preview' }
void whom
