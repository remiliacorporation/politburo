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

const sha = 'a'.repeat(40)
const other = 'b'.repeat(64)

type Run = { status: number | null; stdout: string; stderr: string }

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
  const token = await localUserToken('worker')
  const run = (...args: string[]) => new Promise<Run>((resolve, reject) => {
    execFile(process.execPath, ['src/cli.ts', 'review', ...args, '--board', `http://127.0.0.1:${port}/api/board`], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: tmpdir(), BOARD_TOKEN: token },
    }, (error, stdout, stderr) => {
      const status = typeof error?.code === 'number' ? error.code : error ? null : 0
      if (error && status === null) reject(error)
      else resolve({ status, stdout, stderr })
    })
  })
  return { team, run }
}

function followUps(stdout: string): string[] {
  return stdout.split('\n').flatMap((line) => {
    const match = /^follow-up\s{2}(\d+)$/.exec(line)
    return match ? [match[1]!] : []
  })
}

test('review record posts the attestation and labels that head pass', async (t) => {
  const { team, run } = await fixture(t)
  const { task } = await team.tasks.create('work/acme', { text: 'Ship the review record' })
  const result = await run('record', task.id, 'pass', '--head', sha.toUpperCase(), '--finding', 'note the spelling')
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `recorded  pass\nhead      ${sha}\n`)
  const root = await team.thread(task.id)
  assert.equal(root.message.labels['review.verdict'], 'pass')
  assert.equal(root.message.labels['review.head'], sha)
  assert.equal(root.replies.map((reply) => reply.text).join('\n'), `review pass\nhead ${sha}\nnote the spelling`)
  assert.deepEqual(followUps(result.stdout), [])
})

test('review record labels a blocked head and leaves the task waiting for nothing new', async (t) => {
  const { team, run } = await fixture(t)
  const { task } = await team.tasks.create('work/acme', { text: 'Hold the merge' })
  const result = await run('record', task.id, 'blocked', '--head', other)
  assert.equal(result.status, 0, result.stderr)
  const root = await team.thread(task.id)
  assert.equal(root.message.labels['review.verdict'], 'blocked')
  assert.equal(root.message.labels['review.head'], other)
  assert.equal(root.message.task?.needs.length, 0)
  assert.equal(root.replies[0]?.text, `review blocked\nhead ${other}`)
})

test('follow-up opens a plb/work task for each blocking finding and names the source', async (t) => {
  const { team, run } = await fixture(t)
  const { task } = await team.tasks.create('work/acme', { text: 'Review the grant change' })
  const blocking = 'BLOCKING the deny list is dropped'
  const later = 'FOLLOW-UP: record the audit gap'
  const result = await run(
    'record', task.id, 'blocked', '--head', sha, '--follow-up',
    '--finding', blocking, '--finding', 'note the spelling', '--finding', later,
  )
  assert.equal(result.status, 0, result.stderr)
  const ids = followUps(result.stdout)
  assert.equal(ids.length, 2)
  const opened = []
  for (const id of ids) {
    const view = await team.thread(id)
    opened.push(view.message)
    assert.equal(view.message.channel, 'plb/work')
    assert.equal(view.message.task?.needs.length, 0)
    assert.equal(view.message.task?.state, 'ready')
    assert.equal(view.message.task?.blocked, null)
    assert.equal(view.message.labels['review.source'], task.id)
    assert.ok(view.message.text.endsWith(`\nsource ${task.id}`))
  }
  assert.deepEqual(opened.map((message) => message.text.split('\n')[0]), [blocking, later])
  const page = await team.tasks.list({ state: 'all', channel: 'plb/work' })
  assert.deepEqual(page.tasks.map(({ message }) => message.id), ids)
})

test('a blocking finding without --follow-up stays on the reply', async (t) => {
  const { team, run } = await fixture(t)
  const { task } = await team.tasks.create('work/acme', { text: 'Review the grant change' })
  const result = await run('record', task.id, 'blocked', '--head', sha, '--finding', 'BLOCKING the deny list is dropped')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(followUps(result.stdout), [])
  const page = await team.tasks.list({ state: 'all', channel: 'plb/work' })
  assert.deepEqual(page.tasks, [])
  const root = await team.thread(task.id)
  assert.match(root.replies[0]?.text ?? '', /BLOCKING the deny list is dropped/)
})

test('review record refuses a missing head, a short sha, a plain message, and an unknown task', async (t) => {
  const { team, run } = await fixture(t)
  const missing = await run('record', '4', 'pass')
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /^error: expected --head/)
  const short = await run('record', '4', 'pass', '--head', 'abc')
  assert.equal(short.status, 2)
  assert.match(short.stderr, /40 or 64/)
  const posted = await team.post('work/acme', 'not a task')
  const plain = await run('record', posted.id, 'pass', '--head', sha)
  assert.equal(plain.status, 1)
  assert.match(plain.stderr, /^error: not a live task\n$/)
  const gone = await run('record', '999999', 'pass', '--head', sha)
  assert.equal(gone.status, 1)
  assert.match(gone.stderr, /^error: no such task\n$/)
})

test('review help prints the record usage and does not write', async (t) => {
  const { run } = await fixture(t)
  const result = await run('--help')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^usage: swarm review record /)
  assert.equal(result.stderr, '')
})
