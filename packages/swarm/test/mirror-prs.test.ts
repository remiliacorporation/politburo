import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { runMirrorCommand } from '../src/mirror/command.ts'

const repo = 'acme/web'
const boardUrl = 'http://127.0.0.1:9'
const sha = (char: string) => char.repeat(40)
const short = (char: string) => char.repeat(7)

type Run = { status: string; conclusion: string | null }
type Spec = {
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  mergedAt: string | null
  sha: string
  pages: Run[][]
  statuses: { state: string }[]
}

const done = (conclusion: string): Run => ({ status: 'completed', conclusion })
const pull = (char: string, state: Spec['state'], pages: Run[][], statuses: Spec['statuses'] = [], extra: Partial<Spec> = {}): Spec => ({
  state, draft: false, merged: false, mergedAt: null, sha: sha(char), pages, statuses, ...extra,
})

function github(specs: Record<string, Spec>): (url: string) => Promise<Response> {
  const bySha = new Map(Object.values(specs).map((spec) => [spec.sha, spec]))
  return async (url) => {
    const parsed = new URL(url)
    const number = /\/pulls\/(\d+)$/.exec(parsed.pathname)
    if (number) {
      const spec = specs[number[1]!]
      if (!spec) return new Response('missing', { status: 404 })
      return Response.json({
        number: Number(number[1]), state: spec.state, draft: spec.draft, merged: spec.merged,
        merged_at: spec.mergedAt, head: { sha: spec.sha },
      })
    }
    const checks = /\/commits\/([0-9a-f]{40})\/check-runs$/.exec(parsed.pathname)
    if (checks) {
      const spec = bySha.get(checks[1]!)
      if (!spec) return new Response('missing', { status: 404 })
      const page = Number(parsed.searchParams.get('page') ?? '1')
      const batch = spec.pages[page - 1]
      if (!batch) return new Response('missing', { status: 404 })
      const headers: Record<string, string> = {}
      if (page < spec.pages.length) {
        const next = new URL(url)
        next.searchParams.set('page', String(page + 1))
        headers.link = `<${next}>; rel="next"`
      }
      return Response.json({ total_count: spec.pages.flat().length, check_runs: batch }, { headers })
    }
    const status = /\/commits\/([0-9a-f]{40})\/status$/.exec(parsed.pathname)
    if (status) {
      const spec = bySha.get(status[1]!)
      if (!spec) return new Response('missing', { status: 404 })
      return Response.json({ total_count: spec.statuses.length, statuses: spec.statuses, state: 'pending' })
    }
    return new Response('missing', { status: 500 })
  }
}

function fixture(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  const run = async (send: (url: string) => Promise<Response>, extra: string[] = []) => {
    let stdout = '', stderr = ''
    const code = await runMirrorCommand(['mirror', 'prs', '--board', boardUrl, '--repo', repo, ...extra], {
      board: team, github: send, stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text },
    })
    return { code, stdout, stderr }
  }
  const labels = async (id: string) => (await team.thread(id)).message.labels
  const version = async (id: string) => (await team.thread(id)).message.version
  const cursor = async () => (await team.poll({ wait: 0 })).cursor
  const labelWrites = async (after: string) => {
    const page = await team.poll({ after, wait: 0 })
    return page.events.flatMap((event) => event.type === 'labels.changed'
      ? [{ id: event.payload.id, set: event.payload.set, unset: event.payload.unset }] : [])
  }
  return { team, run, labels, version, cursor, labelWrites }
}

function text(rows: { id: string; state: string; checks: string; head: string }[]): string {
  const width = Math.max(...rows.map((row) => row.id.length + 1))
  return rows.map((row) => `${('#' + row.id).padEnd(width)}  ${row.state.padEnd(6)}  ${row.checks.padEnd(7)}  ${row.head}`).join('\n') + '\n'
}

test('mirror prs copies pull request state, checks, and head onto open tasks', async (t) => {
  const { team, run, labels } = fixture(t)
  const specs = {
    12: pull('a', 'open', [[done('failure')]]),
    13: pull('b', 'open', [[]], [], { draft: true }),
    14: pull('c', 'closed', [[done('success')]], [], { merged: true, mergedAt: '2026-01-01T00:00:00Z' }),
    15: pull('d', 'closed', [[{ status: 'in_progress', conclusion: null }]]),
  }
  const open = await team.tasks.create('work', {
    text: 'failing checks', labels: { 'pr.number': '12', 'work.id': 'zzz-12', 'pr.state': 'closed' },
  })
  const held = await team.tasks.create('work', { text: 'draft', labels: { 'pr.number': '13' } })
  await team.tasks.block(held.task.id, 'held')
  const merged = await team.tasks.create('work', { text: 'merged', labels: { 'pr.number': '14' } })
  const pending = await team.tasks.create('work', { text: 'pending', labels: { 'pr.number': '15' } })
  assert.equal((await team.thread(held.task.id)).message.task?.state, 'blocked')

  const result = await run(github(specs))
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  const rows = [
    { id: open.task.id, pr: '12', state: 'open', checks: 'fail', head: short('a'), changed: ['pr.state', 'pr.checks', 'pr.head'] },
    { id: held.task.id, pr: '13', state: 'draft', checks: 'none', head: short('b'), changed: ['pr.state', 'pr.checks', 'pr.head'] },
    { id: merged.task.id, pr: '14', state: 'merged', checks: 'pass', head: short('c'), changed: ['pr.state', 'pr.checks', 'pr.head'] },
    { id: pending.task.id, pr: '15', state: 'closed', checks: 'pending', head: short('d'), changed: ['pr.state', 'pr.checks', 'pr.head'] },
  ]
  assert.equal(result.stdout, text(rows))
  const facts = async (id: string) => {
    const row = await labels(id)
    return { state: row['pr.state'], checks: row['pr.checks'], head: row['pr.head'], number: row['pr.number'] }
  }
  assert.deepEqual(await facts(open.task.id), { number: '12', state: 'open', checks: 'fail', head: short('a') })
  assert.equal((await labels(open.task.id))['work.id'], 'zzz-12')
  assert.equal((await labels(open.task.id))['board.task'], 'ready')
  assert.deepEqual(await facts(held.task.id), { number: '13', state: 'draft', checks: 'none', head: short('b') })
  assert.equal((await labels(held.task.id))['board.task'], 'blocked')
  assert.deepEqual(await facts(merged.task.id), { number: '14', state: 'merged', checks: 'pass', head: short('c') })
  assert.deepEqual(await facts(pending.task.id), { number: '15', state: 'closed', checks: 'pending', head: short('d') })

  const json = await run(github(specs), ['--json'])
  assert.equal(json.code, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { tasks: rows.map((row) => ({ ...row, changed: [] })) })
})

test('mirror prs writes only labels that differ and a second run writes nothing', async (t) => {
  const { team, run, labels, version, cursor, labelWrites } = fixture(t)
  const specs = {
    12: pull('a', 'open', [[done('failure')]]),
    13: pull('b', 'open', [[]], [], { draft: true }),
  }
  const same = await team.tasks.create('work', {
    text: 'already mirrored',
    labels: { 'pr.number': '12', 'pr.state': 'open', 'pr.checks': 'fail', 'pr.head': short('a'), note: 'keep' },
  })
  const partial = await team.tasks.create('work', {
    text: 'state is stale',
    labels: { 'pr.number': '13', 'pr.state': 'closed', 'pr.checks': 'none', 'pr.head': short('b'), note: 'keep' },
  })
  const beforeSame = await version(same.task.id)
  const beforePartial = await version(partial.task.id)
  const at = await cursor()

  const first = await run(github(specs))
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(await labelWrites(at), [
    { id: partial.task.id, set: { 'pr.state': 'draft' }, unset: [] },
  ])
  assert.equal(await version(same.task.id), beforeSame)
  assert.equal(await version(partial.task.id), beforePartial + 1)
  assert.equal((await labels(partial.task.id)).note, 'keep')
  assert.equal((await labels(same.task.id)).note, 'keep')
  const after = await cursor()
  const again = await run(github(specs))
  assert.equal(again.code, 0, again.stderr)
  assert.equal(again.stdout, first.stdout)
  assert.deepEqual(await labelWrites(after), [])
  assert.equal(await version(partial.task.id), beforePartial + 1)
  const json = JSON.parse((await run(github(specs), ['--json'])).stdout)
  assert.deepEqual(json.tasks.map((row: { changed: string[] }) => row.changed), [[], []])
})

test('a failing check past the first page and a failing commit status are fail', async (t) => {
  const { team, run, labels } = fixture(t)
  const specs = {
    21: pull('e', 'open', [[done('success')], [done('failure')]]),
    22: pull('f', 'open', [[]], [{ state: 'failure' }]),
    23: pull('1', 'open', [[done('success')]], [{ state: 'error' }]),
  }
  const later = await team.tasks.create('work', { text: 'later page', labels: { 'pr.number': '21' } })
  const status = await team.tasks.create('work', { text: 'status only', labels: { 'pr.number': '22' } })
  const both = await team.tasks.create('work', { text: 'both sources', labels: { 'pr.number': '23' } })
  const result = await run(github(specs))
  assert.equal(result.code, 0, result.stderr)
  for (const id of [later.task.id, status.task.id, both.task.id]) assert.equal((await labels(id))['pr.checks'], 'fail')
  assert.equal((await labels(later.task.id))['pr.head'], short('e'))
})

test('a finished task and a task without a pull request are left unchanged', async (t) => {
  const { team, run, labels } = fixture(t)
  const doneTask = await team.tasks.create('work', {
    text: 'finished', labels: { 'pr.number': '99', 'pr.state': 'closed' },
  })
  await (await team.tasks.claim(doneTask.task.id)).complete()
  const plain = await team.tasks.create('work', { text: 'no pull request', labels: { note: 'keep' } })
  const open = await team.tasks.create('work', { text: 'open', labels: { 'pr.number': '12' } })
  assert.equal((await team.thread(doneTask.task.id)).message.task?.state, 'completed')

  const result = await run(github({ 12: pull('a', 'open', [[done('success')]]) }))
  assert.equal(result.code, 0, result.stderr)
  assert.equal((await labels(doneTask.task.id))['pr.state'], 'closed')
  assert.equal((await labels(doneTask.task.id))['pr.checks'], undefined)
  assert.equal((await labels(doneTask.task.id))['board.task'], 'completed')
  assert.equal((await labels(plain.task.id)).note, 'keep')
  assert.equal((await labels(plain.task.id))['pr.number'], undefined)
  assert.equal((await labels(open.task.id))['pr.checks'], 'pass')
  assert.match(result.stdout, new RegExp(`^#${open.task.id}  open    pass     ${short('a')}\n$`))
})

test('a pr.number that is not a pull request number is not sent to GitHub', async (t) => {
  const { team, run, labels } = fixture(t)
  const bad = await team.tasks.create('work', { text: 'bad number', labels: { 'pr.number': '01', note: 'keep' } })
  const open = await team.tasks.create('work', { text: 'open', labels: { 'pr.number': '12' } })
  let called = false
  const send = github({ 12: pull('a', 'open', [[done('success')]]) })
  const asked = (url: string) => {
    const path = new URL(url).pathname
    return path.endsWith('/pulls/01') || path.endsWith('/pulls/1')
  }
  const result = await run(async (url) => {
    called = called || asked(url)
    return send(url)
  })
  assert.equal(result.code, 1)
  assert.equal(result.stderr, `error: pr.number on #${bad.task.id} is not a pull request number\n`)
  assert.equal(called, false)
  assert.equal((await labels(bad.task.id))['pr.number'], '01')
  assert.equal((await labels(bad.task.id)).note, 'keep')
  assert.equal((await labels(bad.task.id))['pr.state'], undefined)
  assert.equal((await labels(open.task.id))['pr.state'], 'open')
  const json = JSON.parse((await run(async (url) => send(url), ['--json'])).stdout)
  assert.deepEqual(json.unread, [{ id: bad.task.id, pr: '01', reason: 'not_a_number' }])
})

test('an unreadable pull request does not change that task', async (t) => {
  const { team, run, labels, version } = fixture(t)
  const missing = await team.tasks.create('work', { text: 'missing', labels: { 'pr.number': '50', 'pr.state': 'open' } })
  const before = await version(missing.task.id)
  const result = await run(github({}))
  assert.equal(result.code, 1)
  assert.equal(result.stderr, 'error: could not read pull request 50\n')
  assert.equal(result.stdout, '')
  assert.equal(await version(missing.task.id), before)
  assert.equal((await labels(missing.task.id))['pr.state'], 'open')
  assert.equal((await labels(missing.task.id))['pr.checks'], undefined)
})

test('mirror prs with no matching tasks prints that and does not read GitHub', async (t) => {
  const { run } = fixture(t)
  const send = async () => { throw new Error('github was read') }
  const result = await run(send)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'no open tasks with a pr\n')
  const json = await run(send, ['--json'])
  assert.equal(json.stdout, '{"tasks":[]}\n')
})

test('mirror prs does not copy this repo onto a task for another repo', async (t) => {
  const { team, run, labels, version } = fixture(t)
  const specs = { 12: pull('a', 'open', [[done('success')]]) }
  const home = await team.tasks.create('work', { text: 'this repo', labels: { 'pr.number': '12' } })
  const named = await team.tasks.create('plb/queue', {
    text: 'named as this repo', labels: { 'pr.number': '12', 'pr.repo': repo, 'work.id': 'plb-9' },
  })
  const otherRepo = await team.tasks.create('work', {
    text: 'other repo label', labels: { 'pr.number': '12', 'pr.repo': 'other/lib', 'pr.state': 'closed', note: 'keep' },
  })
  const otherTag = await team.tasks.create('work', {
    text: 'other work id', labels: { 'pr.number': '12', 'work.id': 'plb-4', 'pr.state': 'closed', note: 'keep' },
  })
  const otherChannel = await team.tasks.create('plb/queue', {
    text: 'other channel', labels: { 'pr.number': '12', 'pr.state': 'closed', note: 'keep' },
  })
  const before = await version(otherRepo.task.id)
  let asked = false
  const send = github(specs)
  const result = await run(async (url) => {
    asked = asked || /\/pulls\/(?!12$)/.test(new URL(url).pathname)
    return send(url)
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(asked, false)
  assert.equal((await labels(home.task.id))['pr.state'], 'open')
  assert.equal((await labels(home.task.id))['pr.checks'], 'pass')
  assert.equal((await labels(home.task.id))['pr.head'], short('a'))
  assert.equal((await labels(named.task.id))['pr.state'], 'open')
  assert.equal((await labels(named.task.id))['pr.checks'], 'pass')
  assert.equal((await labels(named.task.id))['work.id'], 'plb-9')
  for (const id of [otherRepo.task.id, otherTag.task.id, otherChannel.task.id]) {
    const row = await labels(id)
    assert.equal(row['pr.state'], 'closed')
    assert.equal(row['pr.checks'], undefined)
    assert.equal(row['pr.head'], undefined)
    assert.equal(row.note, 'keep')
  }
  assert.equal(await version(otherRepo.task.id), before)
})

test('mirror prs misuse exits 2', async () => {
  const misuse = async (...args: string[]) => {
    let stderr = ''
    const code = await runMirrorCommand(['mirror', 'prs', ...args], { stderr: (text) => { stderr += text } })
    return { code, stderr }
  }
  const expected = 'error: expected mirror prs --board URL --repo owner/name [--json]\n'
  for (const args of [
    [],
    ['--board', 'ftp://board.example/api', '--repo', repo],
    ['--board', 'https://user:pass@board.example/api', '--repo', repo],
    ['--board', 'https://board.example/api', '--repo', 'not a repo'],
    ['--board', boardUrl],
  ]) {
    const result = await misuse(...args)
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stderr, expected)
  }
})
