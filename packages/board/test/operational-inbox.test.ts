import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import type { Board } from '../src/server/board.ts'
import { memory } from '../src/store/memory.ts'
import { bearer, board, BOARD_URL, caller, deploymentToken, personToken, testAuth, testBoard } from './harness.ts'

const JULIAN = 'vercel:user:u_julian'
const ADA = 'vercel:user:u_ada'
const PAT = 'vercel:user:u_pat'
const reviewer = { role: 'reviewer' } as const
const direct = (agent: string) => ({ agent })
const fetchOf = (team: Board) => (input: RequestInfo | URL, init?: RequestInit) => team.fetch(new Request(input, init))
const as = (team: Board, token: string) => board({ backend: http(BOARD_URL, { fetch: bearer(fetchOf(team), token) }) }).as(null)
const inboxIds = async (team: Board) => (await team.operationalInbox.read()).messages.map((m) => m.id)
const iso = () => expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/)

async function people(team: Board) {
  const [julian, ada, pat] = await Promise.all(['u_julian', 'u_ada', 'u_pat'].map((user) => personToken(user)))
  return { julian: as(team, julian!), ada: as(team, ada!), pat: as(team, pat!) }
}

describe('operational inbox over HTTP', () => {
  it('addresses a verified principal, not a claimed profile, and authors sends on the server', async () => {
    const team = testBoard()
    const { julian, ada, pat } = await people(team)
    const adaId = (await ada.me()).principal
    const { message } = await julian.as('dispatch').operationalInbox.send({ to: direct(adaId), topic: 'review', text: 'please review' })
    expect(message).toMatchObject({
      id: expect.any(String), to: direct(adaId), topic: 'review', text: 'please review',
      by: { principal: JULIAN, profile: 'dispatch' }, sentAt: iso(), expiresAt: null,
      seenAt: null, actedAt: null, archivedAt: null,
    })
    expect(await ada.as('secondary').operationalInbox.read()).toEqual({ messages: [message] })
    expect(await ada.operationalInbox.read()).toEqual({ messages: [message] })
    expect(await inboxIds(julian)).toEqual([])
    expect(await inboxIds(pat)).toEqual([])

    // A raw request can bring profile and identity-shaped headers, but none is a credential.
    const token = await personToken('u_pat')
    const claimed = caller(team.fetch, token, { 'x-board-profile': 'ada', 'x-board-principal': adaId, 'x-board-agent': adaId })
    expect(await claimed('GET', '/operational-inbox')).toEqual({ status: 200, body: { messages: [] } })
    for (const action of ['ack', 'archive']) {
      const input = action === 'ack' ? { status: 'acted' } : undefined
      const absent = await claimed('POST', `/operational-inbox/${crypto.randomUUID()}/${action}`, input)
      expect(absent.status).toBe(404)
      expect(await claimed('POST', `/operational-inbox/${message.id}/${action}`, input)).toEqual(absent)
    }

    const attempted = await claimed('POST', '/operational-inbox', {
      to: direct(adaId), topic: 'forged send', text: 'from Pat, not Julian',
      by: message.by, sentAt: '2001-01-01T00:00:00.000Z', seenAt: message.sentAt,
      actedAt: message.sentAt, archivedAt: message.sentAt,
    })
    // A server may refuse extra input or discard it. Neither can leave forged provenance.
    if (attempted.status === 400) {
      expect(await inboxIds(ada)).toEqual([message.id])
    } else {
      expect(attempted.status).toBe(201)
      const { message: made } = attempted.body
      expect(made).toMatchObject({ by: { principal: PAT }, sentAt: iso(), seenAt: null, actedAt: null, archivedAt: null })
      expect(Date.parse(made.sentAt)).toBeGreaterThan(Date.parse('2001-01-01T00:00:00.000Z'))
      expect(await inboxIds(ada)).toEqual([made.id, message.id])
    }
    expect((await ada.operationalInbox.read()).messages.at(-1)).toEqual(message)
  })

  it('takes board-wide post to send, and board-wide read to read or change receipts', async () => {
    const team = testBoard()
    const { ada } = await people(team)
    const grantInput = { principals: [{ kind: 'project' as const, project: 'prj_dispatch', environments: ['production'] }] }
    const { grant } = await team.createGrant({ ...grantInput, can: { 'ops/': ['read', 'post'] } })
    // Remove the default grant for deployments of other projects on the team.
    await team.revokeGrant('g2')
    const dispatch = as(team, await deploymentToken('dispatch', 'prj_dispatch', 'production'))
    const to = direct((await dispatch.me()).principal)
    const send = { to, topic: 'review', text: 'please review' }
    const { message } = await ada.operationalInbox.send(send)
    const denied = { status: 403 }

    expect(await dispatch.post('ops/review', 'I can post in this channel')).toMatchObject({ text: 'I can post in this channel' })
    expect((await dispatch.channel('ops/review').messages()).messages).toHaveLength(1)
    await expect(dispatch.operationalInbox.send(send)).rejects.toMatchObject(denied)
    await expect(dispatch.operationalInbox.read()).rejects.toMatchObject(denied)
    await expect(dispatch.operationalInbox.ack(message.id, 'seen')).rejects.toMatchObject(denied)
    await expect(dispatch.operationalInbox.archive(message.id)).rejects.toMatchObject(denied)

    await team.updateGrant(grant.id, { can: { '*': ['read'] } })
    expect(await inboxIds(dispatch)).toEqual([message.id])
    await expect(dispatch.operationalInbox.send(send)).rejects.toMatchObject(denied)
    expect((await dispatch.operationalInbox.ack(message.id, 'seen')).message).toMatchObject({ seenAt: iso(), actedAt: null })
    expect((await dispatch.operationalInbox.archive(message.id)).message).toMatchObject({ archivedAt: iso() })

    // Narrowing applies even to a principal that normally posts and reads board-wide.
    const narrow = ada.as(null, { can: { 'ops/': 'all' } }).operationalInbox
    const own = await ada.operationalInbox.send({ ...send, to: direct(ADA) })
    await expect(narrow.send(send)).rejects.toMatchObject(denied)
    await expect(narrow.read()).rejects.toMatchObject(denied)
    await expect(narrow.ack(own.message.id, 'acted')).rejects.toMatchObject(denied)
    await expect(narrow.archive(own.message.id)).rejects.toMatchObject(denied)
    expect(await ada.operationalInbox.read()).toEqual({ messages: [own.message] })
  })

  it('broadcasts roles but keeps their receipts and archive separate for each member', async () => {
    const team = testBoard({ inboxRoles: { reviewer: [JULIAN, ADA] } })
    const { julian, ada, pat } = await people(team)
    const { message: role } = await pat.operationalInbox.send({ to: reviewer, topic: 'review', text: 'review is open' })
    const { message: personal } = await pat.operationalInbox.send({ to: direct(ADA), topic: 'review', text: 'a detail for Ada' })
    expect(await inboxIds(julian)).toEqual([role.id])
    expect(await inboxIds(ada)).toEqual([personal.id, role.id])
    expect(await inboxIds(pat)).toEqual([])
    await expect(pat.as('reviewer').operationalInbox.ack(role.id, 'seen')).rejects.toMatchObject({ status: 404 })
    await expect(pat.as('reviewer').operationalInbox.archive(role.id)).rejects.toMatchObject({ status: 404 })

    const { message: acted } = await julian.as('delegate').operationalInbox.ack(role.id, 'acted')
    expect(acted).toMatchObject({ seenAt: iso(), actedAt: iso(), archivedAt: null })
    expect(Date.parse(acted.seenAt!)).toBeLessThanOrEqual(Date.parse(acted.actedAt!))
    expect(await julian.operationalInbox.read()).toEqual({ messages: [acted] })
    expect(await ada.operationalInbox.read()).toEqual({ messages: [personal, role] })
    await julian.operationalInbox.archive(role.id)
    expect(await inboxIds(julian)).toEqual([])
    expect(await ada.operationalInbox.read()).toEqual({ messages: [personal, role] })
  })

  it('returns the newest fifteen active messages combined, not a page per recipient', async () => {
    const team = testBoard({ inboxRoles: { reviewer: [ADA] } })
    const { julian, ada } = await people(team)
    const expected: string[] = []
    for (let n = 0; n < 18; n++) {
      const { message } = await julian.operationalInbox.send({ to: n % 2 ? reviewer : direct(ADA), topic: `update ${n}`, text: `update ${n}` })
      expected.unshift(message.id)
    }
    await julian.operationalInbox.send({ to: direct(JULIAN), topic: 'another inbox', text: 'do not count this' })
    expect(await inboxIds(ada)).toEqual(expected.slice(0, 15))
    await ada.operationalInbox.archive(expected[0]!)
    expect(await inboxIds(ada)).toEqual(expected.slice(1, 16))
  })

  it('does not revive a superseded message when its replacement expires', async () => {
    // Advance wall time without sleeping or stubbing the auth, store, or timers.
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    try {
      const team = testBoard()
      const { ada } = await people(team)
      const inbox = ada.operationalInbox
      const send = { to: direct(ADA), topic: 'review', text: 'please review' }
      const { message: old } = await inbox.send(send)
      await expect(inbox.send({ ...send, expiresAt: new Date(now - 1).toISOString() })).rejects.toMatchObject({ status: 400 })
      expect(await inboxIds(ada)).toEqual([old.id])
      const expiresAt = new Date(now + 1_000).toISOString()
      // The same instant as expiresAt, with a non-UTC offset and fractional nanoseconds.
      const offset = new Date(now + 1_000 + 3_600_000).toISOString().replace('Z', '000001+01:00')
      const { message: fresh } = await inbox.send({ ...send, text: 'review before cutoff', expiresAt: offset })
      expect(fresh.expiresAt).toBe(expiresAt)
      const notFound = { status: 404, code: 'operational_message_not_found' }
      await expect(inbox.ack(old.id, 'seen')).rejects.toMatchObject(notFound)
      vi.setSystemTime(now + 999)
      expect(await inbox.read()).toEqual({ messages: [expect.objectContaining({ id: fresh.id, expiresAt, seenAt: null })] })
      vi.setSystemTime(now + 1_000)
      expect(await inboxIds(ada)).toEqual([])
      await expect(inbox.ack(fresh.id, 'acted')).rejects.toMatchObject(notFound)
      await expect(inbox.archive(fresh.id)).rejects.toMatchObject(notFound)
      await expect(inbox.archive(old.id)).rejects.toMatchObject(notFound)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps receipts monotonic across concurrent and repeated writes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const team = testBoard()
      const { ada } = await people(team)
      const inbox = ada.operationalInbox
      const send = { to: direct(ADA), topic: 'review', text: 'review this' }
      const sends = await Promise.all(['first', 'second'].map((text) => inbox.send({ ...send, text })))
      const { messages: [latest, ...older] } = await inbox.read()
      expect(older).toEqual([])
      expect(new Set(sends.map(({ message }) => message.id)).size).toBe(2)
      expect(sends.map(({ message }) => message.id)).toContain(latest!.id)
      const id = latest!.id

      const advance = () => vi.setSystemTime(Date.now() + 1000)
      advance()
      const { message: seen } = await inbox.ack(id, 'seen')
      expect(seen).toMatchObject({ seenAt: iso(), actedAt: null, archivedAt: null })
      advance()
      const acts = await Promise.all(Array.from({ length: 5 }, () => inbox.ack(id, 'acted')))
      const acted = acts[0]!.message
      expect(acted.seenAt).toBe(seen.seenAt)
      expect(Date.parse(acted.actedAt!)).toBeGreaterThan(Date.parse(seen.seenAt!))
      expect(acts.map(({ message }) => message)).toEqual(Array(5).fill(acted))
      advance()
      expect((await inbox.ack(id, 'seen')).message).toEqual(acted)
      expect((await inbox.ack(id, 'acted')).message).toEqual(acted)
      expect(await inbox.read()).toEqual({ messages: [acted] })

      advance()
      const archives = await Promise.all(Array.from({ length: 5 }, () => inbox.archive(id)))
      const archived = archives[0]!.message
      expect(archived).toMatchObject({ seenAt: acted.seenAt, actedAt: acted.actedAt, archivedAt: iso() })
      expect(Date.parse(archived.archivedAt!)).toBeGreaterThan(Date.parse(acted.actedAt!))
      expect(archives.map(({ message }) => message)).toEqual(Array(5).fill(archived))
      advance()
      expect((await inbox.archive(id)).message).toEqual(archived)
      await expect(inbox.ack(id, 'seen')).rejects.toMatchObject({ status: 404 })
      expect(await inboxIds(ada)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it('refuses an acknowledgment that races with a winning archive', async () => {
    const store = memory()
    const team = testBoard({ store })
    const { ada } = await people(team)
    const inbox = ada.operationalInbox
    const { message } = await inbox.send({ to: direct(ADA), topic: 'race', text: 'archive or act' })

    // Let the archive reach the real store first, while the ack has decided it can write.
    const append = store.log.append.bind(store.log)
    let archiveFirst = async () => { await inbox.archive(message.id) }
    store.log.append = async (session, events, options) => {
      if (events.some((event) => event.type === 'operational.acked')) {
        const waiting = archiveFirst
        archiveFirst = async () => {}
        await waiting()
      }
      return append(session, events, options)
    }
    await expect(inbox.ack(message.id, 'acted')).rejects.toMatchObject({ status: 404, code: 'operational_message_not_found' })
    expect((await inbox.archive(message.id)).message).toMatchObject({ seenAt: null, actedAt: null, archivedAt: iso() })
    expect(await inboxIds(ada)).toEqual([])
  })
})

it('lets the local handle receive both direct and explicitly configured role messages', async () => {
  const team = testBoard({ inboxRoles: { reviewer: ['board:client'] } })
  const to = direct((await team.me()).principal)
  const { message: personal } = await team.operationalInbox.send({ to, topic: 'review', text: 'for the local handle' })
  const { message: role } = await team.operationalInbox.send({ to: reviewer, topic: 'review', text: 'for reviewers' })
  expect(await team.operationalInbox.read()).toEqual({ messages: [role, personal] })
})

it('keeps receipts and replacements after reopening SQLite, and checks current role membership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-operational-inbox-'))
  const open = (members: string[]) => {
    const backend = local({ dir })
    const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens(testAuth), inboxRoles: { reviewer: members } })
    return { team, close: () => backend.close() }
  }
  try {
    let visible: Awaited<ReturnType<Board['operationalInbox']['archive']>>['message']
    let archived: typeof visible
    const first = open([JULIAN, ADA])
    try {
      const { julian, ada } = await people(first.team)
      const inbox = julian.operationalInbox
      const send = { to: reviewer, topic: 'review', text: 'review this' }
      await inbox.send(send)
      const { message: latest } = await inbox.send({ ...send, text: 'current review' })
      visible = (await ada.operationalInbox.ack(latest.id, 'acted')).message
      archived = (await inbox.archive(latest.id)).message
    } finally {
      await first.close()
    }
    const second = open([JULIAN, PAT])
    try {
      const { julian, ada, pat } = await people(second.team)
      expect(await inboxIds(ada)).toEqual([])
      await expect(ada.operationalInbox.ack(visible.id, 'seen')).rejects.toMatchObject({ status: 404 })
      await expect(ada.operationalInbox.archive(visible.id)).rejects.toMatchObject({ status: 404 })
      expect(await inboxIds(julian)).toEqual([])
      expect((await julian.operationalInbox.archive(archived.id)).message).toEqual(archived)
      expect(await pat.operationalInbox.read()).toEqual({ messages: [{ ...visible, seenAt: null, actedAt: null }] })
    } finally {
      await second.close()
    }
    const third = open([ADA, PAT])
    try {
      const { ada } = await people(third.team)
      expect(await ada.operationalInbox.read()).toEqual({ messages: [visible] })
    } finally {
      await third.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('does not expose operational sends, receipts or archive in generic feeds, threads, watchers or sync', async () => {
  const watched: string[] = []
  const team = testBoard({ watch: { all: { tail: '--all', run: ({ event }) => void watched.push(event.cursor) } } })
  const { ada, pat } = await people(team)
  const { cursor } = await pat.poll()
  await pat.register({ watch: { all: { tail: '--all' } }, sync: [{ key: 'slack', platform: 'slack' }] })
  const { message } = await ada.operationalInbox.send({ to: direct(ADA), topic: 'private handoff', text: 'eyes only' })
  await ada.operationalInbox.ack(message.id, 'acted')
  await ada.operationalInbox.archive(message.id)
  const control = await ada.post('ops', 'ordinary public post')

  const publicEvents = (await pat.poll({ after: cursor, all: true })).events
  const ordinary = publicEvents.filter((e) => e.type !== 'actor.seen')
  expect(ordinary.map((e) => [e.type, e.message?.id])).toEqual([['message.posted', control.id]])
  expect((await ada.poll({ last: 10, all: true })).events).toEqual(publicEvents)
  const fetch = bearer(fetchOf(team), await personToken('u_pat'))
  const response = await fetch(`${BOARD_URL}/events?all=true&after=${encodeURIComponent(cursor)}`, {
    headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(2_000),
  })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const stream = response.body!.getReader()
  const decoder = new TextDecoder()
  try {
    let frames = ''
    while (!frames.includes('ordinary public post')) {
      const { done, value } = await stream.read()
      if (done) break
      frames += decoder.decode(value, { stream: true })
    }
    expect(frames.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))).toEqual(publicEvents)
  } finally {
    await stream.cancel()
  }
  expect((await pat.threads()).threads.map((t) => t.message.id)).toEqual([control.id])
  await expect(pat.thread(message.id)).rejects.toMatchObject({ status: 404 })
  await expect(ada.thread(message.id)).rejects.toMatchObject({ status: 404 })
  expect(await pat.inbox('slack')).toEqual([])
  await vi.waitFor(() => expect(watched).toEqual([ordinary[0]!.cursor]))
  const matches = await pat.matches({ wait: 1 })
  expect(matches.map((m) => [m.watcher, m.event.type, m.event.message?.id]).sort()).toEqual([
    ['@sync', 'message.posted', control.id], ['all', 'message.posted', control.id],
  ])
})
