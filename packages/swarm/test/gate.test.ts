import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { board, type Board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, localUserToken, testLocal } from '../../board/test/tokens.ts'

const sha = 'a'.repeat(40)
const other = 'b'.repeat(40)
const pr = '12'
const repo = 'acme/web'

type Run = { status: number | null; stdout: string; stderr: string; github: string[]; boardMethods: string[] }

type Check = { status: string; conclusion: string | null; head_sha?: string }

function success(head = sha): Check {
  return { status: 'completed', conclusion: 'success', head_sha: head }
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

async function fixture(t: TestContext, github: {
  pull?: unknown
  pullStatus?: number
  pages?: Check[][]
  total?: number
} = {}) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const boardMethods: string[] = []
  const boardPort = await listen(t, async (req, res) => {
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
  const githubHits: string[] = []
  const pages = github.pages ?? [[success()]]
  const githubPort = await listen(t, (req, res) => {
    githubHits.push(`${req.method} ${req.url}`)
    const url = new URL(req.url!, 'http://127.0.0.1')
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'GET') return reply(405, {})
    if (req.headers.authorization !== 'Bearer fixture-token') return reply(401, {})
    if (url.pathname === `/repos/${repo}/pulls/${pr}`) return reply(github.pullStatus ?? 200, github.pull ?? { number: 12, head: { sha } })
    const page = Number(url.searchParams.get('page') ?? '1')
    if (url.pathname === `/repos/${repo}/commits/${sha}/check-runs`) {
      const runs = pages[page - 1] ?? []
      return reply(200, { total_count: github.total ?? pages.reduce((sum, rows) => sum + rows.length, 0), check_runs: runs })
    }
    return reply(404, {})
  })
  const token = await localUserToken('worker')
  const run = (number = pr, env: Record<string, string> = {}) => new Promise<Run>((resolve, reject) => {
    execFile(process.execPath, [
      'src/cli.ts', 'gate', 'check', number, '--board', `http://127.0.0.1:${boardPort}/api/board`,
    ], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH, HOME: tmpdir(), BOARD_TOKEN: token,
        SWARM_GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
        GH_TOKEN: 'fixture-token', ...env,
      },
    }, (error, stdout, stderr) => {
      const status = typeof error?.code === 'number' ? error.code : error ? null : 0
      if (error && status === null) reject(error)
      else resolve({ status, stdout, stderr, github: [...githubHits], boardMethods: [...boardMethods] })
    })
  })
  const operator = await localUserToken('operator')
  const control = async (action: 'pause' | 'resume', why: string) => {
    const response = await fetch(`http://127.0.0.1:${boardPort}/api/board/control/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: why }),
    })
    assert.equal(response.status, 200)
  }
  return { team, run, control }
}

async function task(team: Board, labels: Record<string, string>, result?: string) {
  const { task: root } = await team.tasks.create('work/acme', { text: 'Ship it', labels: { 'work.id': 'plb-102', ...labels } })
  if (result === undefined) return root
  const claim = await team.tasks.claim(root.id)
  assert.ok(claim)
  await claim.complete(result)
  return root
}

test('a completed plb task with a pass for this head and successful checks prints pass', async (t) => {
  const { team, run } = await fixture(t)
  const root = await task(team, { 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
  const before = await team.thread(root.id)
  const result = await run()
  assert.equal(result.stderr, '')
  assert.equal(result.stdout, 'pass\n')
  assert.equal(result.status, 0)
  assert.deepEqual(result.github, [
    `GET /repos/${repo}/pulls/${pr}`,
    `GET /repos/${repo}/commits/${sha}/check-runs?per_page=100&page=1`,
  ])
  assert.ok(result.boardMethods.length > 0)
  assert.deepEqual([...new Set(result.boardMethods)], ['GET'])
  assert.deepEqual(await team.thread(root.id), before)
})

test('a paused board refuses the gate before it can pass, and a resume lets it pass', async (t) => {
  const { team, run, control } = await fixture(t)
  await task(team, { 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
  const reason = 'hold the queue'
  await control('pause', reason)
  const held = await run()
  assert.equal(held.status, 1)
  assert.equal(held.stderr, `error: board paused: ${reason}\n`)
  assert.equal(held.stdout, '')
  assert.deepEqual(held.github, [])
  await control('resume', 'queue open')
  const next = await run()
  assert.equal(next.status, 0, next.stderr)
  assert.equal(next.stdout, 'pass\n')
  assert.equal(next.stderr, '')
})

test('a plb task past the first page is still the one the gate reads', async (t) => {
  const { team, run } = await fixture(t)
  for (let n = 1; n <= 100; n++) {
    await team.tasks.create('work/acme', { text: `decoy ${n}`, labels: { 'work.id': `plb-${n}` } })
  }
  await task(team, { 'work.id': 'plb-900', 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
  const result = await run()
  assert.equal(result.stdout, 'pass\n')
  assert.equal(result.status, 0)
})

test('the gate refuses when no plb task names the pull request', async (t) => {
  const { team, run } = await fixture(t)
  await task(team, { 'work.id': 'web-3', 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
  await task(team, { 'pr.number': '99', result: 'shipped #99' }, 'shipped #99')
  const result = await run()
  assert.equal(result.stdout, 'task missing\n')
  assert.equal(result.status, 1)
  assert.deepEqual(result.github, [])
})

test('a result or pr.number label names the pull request', async (t) => {
  const labels = { 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }
  const byResult = await fixture(t)
  await task(byResult.team, labels, 'https://github.com/acme/web/pull/12')
  assert.equal((await byResult.run()).stdout, 'pass\n')
  const byLabel = await fixture(t)
  await task(byLabel.team, { ...labels, result: `https://github.com/acme/web/pull/${pr}` }, 'notes only')
  assert.equal((await byLabel.run()).stdout, 'pass\n')
  const byNumber = await fixture(t)
  await task(byNumber.team, { ...labels, 'pr.number': pr }, 'notes only')
  assert.equal((await byNumber.run()).stdout, 'pass\n')
})

test('two plb tasks naming the pull request do not pass', async (t) => {
  const { team, run } = await fixture(t)
  await task(team, { 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
  await task(team, { 'work.id': 'plb-103', 'pr.number': pr, parked: 'hold' })
  const result = await run()
  assert.equal(result.stdout, 'more than one task\n')
  assert.equal(result.status, 1)
  assert.deepEqual(result.github, [])
})

test('an unfinished task is refused before its parked label', async (t) => {
  const { team, run } = await fixture(t)
  await task(team, { 'pr.number': pr, parked: 'hold' })
  const result = await run()
  assert.equal(result.stdout, 'not completed\n')
  assert.equal(result.status, 1)
  assert.deepEqual(result.github, [])
})

test('a completed task labelled parked or needs-review is refused', async (t) => {
  const parked = await fixture(t)
  await task(parked.team, {
    'pr.number': pr, 'work.repo': repo, parked: 'hold', 'needs-review': 'yes',
    'review.verdict': 'pass', 'review.head': sha,
  }, 'done')
  const parkedResult = await parked.run()
  assert.equal(parkedResult.stdout, 'parked\n')
  assert.equal(parkedResult.status, 1)
  const review = await fixture(t)
  await task(review.team, {
    'pr.number': pr, 'work.repo': repo, 'needs-review': 'yes', 'review.verdict': 'pass', 'review.head': sha,
  }, 'done')
  const result = await review.run()
  assert.equal(result.stdout, 'needs-review\n')
  assert.equal(result.status, 1)
  assert.deepEqual(result.github, [])
})

test('a missing repo, or two repos, is refused before GitHub is asked', async (t) => {
  const missing = await fixture(t)
  await task(missing.team, { 'pr.number': pr, 'review.verdict': 'pass', 'review.head': sha }, '#12')
  const missingResult = await missing.run()
  assert.equal(missingResult.stdout, 'no repo\n')
  assert.deepEqual(missingResult.github, [])
  const both = await fixture(t)
  await task(both.team, { 'pr.number': pr, 'work.repo': 'other/web', 'review.verdict': 'pass', 'review.head': sha }, 'https://github.com/acme/web/pull/12')
  const bothResult = await both.run()
  assert.equal(bothResult.stdout, 'no repo\n')
  assert.equal(bothResult.status, 1)
})

test('a verdict that is not pass for the current head is the reason GitHub checks are not', async (t) => {
  const cases: Record<string, string>[] = [
    { 'review.verdict': 'fail', 'review.head': sha },
    { 'review.verdict': 'pass', 'review.head': other },
    { 'review.head': sha },
  ]
  for (const labels of cases) {
    const { team, run } = await fixture(t, { pages: [[{ status: 'completed', conclusion: 'failure', head_sha: sha }]] })
    await task(team, { 'pr.number': pr, 'work.repo': repo, ...labels }, 'done')
    const result = await run()
    assert.equal(result.stdout, `no review.verdict=pass for ${sha}\n`, JSON.stringify(labels))
    assert.equal(result.status, 1)
    assert.equal(result.github.some((hit) => hit.includes('check-runs')), false)
  }
})

test('github checks must all be success on this head, including a later page', async (t) => {
  const cases: { pages: Check[][]; total?: number; stdout: string; status: number }[] = [
    { pages: [[{ status: 'completed', conclusion: 'failure', head_sha: sha }]], stdout: 'checks not all success\n', status: 1 },
    { pages: [[{ status: 'in_progress', conclusion: null, head_sha: sha }]], stdout: 'checks not all success\n', status: 1 },
    { pages: [[]], total: 0, stdout: 'checks not all success\n', status: 1 },
    { pages: [[{ status: 'completed', conclusion: 'skipped', head_sha: sha }]], stdout: 'checks not all success\n', status: 1 },
    { pages: [[success(other)]], stdout: 'checks not all success\n', status: 1 },
    { pages: [[success()], [{ status: 'completed', conclusion: 'failure', head_sha: sha }]], stdout: 'checks not all success\n', status: 1 },
    { pages: [[success()], [success()]], stdout: 'pass\n', status: 0 },
  ]
  for (const [index, item] of cases.entries()) {
    const { team, run } = await fixture(t, { pages: item.pages, total: item.total })
    await task(team, { 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
    const result = await run()
    assert.equal(result.stdout, item.stdout, String(index))
    assert.equal(result.status, item.status, String(index))
  }
})

test('github answers that are not a pull request do not pass', async (t) => {
  const down = await fixture(t, { pullStatus: 500 })
  await task(down.team, { 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
  const downResult = await down.run()
  assert.equal(downResult.stdout, 'github unavailable\n')
  assert.equal(downResult.status, 1)
  const quiet = await fixture(t)
  await task(quiet.team, { 'pr.number': pr, 'work.repo': repo, 'review.verdict': 'pass', 'review.head': sha }, 'done')
  const result = await quiet.run(pr, { GH_TOKEN: '' })
  assert.equal(result.stdout, 'github unavailable\n')
  assert.equal(result.status, 1)
})

test('gate check misuse exits 2 and does not read a board', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'gate', 'check'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() },
  })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^error: expected a pull request number\nusage: swarm gate check <pr-number> --board URL\n$/)
})
