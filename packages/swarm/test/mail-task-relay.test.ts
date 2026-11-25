import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { board, type Board, type MessageView } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, localUserToken, testLocal } from '../../board/test/tokens.ts'

type Run = { status: number | null; stdout: string; stderr: string }

const binding = (actor: string, session: string) => ({
  controller: { principal: actor, actor },
  owner: { principal: actor, actor },
  provider: 'cursor',
  model: 'cursor-agent',
  session,
  branch: 'plb/plb-130',
  worktree: '/workspace',
  baseCommit: 'a'.repeat(40),
})

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
  const [spawner, ada, agent, reader] = await Promise.all([
    localUserToken('spawner'), localUserToken('ada'), localUserToken('agent'), localUserToken('reader'),
  ])
  const send = async (token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json: unknown = response.status === 204 ? null : await response.json()
    return { status: response.status, json }
  }
  const run = (args: string[], token = spawner) => new Promise<Run>((resolve, reject) => {
    execFile(process.execPath, ['src/cli.ts', ...args], {
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
  return { team, url, send, run, spawner, ada, agent, reader }
}

async function task(team: Board, text: string, workId: string): Promise<MessageView> {
  const made = await team.tasks.create('work', { text, labels: { 'work.id': workId } })
  return made.task
}

function letters(team: Board, channel: string): Promise<MessageView[]> {
  return team.threads({ channel, label: ['mail.reply'], limit: 50 }).then((page) => page.threads.map((row) => row.message))
}

test('a person reply on a claimed plb task becomes one pending letter', async (t) => {
  const { team, url, send, run, ada, agent } = await fixture(t)
  const root = await task(team, 'ship the mail', 'plb-331')
  const claim = await send(agent, 'POST', `/tasks/${root.id}/claim`, { lease: 3600, binding: binding('local:user:agent', 'bc-session-1') })
  assert.equal(claim.status, 200)
  const reply = await send(ada, 'POST', '/messages', { re: root.id, text: 'look at the gate' })
  assert.equal(reply.status, 201)
  const replyId = (reply.json as { message: { id: string } }).message.id
  const first = await run(['mail', 'relay', '--board', url, '--once'])
  assert.equal(first.stderr, '')
  assert.equal(first.status, 0)
  assert.equal(first.stdout, `letter  ${replyId}  mail/agent  pending\n`)
  const [letter] = await letters(team, 'mail/agent')
  assert.ok(letter)
  assert.equal(letter.labels['mail.from'], 'ada')
  assert.equal(letter.labels['mail.task'], root.id)
  assert.equal(letter.labels['mail.reply'], replyId)
  assert.equal(letter.labels['mail.state'], 'pending')
  assert.match(letter.text, /^from  ada\ntask  /)
  assert.match(letter.text, /session  bc-session-1\n/)
  assert.match(letter.text, /look at the gate$/)
  const second = await run(['mail', 'relay', '--board', url, '--once'])
  assert.equal(second.status, 0)
  assert.equal(second.stdout, '')
  assert.equal((await letters(team, 'mail/agent')).length, 1)
})

test('the claimant and the spawner are not mailed, and neither is a task that is not a claimed plb task', async (t) => {
  const { team, url, send, run, ada, agent, spawner } = await fixture(t)
  const held = await task(team, 'the plb task', 'plb-12')
  const other = await task(team, 'another tag', 'wp-9')
  const ready = await task(team, 'not claimed', 'plb-13')
  assert.equal((await send(agent, 'POST', `/tasks/${held.id}/claim`, { lease: 3600, binding: binding('local:user:agent', 'bc-held') })).status, 200)
  assert.equal((await send(agent, 'POST', `/tasks/${other.id}/claim`, { lease: 3600, binding: binding('local:user:agent', 'bc-other') })).status, 200)
  const person = await send(ada, 'POST', '/messages', { re: held.id, text: 'from ada' })
  assert.equal(person.status, 201)
  assert.equal((await send(agent, 'POST', '/messages', { re: held.id, text: 'claimant note' })).status, 201)
  assert.equal((await send(spawner, 'POST', '/messages', { re: held.id, text: 'spawner note' })).status, 201)
  assert.equal((await send(ada, 'POST', '/messages', { re: other.id, text: 'other tag' })).status, 201)
  assert.equal((await send(ada, 'POST', '/messages', { re: ready.id, text: 'still ready' })).status, 201)
  const replyId = (person.json as { message: { id: string } }).message.id
  const ran = await run(['mail', 'relay', '--board', url, '--once'])
  assert.equal(ran.stderr, '')
  assert.equal(ran.status, 0)
  assert.equal(ran.stdout, `letter  ${replyId}  mail/agent  pending\n`)
  const mailed = await letters(team, 'mail/agent')
  assert.deepEqual(mailed.map((letter) => letter.labels['mail.reply']), [replyId])
  assert.equal(mailed.some((letter) => letter.text.includes('claimant note') || letter.text.includes('spawner note') || letter.text.includes('other tag') || letter.text.includes('still ready')), false)
})

test('a delivered letter shows delivered to the claimant once, and keeps the deliverer\'s time', async (t) => {
  const { team, url, send, run, ada, agent } = await fixture(t)
  const root = await task(team, 'deliver this', 'plb-20')
  assert.equal((await send(agent, 'POST', `/tasks/${root.id}/claim`, { lease: 3600, binding: binding('local:user:agent', 'bc-deliver') })).status, 200)
  const reply = await send(ada, 'POST', '/messages', { re: root.id, text: 'please ship' })
  assert.equal(reply.status, 201)
  const replyId = (reply.json as { message: { id: string } }).message.id
  assert.equal((await run(['mail', 'relay', '--board', url, '--once'])).status, 0)
  const [letter] = await letters(team, 'mail/agent')
  assert.ok(letter)
  const when = '2026-11-25T19:00:00.000Z'
  await team.label(letter.id, { set: { 'mail.state': 'delivered', 'mail.delivered': when } })
  const marked = await run(['mail', 'relay', '--board', url, '--once'])
  assert.equal(marked.stderr, '')
  assert.equal(marked.status, 0)
  assert.equal(marked.stdout, `delivered  ${replyId}  agent\n`)
  const thread = await team.thread(root.id)
  const notices = thread.replies.filter((row) => row.text === 'delivered to agent')
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.labels['mail.reply'], replyId)
  const [kept] = await letters(team, 'mail/agent')
  assert.equal(kept?.labels['mail.state'], 'delivered')
  assert.equal(kept?.labels['mail.delivered'], when)
  const again = await run(['mail', 'relay', '--board', url, '--once'])
  assert.equal(again.stdout, '')
  assert.equal((await team.thread(root.id)).replies.filter((row) => row.text === 'delivered to agent').length, 1)
})

test('a letter marked delivered without a time gets one, and the thread shows the claimant', async (t) => {
  const { team, url, send, run, ada, agent } = await fixture(t)
  const root = await task(team, 'time this', 'plb-21')
  assert.equal((await send(agent, 'POST', `/tasks/${root.id}/claim`, { lease: 3600, binding: binding('local:user:agent', 'bc-time') })).status, 200)
  const reply = await send(ada, 'POST', '/messages', { re: root.id, text: 'need a time' })
  assert.equal(reply.status, 201)
  const replyId = (reply.json as { message: { id: string } }).message.id
  assert.equal((await run(['mail', 'relay', '--board', url, '--once'])).status, 0)
  const [letter] = await letters(team, 'mail/agent')
  assert.ok(letter)
  await team.label(letter.id, { set: { 'mail.state': 'delivered' } })
  const marked = await run(['mail', 'relay', '--board', url, '--once'])
  assert.equal(marked.status, 0)
  assert.equal(marked.stdout, `delivered  ${replyId}  agent\n`)
  const [stamped] = await letters(team, 'mail/agent')
  assert.match(stamped?.labels['mail.delivered'] ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  const notices = (await team.thread(root.id)).replies.filter((row) => row.text === 'delivered to agent')
  assert.equal(notices.length, 1)
})

test('mail relay rejects a missing board and does not follow when once is set', async (t) => {
  const { run } = await fixture(t)
  const missing = await run(['mail', 'relay', '--once'])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /^error: expected --board URL\nusage: swarm mail relay --board URL \[--once\]\n$/)
  const help = await run(['mail', 'relay', '--help'])
  assert.equal(help.status, 0)
  assert.equal(help.stdout, 'usage: swarm mail relay --board URL [--once]\n')
})
