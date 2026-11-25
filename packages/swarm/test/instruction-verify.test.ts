import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { board, type Board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, localUserToken, testLocal } from '../../board/test/tokens.ts'

type Run = { status: number | null; stdout: string; stderr: string; methods: string[] }

type Posted = { id: string; author: { kind: string; handle: string; verified?: true } | null }

async function listen(t: TestContext, onRequest: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(onRequest)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  return address.port
}

async function fixture(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const boardMethods: string[] = []
  const port = await listen(t, async (req, res) => {
    boardMethods.push(req.method ?? '')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    try {
      const response = await team.fetch(new Request(`${BOARD_URL}${req.url!.slice('/api/board'.length)}`, {
        method: req.method,
        headers: new Headers(req.headers as Record<string, string>),
        body: req.method === 'GET' || req.method === 'HEAD' || !chunks.length ? undefined : Buffer.concat(chunks),
      }))
      const headers = Object.fromEntries(response.headers)
      delete headers['transfer-encoding']
      res.writeHead(response.status, headers)
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      res.writeHead(500).end()
    }
  })
  const bonklek = await localUserToken('bonklek')
  const ada = await localUserToken('ada')
  const reader = await localUserToken('reader')
  const post = async (token: string, body: { channel?: string; re?: string; text: string }, profile?: string): Promise<Posted> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/board/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(profile ? { 'x-board-profile': profile } : {}),
      },
      body: JSON.stringify(body),
    })
    const payload = await response.json() as { message?: Posted }
    assert.equal(response.status, 201, 'post')
    assert.ok(payload.message)
    return payload.message
  }
  const run = (id: string, from: string | null, extra: string[] = []) => new Promise<Run>((resolve, reject) => {
    const start = boardMethods.length
    const args = ['src/cli.ts', 'instruction', 'verify', id]
    if (from !== null) args.push('--from', from)
    args.push('--board', `http://127.0.0.1:${port}/api/board`, ...extra)
    execFile(process.execPath, args, {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: tmpdir(), BOARD_TOKEN: reader },
    }, (error, stdout, stderr) => {
      const status = typeof error?.code === 'number' ? error.code : error ? null : 0
      if (error && status === null) reject(error)
      else resolve({ status, stdout, stderr, methods: boardMethods.slice(start) })
    })
  })
  return { team, post, run, bonklek, ada }
}

test('a verified person message exits 0 only for that handle', async (t) => {
  const { team, post, run, bonklek } = await fixture(t)
  const message = await post(bonklek, { channel: 'notes', text: 'ship it' })
  assert.equal(message.author?.kind, 'person')
  assert.equal(message.author?.verified, true)
  assert.equal(message.author?.handle, 'bonklek')
  const before = await team.thread(message.id)
  const match = await run(message.id, 'bonklek')
  assert.equal(match.stderr, '')
  assert.equal(match.stdout, 'verified\n')
  assert.equal(match.status, 0)
  assert.deepEqual([...new Set(match.methods)], ['GET'])
  assert.deepEqual(await team.thread(message.id), before)
  const prefixed = await run(message.id, '@bonklek')
  assert.equal(prefixed.status, 0)
  assert.equal(prefixed.stdout, 'verified\n')
  const other = await run(message.id, 'ada')
  assert.equal(other.status, 1)
  assert.equal(other.stdout, 'author is bonklek, not ada\n')
  assert.equal(other.stderr, '')
  assert.deepEqual([...new Set(other.methods)], ['GET'])
})

test('a quote of the handle is the poster, not the person named in the text', async (t) => {
  const { post, run, ada } = await fixture(t)
  const message = await post(ada, { channel: 'notes', text: 'bonklek said ship it' })
  assert.equal(message.author?.kind, 'person')
  assert.equal(message.author?.verified, true)
  assert.equal(message.author?.handle, 'ada')
  const result = await run(message.id, 'bonklek')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, 'author is ada, not bonklek\n')
  assert.equal(result.stderr, '')
  assert.deepEqual([...new Set(result.methods)], ['GET'])
  const hers = await run(message.id, 'ada')
  assert.equal(hers.status, 0)
  assert.equal(hers.stdout, 'verified\n')
})

test('a reply is its own author, not the root', async (t) => {
  const { post, run, bonklek, ada } = await fixture(t)
  const root = await post(bonklek, { channel: 'notes', text: 'ship it' })
  const reply = await post(ada, { re: root.id, text: 'bonklek said ship it' })
  assert.equal(reply.author?.handle, 'ada')
  const result = await run(reply.id, 'bonklek')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, 'author is ada, not bonklek\n')
  const hers = await run(reply.id, 'ada')
  assert.equal(hers.status, 0)
  assert.equal(hers.stdout, 'verified\n')
})

test('a verified agent is not the person, including under its own handle', async (t) => {
  const { post, run, bonklek } = await fixture(t)
  const message = await post(bonklek, { channel: 'notes', text: 'ship it' }, 'worker')
  assert.equal(message.author?.kind, 'agent')
  assert.equal(message.author?.verified, true)
  assert.equal(message.author?.handle, 'bonklek/worker')
  const asAgent = await run(message.id, 'bonklek/worker')
  assert.equal(asAgent.status, 1)
  assert.equal(asAgent.stdout, 'author is an agent, not a person\n')
  assert.equal(asAgent.stderr, '')
  const asPerson = await run(message.id, 'bonklek')
  assert.equal(asPerson.status, 1)
  assert.equal(asPerson.stdout, 'author is an agent, not a person\n')
})

test('the board own post is not a verified person', async (t) => {
  const { team, run } = await fixture(t)
  const message = await team.post('notes', 'bonklek said ship it')
  assert.notEqual(message.author?.verified, true)
  const result = await run(message.id, message.author?.handle ?? 'client')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, 'author is not verified\n')
  assert.equal(result.stderr, '')
})

test('a missing message exits 1', async (t) => {
  const { run } = await fixture(t)
  const result = await run('999999', 'bonklek')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, 'no such message\n')
  assert.equal(result.stderr, '')
})

test('missing arguments exit 2', async (t) => {
  const { run } = await fixture(t)
  const noFrom = await run('1', null)
  assert.equal(noFrom.status, 2)
  assert.match(noFrom.stderr, /^error: expected --from <handle>\n/)
  assert.deepEqual(noFrom.methods, [])
  const noId = await new Promise<Run>((resolve, reject) => {
    execFile(process.execPath, ['src/cli.ts', 'instruction', 'verify', '--from', 'bonklek'], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: tmpdir() },
    }, (error, stdout, stderr) => {
      const status = typeof error?.code === 'number' ? error.code : error ? null : 0
      if (error && status === null) reject(error)
      else resolve({ status, stdout, stderr, methods: [] })
    })
  })
  assert.equal(noId.status, 2)
  assert.match(noId.stderr, /^error: expected a message id\n/)
})
