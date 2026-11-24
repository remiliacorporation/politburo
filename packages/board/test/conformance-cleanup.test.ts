import { expect, it } from 'vitest'
import type { Discovery, MessageView, ThreadView } from '../src/api/routes.ts'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { bearer, BOARD_URL, localBoard, personToken } from './harness.ts'

type Fetch = (request: Request) => Promise<Response>

const CHANNEL = 'conformance'
const RUN_HEALTH = 'confirms a claimed run only through a taken and reported status probe'
const TOMBSTONE = 'deletes a message, leaving a tombstone'
const INVITE_ACCESS = 'lets a joined caller read and post only as granted'
const NOT_THE_RUNS = "conformance: not the run's"
const pathOf = (request: Request) => new URL(request.url).pathname
const mountPath = new URL(BOARD_URL).pathname
const messagePath = (id: string) => `${mountPath}/messages/${encodeURIComponent(id)}`

const handle = async (fetch: Fetch, token = personToken()) => board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), await token) }) }).as(null)

/** The invitee uses only its own bearer, and rejects redirects. */
const inviteBackend = (fetch: Fetch, token: string) => http(BOARD_URL, {
  fetch: (input, init) => {
    const request = new Request(input, { ...init, redirect: 'error' })
    request.headers.set('authorization', `Bearer ${token}`)
    return fetch(request)
  },
})
const invitee = (fetch: Fetch, token: string) => board({ backend: inviteBackend(fetch, token) }).as(null)

/** The ID of what a request that made something with `text` answered, or null. */
function madeBy(sent: string, response: Response, text: string): Promise<string | null> {
  if (!sent || !response.ok) return Promise.resolve(null)
  const body = (() => { try { return JSON.parse(sent) as { text?: string } } catch { return null } })()
  if (body?.text !== text) return Promise.resolve(null)
  return response.clone().json().then((answered: { message?: { id: string }; task?: { id: string } }) => answered.message?.id ?? answered.task?.id ?? null)
}

/** A mount that switches boards around a probe's create. Both boards have the same ID under the same principal. */
async function swapping(text: string, onTestFinished: (cleanup: () => void) => void, swapOn: 'create' | 'read-back' = 'read-back') {
  const first = localBoard({ agentOps: true })
  const second = localBoard({ agentOps: true })
  onTestFinished(() => { first.close(); second.close() })
  const elsewhere = await handle(second.fetch)
  let mount: Fetch = first.fetch
  let created: string | null = null
  let swapped = false
  let readBack = false
  /** Posts on the second board until it has a message under `id`. */
  const plant = async (id: string) => {
    // A colliding scratch post can even have the same text, but not this run's label.
    const plantedText = swapOn === 'create' ? text : NOT_THE_RUNS
    for (let made = { id: '0' }; Number(made.id) < Number(id); ) made = await elsewhere.post(CHANNEL, { text: plantedText, noSync: true })
    expect((await elsewhere.thread(id)).message.text).toBe(plantedText)
  }
  const fetch: Fetch = async (request) => {
    if (created !== null && !swapped && (swapOn === 'create' || readBack)) {
      swapped = true
      mount = second.fetch
      await plant(created)
    }
    const sent = request.method === 'POST' ? await request.clone().text() : ''
    const response = await mount(request)
    if (created === null) created = await madeBy(sent, response, text)
    else if (request.method === 'GET' && pathOf(request) === messagePath(created)) readBack = true
    return response
  }
  return { client: await handle(fetch), fetch, elsewhere, planted: () => (swapped ? created : null) }
}

/** What the second board still has under `id`. */
const survives = async (elsewhere: Awaited<ReturnType<typeof handle>>, id: string) => {
  const { message } = await elsewhere.thread(id)
  return { text: message.text, deleted: message.deleted }
}

it("leaves another board's message alone, and reports it, when the mount changes boards after the run-health probe is made", async ({ onTestFinished }) => {
  const { client, elsewhere, planted } = await swapping('conformance: run health', onTestFinished)
  const report = await conformance(client, { channel: CHANNEL })
  const id = planted()
  expect(id).not.toBeNull()
  // The same ID, by the same principal, on a board the probe was never made on.
  expect(await survives(elsewhere, id!)).toEqual({ text: NOT_THE_RUNS, deleted: false })
  expect(report.checks.find(({ name }) => name === RUN_HEALTH)).toMatchObject({
    status: 'failed', detail: expect.stringMatching(new RegExp(`${id} is not the message this run created .*, so it was not touched`)),
  })
  expect(report.ok).toBe(false)
}, 60_000)

it("fails a delete a check makes rather than send it to another board's message with the same ID", async ({ onTestFinished }) => {
  const { client, elsewhere, planted } = await swapping('conformance: to delete', onTestFinished)
  const report = await conformance(client, { channel: CHANNEL })
  const id = planted()
  expect(id).not.toBeNull()
  expect(await survives(elsewhere, id!)).toEqual({ text: NOT_THE_RUNS, deleted: false })
  // The check says it once, as the delete it didn't make: the end of the run doesn't repeat it.
  const check = report.checks.find(({ name }) => name === TOMBSTONE)
  expect(check).toMatchObject({ status: 'failed', detail: expect.stringContaining(`${id} is not the message this run created`) })
  expect(check!.detail!.match(new RegExp(`${id} is not the message this run created`, 'g'))).toHaveLength(1)
  expect(report.ok).toBe(false)
}, 60_000)

it("leaves another board's message alone when the mount changes boards after an invitee's post, which only the invitee can delete", async ({ onTestFinished }) => {
  const { client, fetch, elsewhere, planted } = await swapping('conformance: joined caller', onTestFinished)
  const report = await conformance(client, { channel: CHANNEL, withInviteToken: (token) => invitee(fetch, token) })
  const id = planted()
  expect(id).not.toBeNull()
  expect(await survives(elsewhere, id!)).toEqual({ text: NOT_THE_RUNS, deleted: false })
  expect(report.checks.find(({ name }) => name === INVITE_ACCESS)).toMatchObject({
    status: 'failed', detail: 'deleting the invitee posts: left 1 (could not confirm the post)',
  })
  expect(report.ok).toBe(false)
}, 90_000)

it('does not adopt a colliding message when the mount changes before read-back', async ({ onTestFinished }) => {
  const text = 'conformance: to delete'
  const { client, elsewhere, planted } = await swapping(text, onTestFinished, 'create')
  const report = await conformance(client, { channel: CHANNEL })
  const id = planted()
  expect(id).not.toBeNull()
  expect(await survives(elsewhere, id!)).toEqual({ text, deleted: false })
  expect(report.checks.find(({ name }) => name === TOMBSTONE)).toMatchObject({
    status: 'failed', detail: expect.stringContaining(`${id} is not the message this run created`),
  })
}, 60_000)

it.for(['create', 'read-back', 'cleanup', 'unchanged'] as const)("uses the invitee's board identity from create through cleanup (%s)", { timeout: 60_000 }, async (when, { onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const admin = await handle(team.fetch)
  const text = 'conformance: joined caller'
  let id: string | null = null
  let project = when === 'unchanged' ? 'prj_invitee' : null
  const withInviteToken = (token: string) => {
    const member: Fetch = async (request) => {
      const sent = request.method === 'POST' ? await request.clone().text() : ''
      const response = await team.fetch(request)
      if (id === null) {
        id = await madeBy(sent, response, text)
        if (id !== null && (when === 'create' || when === 'read-back')) project = 'prj_replacement'
      } else if (request.method === 'GET' && pathOf(request) === `${mountPath}/invites`) {
        if (when === 'cleanup') project = 'prj_replacement'
        if (when === 'read-back') project = null
      }
      return response
    }
    // Only discovery differs, as when a mount is pointed at a copy of the board.
    const backend = {
      ...inviteBackend(member, token),
      async discovery(): Promise<Discovery> {
        const info = await admin.discovery()
        return project === null ? info : { ...info, project_id: project }
      },
    }
    return board({ backend }).as(null)
  }
  const report = await conformance(admin, { channel: CHANNEL, withInviteToken })
  expect(id).not.toBeNull()
  const check = report.checks.find(({ name }) => name === INVITE_ACCESS)
  if (when === 'unchanged') {
    expect(await survives(admin, id!)).toEqual({ text: '', deleted: true })
    expect(check?.status).toBe('passed')
  } else {
    expect(await survives(admin, id!)).toEqual({ text, deleted: false })
    expect(check).toMatchObject({ status: 'failed', detail: expect.stringContaining('deleting the invitee posts: left 1') })
  }
})

it.for(['missing', 'changed', 'paged'] as const)('uses the reply itself for cleanup when the reply is %s', { timeout: 60_000 }, async (view, { onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const unfiltered = await handle(team.fetch)
  const text = 'conformance: a reply under it'
  let root: string | null = null
  let made: MessageView | undefined
  let rootDeleted = false
  const client = await handle(async (request) => {
    const path = pathOf(request)
    if (made && request.method === 'GET') {
      if (view === 'paged' && (path === messagePath(made.id) || path === messagePath(made.re!))) {
        // The server only shows one reply per page, the newest without an `after`.
        const url = new URL(request.url)
        url.searchParams.set('limit', '1')
        return team.fetch(new Request(url, request))
      }
      if (view !== 'paged' && path === messagePath(made.id)) {
        const thread: ThreadView = await (await team.fetch(request)).json()
        // The parent looks like a match, but proves nothing about the reply.
        const { id, createdAt } = made
        thread.message.createdAt = createdAt
        if (rootDeleted) {
          thread.replies = view === 'missing' ? thread.replies.filter((reply) => reply.id !== id)
            : thread.replies.map((reply) => reply.id === id ? { ...reply, by: { ...reply.by, principal: 'vercel:user:u_other' } } : reply)
        }
        return Response.json(thread)
      }
    }
    const sent = request.method === 'POST' ? await request.clone().text() : ''
    const response = await team.fetch(request)
    if (root === null) {
      root = await madeBy(sent, response, 'conformance: a labeled root to delete')
      if (root !== null && view === 'paged') await unfiltered.reply(root, 'older reply')
    }
    if (!made && await madeBy(sent, response, text)) {
      const { message } = await response.clone().json() as { message: MessageView }
      made = message
      if (view === 'paged') await unfiltered.reply(message.re!, 'newer reply')
    }
    if (root !== null && request.method === 'POST' && path === `${messagePath(root)}/delete` && response.ok) rootDeleted = true
    return response
  })
  const report = await conformance(client, { channel: CHANNEL })
  expect(made).toBeDefined()
  const { id } = made!
  const { replies } = await unfiltered.thread(id)
  const check = report.checks.find(({ name }) => name === 'drops a deleted message from what its labels find')
  if (view === 'paged') {
    expect(replies.find((reply) => reply.id === id)).toMatchObject({ deleted: true })
    expect(check?.status).toBe('passed')
  } else {
    expect(replies.find((reply) => reply.id === id)).toMatchObject({ text, deleted: false })
    expect(check).toMatchObject({ status: 'failed', detail: expect.stringContaining(`${id} is not the message this run created`) })
  }
})

it('leaves and reports a post whose cleanup read returns 404', async ({ onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const text = 'conformance: while it waits'
  let id: string | null = null
  let hidden = false
  const client = await handle(async (request) => {
    if (hidden && request.method === 'GET' && pathOf(request) === messagePath(id!))
      return Response.json({ error: { code: 'message_not_found', message: 'not visible here' } }, { status: 404 })
    const sent = request.method === 'POST' ? await request.clone().text() : ''
    const response = await team.fetch(request)
    id ??= await madeBy(sent, response, text)
    if (id !== null && await madeBy(sent, response, 'conformance: to delete')) hidden = true
    return response
  })
  const report = await conformance(client, { channel: CHANNEL })
  expect(id).not.toBeNull()
  expect(await survives(await handle(team.fetch), id!)).toEqual({ text, deleted: false })
  expect(report.checks.find(({ name }) => name === 'holds a long-poll open until the next event')).toMatchObject({
    status: 'failed', detail: expect.stringContaining('HTTP 404'),
  })
}, 60_000)

it('keeps echoed credentials out of the invite cleanup report', async ({ onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const text = 'conformance: joined caller'
  const echoed = 'vbj_fake-bearer-in-provenance'
  let id: string | null = null
  let echo = false
  const fetch: Fetch = async (request) => {
    const sent = request.method === 'POST' ? await request.clone().text() : ''
    const response = await team.fetch(request)
    id ??= await madeBy(sent, response, text)
    // Change the view only after the invitee tests its lack of admin access.
    if (pathOf(request) === `${mountPath}/invites` && request.method === 'GET' && response.status === 403) echo = true
    if (echo && id !== null && request.method === 'GET' && pathOf(request) === messagePath(id) && response.ok) {
      const thread: ThreadView = await response.json()
      const { message } = thread
      return Response.json({ ...thread, message: { ...message, channel: echoed, createdAt: echoed, by: { ...message.by, principal: echoed } } })
    }
    return response
  }
  const report = await conformance(await handle(fetch), { channel: CHANNEL, withInviteToken: (token) => invitee(fetch, token) })
  expect(JSON.stringify(report)).not.toContain(echoed)
  expect(id).not.toBeNull()
  expect(await survives(await handle(team.fetch), id!)).toEqual({ text, deleted: false })
  expect(report.checks.find(({ name }) => name === INVITE_ACCESS)).toMatchObject({
    status: 'failed', detail: 'deleting the invitee posts: left 1 (could not confirm the post)',
  })
}, 60_000)

it("leaves another admin's grant after a refused batch", async ({ onTestFinished }) => {
  const team = localBoard()
  onTestFinished(() => team.close())
  const other = await handle(team.fetch, personToken('u_other'))
  const can = { [`${CHANNEL}/grants/other-admin/`]: ['read'] as const }
  let id: string | undefined
  const client = await handle(async (request) => {
    const response = await team.fetch(request)
    if (request.method === 'POST' && pathOf(request) === `${mountPath}/grants/batch` && response.status === 400) {
      const { grant } = await other.createGrant({ principals: [{ kind: 'project', project: 'prj_docs', environments: ['preview'] }], can })
      id = grant.id
    }
    return response
  })
  const report = await conformance(client, { channel: CHANNEL })
  expect(id).toBeDefined()
  expect((await client.grants()).find((grant) => grant.id === id)).toMatchObject({ can })
  expect(report.checks.find(({ name }) => name.startsWith('makes several grants in one write'))).toMatchObject({
    status: 'failed', detail: expect.stringContaining('1 added and 0 missing'),
  })
}, 60_000)
