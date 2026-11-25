import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, caller, localUserToken, testLocal } from '../../board/test/tokens.ts'

const reason = 'hold the queue'
const created = '2026-01-01T00:00:00.000Z'

function dispatch(id: string) {
  return {
    envelope: {
      party: 'demo', repo: 'acme/web', work_id: 'web-1', attempt: 'attempt-1', tier: 'sprite',
      parent: null, session: `session-${id}`, trace: { id: 'trace-1', execution_id: id },
    },
    sponsor: null,
    created,
  }
}

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
  const token = await localUserToken('operator')
  const call = caller(team.fetch, token)
  const dir = await mkdtemp(join(tmpdir(), 'swarm-pause-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['src/cli.ts', ...args], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        BOARD_URL: `http://127.0.0.1:${port}/api/board`,
        BOARD_TOKEN: token,
      },
    }, (error, stdout, stderr) => {
      const status = typeof error?.code === 'number' ? error.code : error ? null : 0
      if (error && status === null) reject(error)
      else resolve({ status, stdout, stderr })
    })
  })
  return { call, dir, run }
}

test('a paused board refuses dispatch and lets it proceed after resume', async (t) => {
  const { call, dir, run } = await fixture(t)
  const db = join(dir, 'ledger.sqlite')
  const first = join(dir, 'first.json')
  const second = join(dir, 'second.json')
  await writeFile(first, JSON.stringify(dispatch('sprite-1')))
  await writeFile(second, JSON.stringify(dispatch('sprite-2')))

  const open = await run(['ledger', 'dispatch', '--db', db, first])
  assert.equal(open.status, 0, open.stderr)
  assert.equal(open.stdout, 'created  sprite-1\n')

  assert.equal((await call('POST', '/control/pause', { reason })).status, 200)
  const held = await run(['ledger', 'dispatch', '--db', db, second])
  assert.equal(held.status, 1)
  assert.equal(held.stderr, `error: board paused: ${reason}\n`)
  assert.equal(held.stdout, '')
  const still = await run(['ledger', 'dispatch', '--db', db, first])
  assert.equal(still.stderr, `error: board paused: ${reason}\n`)
  const shown = await run(['config', 'show'])
  assert.equal(shown.status, 0, shown.stderr)
  assert.equal(shown.stderr, '')
  const capture = await run([
    'capture', 'run', '--name', 'sprite', '--ledger', join(dir, 'capture'),
    '--party', 'demo', '--session', 'session-1', '--trace', 'trace-1', '--task', join(dir, 'missing-task'),
  ])
  assert.equal(capture.status, 1)
  assert.equal(capture.stderr, `error: board paused: ${reason}\n`)
  assert.equal(existsSync(join(dir, 'capture')), false)

  assert.equal((await call('POST', '/control/resume', { reason: 'queue open' })).status, 200)
  const next = await run(['ledger', 'dispatch', '--db', db, second])
  assert.equal(next.status, 0, next.stderr)
  assert.equal(next.stdout, 'created  sprite-2\n')
  const resumed = await run([
    'capture', 'run', '--name', 'sprite', '--ledger', join(dir, 'capture'),
    '--party', 'demo', '--session', 'session-1', '--trace', 'trace-1', '--task', join(dir, 'missing-task'),
  ])
  assert.notEqual(resumed.stderr, `error: board paused: ${reason}\n`)
  assert.match(resumed.stderr, /^error: /)
})
