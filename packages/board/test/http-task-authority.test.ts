import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { BoardError, createBoardClient } from '../src/client/client.ts'
import { BOARD_URL, board, localBoard, personToken } from './harness.ts'

const actor = { principal: 'vercel:user:u_ada', actor: 'vercel:user:u_ada' }
const binding = {
  controller: actor,
  owner: actor,
  provider: 'fixture-provider',
  model: 'fixture-model',
  session: 'assignment-1',
  branch: 'work/assignment',
  worktree: '/fixture/worktrees/assignment',
  baseCommit: 'a'.repeat(40),
}

// Inspect only the outcome: a successful legacy claim would answer a secret.
const outcome = (write: Promise<unknown>) => write.then(() => 'succeeded', (error: unknown) => {
  if (!(error instanceof BoardError)) throw error
  return `${error.status} ${error.code}`
})

let team: ReturnType<typeof localBoard>
let token: string
beforeEach(async () => {
  team = localBoard()
  token = await personToken('u_ada')
})
afterEach(() => team.close())

const fetchBoard: typeof fetch = (input, init) => team.fetch(new Request(input, init))

/** An old server ignores unknown properties, but doesn't serve the new bound-only paths. */
function olderServer(capability?: unknown): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const path = request.url.slice(BOARD_URL.length).replace(/\/$/, '')
    if (request.method === 'GET' && path === '') {
      const discovery = await (await team.fetch(request)).json()
      return Response.json({ ...discovery, task_authority: capability })
    }
    if (request.method !== 'POST') return team.fetch(request)
    if (!/^\/tasks(?:\/claim|\/[^/]+\/claim)?$/.test(path)) {
      return Response.json({ error: { code: 'not_found', message: 'no route' } }, { status: 404 })
    }
    return stripBinding(request)
  }
}

async function stripBinding(request: Request): Promise<Response> {
  const body = await request.json()
  delete body.binding
  return team.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }))
}

const direct = (fetch: typeof globalThis.fetch = fetchBoard) => createBoardClient({ url: BOARD_URL, token, fetch })
const viaHttp = (fetch: typeof globalThis.fetch) => board({ backend: http(BOARD_URL, {
  fetch: (input, init) => {
    const request = new Request(input, init)
    if (request.method === 'POST') request.headers.set('authorization', `Bearer ${token}`)
    return fetch(request)
  },
}) }).as(null)

async function expectNoWrite(client: ReturnType<typeof direct>, rejected: string) {
  const owner = direct()
  const { task: ready } = await owner.tasks.create('work', 'already a task')
  const root = await owner.post('adopt', 'not yet a task')
  const outcomes = [
    await outcome(client.tasks.claim(ready.id, { binding })),
    await outcome(client.tasks.claim({ channel: 'work', binding })),
    await outcome(client.tasks.create('new', { text: 'new task', claim: true, binding })),
    await outcome(client.tasks.create({ re: root.id }, { claim: true, binding })),
  ]
  // Check the log's public projection, not just whether the client noticed an error.
  expect((await owner.thread(ready.id)).message.task?.state).toBe('ready')
  expect((await owner.thread(root.id)).message.task ?? null).toBeNull()
  expect((await owner.tasks.list({ channel: 'new' })).tasks).toHaveLength(0)
  expect(outcomes).toEqual([rejected, rejected, rejected, rejected])
  // Legacy calls still work against that endpoint.
  expect((await client.tasks.claim(ready.id)).task.task?.state).toBe('claimed')
  expect((await client.tasks.create('new', { text: 'legacy', claim: true })).task.task?.state).toBe('claimed')
}

describe('bound task writes over HTTP', () => {
  it('refuses before writing when an older board does not advertise task authority', async () => {
    await expectNoWrite(viaHttp(olderServer()), '501 no_task_authority')
  })

  it('requires a real boolean capability from discovery', async () => {
    await expectNoWrite(viaHttp(olderServer('true')), '501 no_task_authority')
  })

  it('cannot write through an old server even when discovery came from a new one', async () => {
    await expectNoWrite(viaHttp(olderServer(true)), '404 not_found')
  })

  it('does not downgrade when calling an older server directly', async () => {
    await expectNoWrite(direct(olderServer()), '404 not_found')
  })

  it('cannot write when an intermediary strips the binding', async () => {
    const stripped: typeof fetch = (input, init) => {
      const request = new Request(input, init)
      return request.method === 'POST' ? stripBinding(request) : team.fetch(request)
    }
    await expectNoWrite(viaHttp(stripped), '400 invalid_request')
  })

  it('retains the binding when forwarding to a board that supports it', async () => {
    const client = viaHttp(fetchBoard)
    expect((await client.discovery()).task_authority).toBe(true)
    const { task } = await client.tasks.create('work', 'a ready task')
    const claim = await client.tasks.claim(task.id, { binding })
    expect(claim.binding).toEqual(binding)
    await claim.release()
    expect((await client.tasks.claim({ channel: 'work', binding }))?.binding).toEqual(binding)
    expect((await client.tasks.create('work', { text: 'new', claim: true, binding })).claim?.binding).toEqual(binding)
    const message = await direct().post('work', 'adopt this')
    expect((await client.tasks.create({ re: message.id }, { claim: true, binding })).claim?.binding).toEqual(binding)
  })
})
