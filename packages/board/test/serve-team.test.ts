import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { get, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json } from 'node:stream/consumers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { serveLocal } from '../src/cli/serve.ts'
import { localTokenFile } from '../src/client/node.ts'
import { board } from '../src/server/index.ts'

const CLI = join(import.meta.dirname, '../src/cli/bin.ts')
const CLI_TIMEOUT = 20_000
const token = () => randomBytes(32).toString('hex')
const host = '127.0.0.1'
const shareHost = 'queue.example.test'
let dir: string
let teamTokens: string
let ada: string
let bo: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'board-team-'))
  teamTokens = join(dir, 'team.json')
  ada = token()
  bo = token()
  await writeFile(teamTokens, JSON.stringify({ ada, bo }), { mode: 0o600 })
  // Fresh client config. The CLI inherits no login and cannot launch a browser.
  env = { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), PATH: dir }
  vi.stubEnv('XDG_CONFIG_HOME', env.XDG_CONFIG_HOME)
  vi.stubEnv('VERCEL', undefined)
  vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

it('runs a task on a self-hosted board as two people and reads it after restart', async () => {
  const config = { dir: join(dir, 'data'), host, port: 0, teamTokens }
  const start = () => serveLocal(config)
  const connect = (url: string, credential: string) => {
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', credential)
    return board().as(null)
  }

  const first = await start()
  let id: string
  try {
    const createWithoutTeamToken = (authorization?: string) =>
      fetch(`${first.url}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authorization && { authorization }) },
        body: JSON.stringify({ channel: 'work', text: 'Not an authorized task' }),
      })
    expect((await createWithoutTeamToken()).status).toBe(401)
    expect((await createWithoutTeamToken(`Bearer ${token()}`)).status).toBe(401)

    const owner = connect(first.url, ada)
    const { task } = await owner.tasks.create('work', 'Check the release notes')
    id = task.id
    expect(task).toMatchObject({ by: { principal: 'team:user:ada' }, task: { state: 'ready', owner: 'team:user:ada' } })

    const worker = connect(first.url, bo)
    expect(await worker.me()).toMatchObject({ principal: 'team:user:bo', kind: 'person' })
    const claim = await worker.tasks.claim(id)
    expect(claim.task.task).toMatchObject({ state: 'claimed', claim: { actor: 'team:user:bo' } })
    const reply = await fetch(`${first.url}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bo}`, 'content-type': 'application/json' },
      // The credential, not a caller-supplied author, decides who wrote this.
      body: JSON.stringify({ re: id, text: 'Checked the links', by: { actor: 'team:user:ada', principal: 'team:user:ada' } }),
    })
    expect(reply.status).toBe(201)
    await claim.complete('Ready to publish')
  } finally {
    await first.close()
  }

  const restarted = await start()
  try {
    const { message, replies } = await connect(restarted.url, ada).thread(id)
    expect(message).toMatchObject({ id, task: { state: 'completed', result: 'Ready to publish' } })
    expect(replies).toMatchObject([{ text: 'Checked the links', by: { actor: 'team:user:bo', principal: 'team:user:bo' } }])
  } finally {
    await restarted.close()
  }
})

const args = (...flags: string[]) => [CLI, 'serve', '--dir', join(dir, 'data'), '--port', '0', ...flags]

// Assert predicates, not raw output: even the failure path must not print a leaked token.
function expectNoToken(output: string) {
  expect(output.includes(ada) || output.includes(bo), 'CLI output contains a team token').toBe(false)
}

it('advertises the API and share URLs without opening an inspector or minting an owner token', async () => {
  const child = spawn(process.execPath, args('--host', '127.0.0.2', '--team-tokens', teamTokens, '--allow-host', shareHost), { cwd: dir, env })
  const closed = once(child, 'close')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const boardLine = /^board  (http:\/\/127\.0\.0\.2:\d+\/api\/board)\r?$/m
  const shareUrl = `https://${shareHost}/api/board`
  try {
    await expect.poll(() => boardLine.test(stdout) && stdout.split(/\r?\n/).includes(`share  ${shareUrl}`), {
      message: 'CLI did not advertise the direct and share URLs',
      timeout: CLI_TIMEOUT - 2_000,
    }).toBe(true)
    const url = boardLine.exec(stdout)![1]!
    expect((await fetch(url)).status).toBe(200)

    // Send what a TLS proxy would forward, without contacting the public host.
    const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
      get(url, { headers: { Host: shareHost, 'X-Forwarded-Proto': 'https' } }, resolve).on('error', reject)
    })
    expect(proxied.statusCode).toBe(200)
    expect(await json(proxied)).toMatchObject({ url: shareUrl, audience: shareUrl })

    expect((await fetch(new URL('/', url))).status).toBe(404)
    expect(existsSync(localTokenFile(url))).toBe(false)
    child.kill('SIGINT')
    expect((await closed)[0]).toBe(0)
  } finally {
    child.kill('SIGKILL')
    await closed
    expectNoToken(stdout + stderr)
  }
}, CLI_TIMEOUT)

it.each(['--host', '--tailscale'])('rejects an incompatible %s option', (flag) => {
  const flags = flag === '--host'
    ? ['--no-inspect', '--host', host]
    : ['--team-tokens', teamTokens, '--tailscale', shareHost]
  const { status, stdout, stderr } = spawnSync(process.execPath, args(...flags), { cwd: dir, env, encoding: 'utf8', timeout: CLI_TIMEOUT - 2_000 })
  expectNoToken(stdout + stderr)
  expect(status).toBe(2)
  expect(stderr.includes(flag) && stderr.includes('--team-tokens')).toBe(true)
}, CLI_TIMEOUT)

it('rejects malformed team JSON without printing its contents', async () => {
  const marker = 'bad-json:' // A parse error that echoes even a snippet can expose the file.
  await writeFile(teamTokens, `${marker}${ada}`)
  const { status, stdout, stderr } = spawnSync(process.execPath, args('--team-tokens', teamTokens), {
    cwd: dir, env, encoding: 'utf8', timeout: CLI_TIMEOUT - 2_000,
  })
  expectNoToken(stdout + stderr)
  expect((stdout + stderr).includes(marker), 'CLI output contains the malformed input').toBe(false)
  expect(status).toBe(2)
  expect(stderr.includes('--team-tokens')).toBe(true)
}, CLI_TIMEOUT)
