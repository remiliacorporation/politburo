import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createClaims } from '../src/claims/service.ts'
import { defaultConfig } from '../src/config/load.ts'

const channel = 'work/acme-web'
const statusFlags = ['status', '--channel', channel, '--party', 'red']

async function claims(t: TestContext, args: string[], url?: string) {
  const home = mkdtempSync(join(tmpdir(), 'swarm-claims-cli-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['src/cli.ts', 'claims', ...args], {
    cwd: new URL('../', import.meta.url),
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, BOARD_URL: url },
    signal: AbortSignal.timeout(5000),
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const [status] = await once(child, 'close')
  return { status, stdout, stderr }
}

test('claims status must report no usable board as exit 2, not a runtime error', async (t) => {
  const result = await claims(t, statusFlags)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^error: no board to read\b/)
})

test('claims --help must print usage and exit successfully without a board', async (t) => {
  const result = await claims(t, ['--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^usage: swarm claims status\b/)
  assert.equal(result.stderr, '')
})

test('claims status without --party must exit 2 and diagnose misuse only on stderr', async (t) => {
  const result = await claims(t, ['status', '--channel', channel])
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /^error: .*--party\b/)
  assert.equal(result.stdout, '')
})

test('claims status must list the live HTTP board claim and its hard end in text and JSON', async (t) => {
  const backend = local({ memory: true })
  const team = board({ backend, authenticate: async () => ({
    id: 'swarm:person:dispatcher-red', kind: 'person', handle: 'dispatcher-red',
  }) })
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const init: RequestInit = { method: req.method, headers: req.headers as Record<string, string> }
      if (chunks.length) init.body = Buffer.concat(chunks)
      const result = await team.fetch(new Request(`http://${req.headers.host}${req.url}`, init))
      const body = Buffer.from(await result.arrayBuffer())
      res.writeHead(result.status, Object.fromEntries(result.headers)).end(body)
    } catch {
      res.writeHead(500).end()
    }
  })
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await backend.close()
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  // Seed as the same HTTP caller the CLI will be, through the default handle on BOARD_URL.
  const before = process.env.BOARD_URL
  process.env.BOARD_URL = url
  t.after(() => { if (before === undefined) delete process.env.BOARD_URL; else process.env.BOARD_URL = before })
  const dispatcher = board()
  const { task } = await dispatcher.tasks.create(channel, 'Work item')
  const red = createClaims({ board: dispatcher, channel, party: 'red', config: defaultConfig().claims,
    validate: async () => ({ result: 'invalid' }) })
  const claim = await red.claim(task.id)
  assert.ok(claim.ok)
  const text = await claims(t, statusFlags, url)
  assert.equal(text.status, 0, text.stderr)
  const row = text.stdout.split('\n').find((line) => line.startsWith(`${task.id} `))
  assert.deepEqual(row?.trim().split(/\s+/).slice(0, 3), [task.id, 'claimed', new Date(claim.hardEnd).toISOString().replace('.000Z', 'Z')])
  const json = await claims(t, [...statusFlags, '--json'], url)
  assert.equal(json.status, 0, json.stderr)
  const { claims: rows } = JSON.parse(json.stdout)
  assert.equal(rows.length, 1)
  assert.partialDeepStrictEqual(rows[0], { task: task.id, state: 'claimed', hardEnd: claim.hardEnd })
})
