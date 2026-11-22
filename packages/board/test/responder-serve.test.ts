import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import type { AttentionDraft, MessageView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { localHandle } from '../src/cli/serve.ts'
import { swarmOptions } from '../src/cli/swarm.ts'
import { bearer, board, BOARD_URL, caller, localUserToken, testLocal } from './harness.ts'

const OWNER = 'local:user:ada'
const RESPONDER = 'local:user:sam'
const CHANNEL = 'fresh/work'
const COMMIT = 'a'.repeat(40)
const ANSWER = { option: 'go', commit: COMMIT }
type Cleanup = (close: () => Promise<void>) => void

function draft({ id, revision }: MessageView): AttentionDraft {
  return {
    kind: 'awaiting_approval', question: 'Ship it?', context: '',
    evidence: [{ message: id, revision }], revision, commit: COMMIT,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    options: [
      { id: 'go', label: 'Ship', consequence: 'Release the build', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Keep the build', next: 'fail' },
    ],
  }
}

function client(url: string, transport: typeof fetch) {
  return board({ backend: http(url, { fetch: transport }) }).as(null)
}

async function setup(cleanup: Cleanup, options: Parameters<typeof swarmOptions>[0]) {
  const backend = local({ memory: true, ...swarmOptions(options, OWNER) })
  cleanup(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const send: typeof fetch = async (input, init) => team.fetch(new Request(input, init))
  const owner = client(BOARD_URL, bearer(send, await localUserToken('ada')))
  const token = await localUserToken('sam')
  return { team, owner, responder: client(BOARD_URL, bearer(send, token)), token }
}

async function ask(author: ReturnType<typeof client>, channel = CHANNEL) {
  const { task } = await author.tasks.create(channel, 'Release the build')
  const { attention } = await author.tasks.ask(task.id, draft(task))
  return [task.id, attention.id, ANSWER] as const
}

it('lets only listed people answer and leaves agent ops off', async ({ onTestFinished }) => {
  const { owner, responder } = await setup(onTestFinished, { responders: [RESPONDER] })
  const pending = await ask(owner)
  await expect(owner.tasks.answer(...pending)).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  expect(await responder.tasks.answer(...pending)).toMatchObject({
    attention: { status: 'answered', receipt: { by: { principal: RESPONDER } } },
  })
  await expect(owner.agents.list(CHANNEL)).rejects.toMatchObject({ status: 501, code: 'no_agent_ops' })
})

it('does not let a listed person answer with read-only access', async ({ onTestFinished }) => {
  const { team, owner, responder, token } = await setup(onTestFinished, { responders: [RESPONDER] })
  const pending = await ask(owner)
  const path = `/tasks/${pending[0]}/attention`
  const limited = caller(team.fetch, token, { 'x-board-can': `${CHANNEL}=read` })
  expect(await limited('GET', path)).toMatchObject({ status: 200, body: { attention: { status: 'pending' } } })
  expect(await limited('POST', `${path}/${pending[1]}/answer`, ANSWER))
    .toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
  expect(await responder.tasks.answer(...pending)).toMatchObject({ attention: { status: 'answered' } })
})

it('hides attention from a listed responder with no read access', async ({ onTestFinished }) => {
  const { team, owner, responder, token } = await setup(onTestFinished, { responders: [RESPONDER] })
  const pending = await ask(owner)
  const postOnly = caller(team.fetch, token, { 'x-board-can': `${CHANNEL}=post` })
  expect(await postOnly('POST', `/tasks/${pending[0]}/attention/${pending[1]}/answer`, ANSWER))
    .toMatchObject({ status: 404, body: { error: { code: 'message_not_found' } } })
  expect(await responder.tasks.answer(...pending)).toMatchObject({ attention: { status: 'answered' } })
})

it('keeps the swarm owner and adds the listed responder', async ({ onTestFinished }) => {
  const { owner, responder } = await setup(onTestFinished, { swarm: true, responders: [RESPONDER] })
  expect(await owner.tasks.answer(...await ask(owner))).toMatchObject({
    attention: { receipt: { by: { principal: OWNER } } },
  })
  expect(await responder.tasks.answer(...await ask(owner, 'another/channel'))).toMatchObject({
    attention: { receipt: { by: { principal: RESPONDER } } },
  })
})

it('returns no_task_attention on a stock board without flags', async ({ onTestFinished }) => {
  const { owner } = await setup(onTestFinished, {})
  const { task } = await owner.tasks.create(CHANNEL, 'Release the build')
  await expect(owner.tasks.answer(task.id, task.id, ANSWER))
    .rejects.toMatchObject({ status: 501, code: 'no_task_attention' })
})

const CLI = join(import.meta.dirname, '../src/cli/bin.ts')

async function cliHome(cleanup: Cleanup) {
  const home = await mkdtemp(join(tmpdir(), 'board-cli-responder-'))
  cleanup(() => rm(home, { recursive: true, force: true }))
  const data = join(home, 'data')
  const options = { cwd: home, env: { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home } }
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { ...options, timeout: 12_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else reject(new Error('vb did not exit normally'))
    })
  })
  async function start(...args: string[]) {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--no-inspect', '--dir', data, ...args], {
      ...options, stdio: ['ignore', 'pipe', 'ignore'], timeout: 35_000, killSignal: 'SIGKILL',
    })
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.on('error', () => {})
    cleanup(async () => { child.kill('SIGTERM'); await closed })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    return vi.waitFor(() => {
      const url = /^(?:serving a local board at |board  )(http:\/\/127\.0\.0\.1:\d+\/api\/board)\b/m.exec(stdout)?.[1]
      if (!url) throw new Error('vb serve did not announce its URL')
      return url
    }, { timeout: 12_000 })
  }
  return { home, data, run, start }
}

it('starts vb serve with a responder and lets that identity answer from the CLI', async ({ onTestFinished }) => {
  const { home, run, start } = await cliHome(onTestFinished)
  const principal = `local:user:${localHandle()}`
  const url = await start('--responder', principal)
  const cli = (...args: string[]) => run('tasks', ...args, '--url', url, '--json')
  const created = await cli('create', CHANNEL, 'Release the build')
  expect(created.code).toBe(0)
  const { task } = JSON.parse(created.stdout) as { task: MessageView }
  const file = join(home, 'attention.json')
  await writeFile(file, JSON.stringify(draft(task)))
  const asked = await cli('ask', task.id, '--file', file)
  expect(asked.code).toBe(0)
  const answered = await cli('answer', task.id, JSON.parse(asked.stdout).attention.id, 'go', '--commit', COMMIT)
  expect(answered.code).toBe(0)
  expect(JSON.parse(answered.stdout)).toMatchObject({
    attention: { status: 'answered', receipt: { by: { principal }, option: 'go' } },
  })
}, 30_000)

it('allows repeatable --responder flags with stable team-token identities', async ({ onTestFinished }) => {
  const { home, start } = await cliHome(onTestFinished)
  const file = join(home, 'tokens.json')
  const ada = 'a'.repeat(64)
  const sam = 'b'.repeat(64)
  await writeFile(file, JSON.stringify({ ada, sam }), { mode: 0o600 })
  const url = await start('--team-tokens', file,
    '--responder', 'team:user:ada', '--responder', 'team:user:sam', '--responder', 'team:user:ada')
  const first = client(url, bearer(fetch, ada))
  const second = client(url, bearer(fetch, sam))
  expect(await first.tasks.answer(...await ask(first))).toMatchObject({
    attention: { receipt: { by: { principal: 'team:user:ada' } } },
  })
  expect(await second.tasks.answer(...await ask(first))).toMatchObject({
    attention: { receipt: { by: { principal: 'team:user:sam' } } },
  })
}, 20_000)

for (const mode of ['text', 'json']) it(`refuses an invalid responder before startup without echoing it (${mode})`, async ({ onTestFinished }) => {
  const { data, run } = await cliHome(onTestFinished)
  const bad = 'local:user:sam+worker\n\x1b[2J'
  const result = await run('serve', '--port', '0', '--no-inspect', '--dir', data,
    '--responder', RESPONDER, '--responder', bad, ...(mode === 'json' ? ['--json'] : []))
  expect(result).toMatchObject({ code: 2, stdout: '' })
  const message = '--responder needs a principal ID, not a handle or profile.'
  const hint = 'Use the principal from vb whoami --json'
  if (mode === 'json') expect(JSON.parse(result.stderr)).toEqual({ status: 'error', reason: 'invalid_responder', message, hint })
  else expect(result.stderr).toBe(`error: ${message}\n\n  ${hint}\n`)
  await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' })
}, 15_000)

it('lists the repeatable --responder flag in vb serve help', async ({ onTestFinished }) => {
  const { run } = await cliHome(onTestFinished)
  const help = await run('serve', '--help')
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('--responder <principal>...')
}, 15_000)
