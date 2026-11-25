import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { board, type Board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, localUserToken, testLocal } from '../../board/test/tokens.ts'

const source = `kept line
COLOR=blue
Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789
authorization: Basic dXNlcjpwYXNz
API_TOKEN=super-secret-value
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI
MONKEY=banana
a token sits in this sentence
saw ghp_0123456789abcdefghijklmnop today
token: plain-token-value
key: plain-key-value
sk-live-0123456789abcdef
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
AKIAIOSFODNN7EXAMPLE
before key
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0123456789abcdef
-----END RSA PRIVATE KEY-----
after key
`

const redacted = `kept line
COLOR=blue
Authorization: [redacted]
authorization: [redacted]
API_TOKEN=[redacted]
export AWS_SECRET_ACCESS_KEY=[redacted]
MONKEY=banana
a token sits in this sentence
saw [redacted] today
token: [redacted]
key: [redacted]
[redacted]
[redacted]
[redacted]
before key
[redacted]
after key
`

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
  const port = await listen(t, async (req, res) => {
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
  const url = `http://127.0.0.1:${port}/api/board`
  const ada = await localUserToken('ada')
  const dir = mkdtempSync(join(tmpdir(), 'trace-attach-'))
  const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['src/cli.ts', ...args], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: tmpdir(), BOARD_TOKEN: ada },
    }, (error, stdout, stderr) => {
      const status = typeof error?.code === 'number' ? error.code : error ? null : 0
      if (error && status === null) reject(error)
      else resolve({ status, stdout, stderr })
    })
  })
  return { team, url, dir, run }
}

async function textOf(team: Board, id: string): Promise<string> {
  return await (await team.download(id)).text()
}

test('attach redacts each secret, leaves the rest, and labels the file', async (t) => {
  const { team, url, dir, run } = await fixture(t)
  const task = await team.tasks.create('work', 'read the trace')
  const path = join(dir, 'agent.txt')
  writeFileSync(path, source)
  const ran = await run(['trace', 'attach', task.task.id, '--kind', 'transcript', '--file', path, '--source', 'https://example.test/job/1', '--board', url])
  assert.equal(ran.stderr, '')
  assert.equal(ran.status, 0)
  const thread = await team.thread(task.task.id)
  const reply = thread.replies.find((message) => message.labels['trace.kind'] === 'transcript')
  assert.ok(reply)
  assert.equal(reply.labels['trace.source'], 'https://example.test/job/1')
  assert.equal(reply.attachments?.[0]?.name, 'agent.txt')
  assert.equal(ran.stdout, `attached  ${reply.id}  transcript  agent.txt\n`)
  const body = await textOf(team, reply.attachments![0]!.id)
  assert.equal(body, redacted)
  assert.equal(body.includes('ghp_'), false)
  assert.equal(body.includes('super-secret-value'), false)
  assert.equal(body.includes('wJalrXUtnFEMI'), false)
  assert.equal(body.includes('plain-token-value'), false)
  assert.equal(body.includes('plain-key-value'), false)
  assert.equal(body.includes('MIIEow'), false)
  assert.equal(body.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.equal(body.includes('sk-live-'), false)
  assert.equal(body.includes('eyJhbGci'), false)
  assert.equal(body.includes('dXNlcjpwYXNz'), false)
  assert.equal(body.includes('kept line'), true)
  assert.equal(body.includes('COLOR=blue'), true)
  assert.equal(body.includes('MONKEY=banana'), true)
  assert.equal(body.includes('a token sits in this sentence'), true)
})

test('a second attach keeps the earlier file', async (t) => {
  const { team, url, dir, run } = await fixture(t)
  const task = await team.tasks.create('work', 'two files')
  const first = join(dir, 'one.log')
  const second = join(dir, 'two.log')
  writeFileSync(first, 'first file\n')
  writeFileSync(second, 'second file\n')
  const a = await run(['trace', 'attach', task.task.id, '--kind', 'log', '--file', first, '--board', url])
  const b = await run(['trace', 'attach', task.task.id, '--kind', 'log', '--file', second, '--board', url])
  assert.equal(a.status, 0)
  assert.equal(b.status, 0)
  const thread = await team.thread(task.task.id)
  const files = thread.replies.filter((message) => message.labels['trace.kind'] === 'log')
  assert.equal(files.length, 2)
  const bodies = await Promise.all(files.map((message) => textOf(team, message.attachments![0]!.id)))
  assert.deepEqual(bodies.sort(), ['first file\n', 'second file\n'])
})

test('trace attach rejects a bad kind and a missing file', async (t) => {
  const { url, run } = await fixture(t)
  const kind = await run(['trace', 'attach', '1', '--kind', 'note', '--file', 'missing.txt', '--board', url])
  assert.equal(kind.status, 2)
  assert.match(kind.stderr, /^error: expected --kind transcript\|log\|ci\n/)
  const missing = await run(['trace', 'attach', '1', '--kind', 'log', '--file', join(tmpdir(), 'no-such-trace.txt'), '--board', url])
  assert.equal(missing.status, 1)
  assert.equal(missing.stderr, 'error: no such file\n')
})
