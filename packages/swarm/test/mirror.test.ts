import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { mirrorStore, readRepo, registerMirrorSchema, syncMirror, type MirrorClock, type MirrorKind } from '../src/mirror/index.ts'

const repo = 'acme/web'
const kinds = ['pr', 'branch', 'issue'] as const
const pr = (number: number) => ({ number, state: 'open' })
const branch = (name: string) => ({ name, commit: { sha: 'a'.repeat(40) } })
const issue = (number: number) => ({ number, state: 'open' })

async function fixture(t: TestContext, beforePost?: () => void) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  await registerMirrorSchema(team)
  let time = 0
  const now = () => ++time
  const writer = team.as('mirror')
  const store = mirrorStore({
    board: beforePost ? { ...writer, async post(...args) { beforePost(); return writer.post(...args) } } : writer,
    author: (await writer.me()).actor, now,
  })
  const pages: Record<string, object[][] | null> = {
    pulls: [[pr(1)]], branches: [[branch('main')]], issues: [[issue(3)]],
  }
  const calls: (readonly string[])[] = []
  const exec = async (args: readonly string[]) => {
    calls.push(args)
    const prefix = `repos/${repo}/`
    const endpoint = args.find((arg) => arg.toLowerCase().startsWith(prefix))?.slice(prefix.length).split('?')[0]
    const response = endpoint ? pages[endpoint] : undefined
    return response ? { code: 0, stdout: JSON.stringify(response) } : { code: 1, stdout: '' }
  }
  const sync = ({ repo: target = repo, now: clock = now, ...options }:
    Pick<Parameters<typeof readRepo>[0], 'exec' | 'token' | 'maxPages'> & { repo?: string; now?: MirrorClock } = {}) =>
    syncMirror({ repo: target, store, now: clock, reader: (scope) => readRepo({ ...scope, token: '', exec, ...options }) })
  const list = (kind?: MirrorKind) => store.list({ repo, kind })
  const status = (kind: MirrorKind) => store.status.read({ repo, kind })
  return { team, pages, calls, sync, list, status }
}

test('reruns and concurrent syncs do not create duplicate records', async (t) => {
  const { sync, list } = await fixture(t)
  // Race on an empty board, where both syncs could try to create the same record.
  const first = (await Promise.all([sync(), sync()])).flat()
  const again = await sync()
  for (const kind of kinds) {
    assert.equal(first.filter((row) => row.kind === kind).reduce((n, row) => n + row.created, 0), 1, kind)
    assert.equal(again.find((row) => row.kind === kind)?.created, 0, kind)
    assert.equal((await list(kind)).length, 1, kind)
  }
})

test('repo spellings share the same mirror records and statuses', async (t) => {
  const { team, sync, list } = await fixture(t)
  await sync()
  const again = await sync({ repo: 'ACME/web' })
  assert.ok(again.every(({ complete }) => complete))
  const { messages } = await team.channel(`mirror/${repo}`).messages()
  assert.equal(messages.length, 6)
  assert.deepEqual((await list()).map((row) => [row.kind, row.key, row.repo]).sort(), [
    ['branch', 'main', repo], ['issue', '3', repo], ['pr', '1', repo],
  ])
})

test('an open draft PR is mirrored and its state changes to merged', async (t) => {
  const { pages, sync, list } = await fixture(t)
  pages.pulls = [[{ ...pr(1), draft: true }]]
  await sync()
  assert.deepEqual((await list('pr')).map(({ key, draft, state }) => ({ key, draft, state })), [
    { key: '1', draft: true, state: 'open' },
  ])

  pages.pulls = [[{ ...pr(1), state: 'closed', merged_at: '2026-01-01T00:00:00Z' }]]
  await sync()
  assert.deepEqual((await list('pr')).map(({ key, state }) => ({ key, state })), [
    { key: '1', state: 'merged' },
  ])
})

test('a branch missing from a complete read is marked gone rather than deleted', async (t) => {
  const { pages, sync, list, status } = await fixture(t)
  await sync()
  pages.branches = [[]]
  await sync()
  assert.equal((await status('branch'))?.complete, true)
  assert.deepEqual((await list('branch')).map(({ key, state }) => ({ key, state })), [
    { key: 'main', state: 'gone' },
  ])
})

test('an older poll cannot insert a branch absent from a newer complete read', async (t) => {
  const { pages, sync, list, status } = await fixture(t)
  pages.branches = [[]]
  await sync({ now: () => 2 })
  const newer = await status('branch')
  assert.equal(newer?.complete, true)

  pages.branches = [[branch('main')]]
  const older = await sync({ now: () => 1 })
  assert.deepEqual(await list('branch'), [])
  assert.deepEqual(await status('branch'), newer)
  assert.equal(older.find(({ kind }) => kind === 'branch')?.stale, true)
})

test('a failed branch read preserves old branches without blocking PRs or issues', async (t) => {
  const { pages, sync, list, status } = await fixture(t)
  await sync()
  pages.branches = null
  pages.pulls = [[pr(1), pr(2)]]
  pages.issues = [[issue(3), issue(4)]]
  await sync()

  assert.deepEqual((await list('branch')).map(({ key, state }) => ({ key, state })), [
    { key: 'main', state: 'open' },
  ])
  const result = await status('branch')
  assert.equal(result?.complete, false)
  assert.equal(result?.reason, 'gh_failed')
  assert.ok((await list('pr')).some(({ key, state }) => key === '2' && state === 'open'))
  assert.ok((await list('issue')).some(({ key, state }) => key === '4' && state === 'open'))
})

test('hitting the PR page limit preserves old PRs without blocking branches or issues', async (t) => {
  const { pages, sync, list, status } = await fixture(t)
  pages.pulls = [[pr(1), pr(2)]]
  await sync()
  // Exactly the page budget: one known PR changed, and another is no longer visible.
  pages.pulls = [[{ ...pr(1), state: 'closed', merged_at: null }], []]
  pages.branches = [[branch('main'), branch('next')]]
  pages.issues = [[issue(3), issue(4)]]
  await sync({ maxPages: 2 })

  const result = await status('pr')
  assert.equal(result?.complete, false)
  assert.equal(result?.reason, 'page_limit')
  assert.deepEqual((await list('pr')).map(({ key, state }) => [key, state]).sort(), [
    ['1', 'open'], ['2', 'open'],
  ])
  assert.ok((await list('branch')).some(({ key, state }) => key === 'next' && state === 'open'))
  assert.ok((await list('issue')).some(({ key, state }) => key === '4' && state === 'open'))
})

test('the issues endpoint does not add a second record for a PR', async (t) => {
  const { pages, sync, list } = await fixture(t)
  pages.issues = [[issue(3), { ...issue(1), pull_request: { url: `https://api.github.com/repos/${repo}/pulls/1` } }]]
  await sync()
  assert.deepEqual((await list()).filter(({ kind }) => kind !== 'branch')
    .map(({ kind, key }) => `${kind}:${key}`).sort(), ['issue:3', 'pr:1'])
})

test('a null pull_request makes the issue read partial without marking issues gone', async (t) => {
  const { pages, sync, list, status } = await fixture(t)
  await sync()
  pages.issues = [[{ ...issue(4), pull_request: null }]]
  await sync()

  const result = await status('issue')
  assert.equal(result?.complete, false)
  assert.equal(result?.reason, 'unexpected_response')
  assert.deepEqual((await list('issue')).map(({ key, state }) => [key, state]), [['3', 'open']])
})

test('an interrupted PR write leaves its status incomplete and mirrors the other kinds', async (t) => {
  let failPost = false
  const { pages, sync, list, status } = await fixture(t, () => {
    if (!failPost) return
    failPost = false
    throw new Error('injected board post failure')
  })
  await sync()
  assert.equal((await status('pr'))?.complete, true)
  pages.pulls = [[pr(1), pr(2)]]
  pages.branches = [[branch('main'), branch('next')]]
  pages.issues = [[issue(3), issue(4)]]
  failPost = true
  await assert.rejects(sync(), { name: 'Error', message: 'mirror write failed' })

  const result = await status('pr')
  assert.equal(result?.complete, false)
  assert.equal(result?.reason, 'sync_interrupted')
  assert.ok((await list('branch')).some(({ key, state }) => key === 'next' && state === 'open'))
  assert.ok((await list('issue')).some(({ key, state }) => key === '4' && state === 'open'))
})

test('mirror status ignores a complete status posted by another actor', async (t) => {
  const { team, pages, sync, status } = await fixture(t)
  pages.issues = null
  await sync()
  const partial = await status('issue')
  assert.equal(partial?.complete, false)

  const channel = `mirror/${repo}`
  const labels = { 'mirror.status': 'issue' }
  const { threads: [trusted] } = await team.threads({ channel, label: labels })
  assert.ok(trusted)
  await team.as('other').post(channel, {
    labels,
    text: block('swarm-mirror@1', { repo, kind: 'issue', complete: true, observedAt: new Date(2).toISOString() }),
  })
  assert.deepEqual(await status('issue'), partial)

  // A trusted status must not hide a foreign one from this check.
  await team.as('mirror').delete(trusted.message.id)
  assert.equal(await status('issue'), undefined)
})

test('a full sync only sends GET requests without bodies to GitHub', async (t) => {
  const { calls, sync } = await fixture(t)
  assert.ok((await sync()).every(({ complete }) => complete))
  assert.ok(calls.length > 0)
  for (const [command, ...args] of calls) {
    assert.equal(command, 'api')
    for (const [i, arg] of args.entries()) {
      assert.doesNotMatch(arg, /^(?:-[fF]|--(?:field|raw-field|input)(?:=|$))/u)
      if (arg === '--method' || arg === '-X') assert.equal(args[i + 1], 'GET')
      if (arg.startsWith('--method=')) assert.equal(arg.slice('--method='.length), 'GET')
      if (arg.startsWith('-X') && arg.length > 2) assert.match(arg, /^-X(?:=)?GET$/u)
    }
  }
})

test('the gh credential stays in the child environment and out of board messages and errors', async (t) => {
  const { team, pages, sync, list } = await fixture(t)
  const token = ['synthetic', 'mirror', 'credential'].join('-')
  // The injected reader exec accepts argv only. Fake the gh executable to see its actual env.
  const dir = await mkdtemp(join(tmpdir(), 'mirror-test-gh-'))
  const log = join(dir, 'calls.jsonl')
  const path = process.env.PATH
  t.after(async () => {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    await rm(dir, { recursive: true, force: true })
  })
  await writeFile(join(dir, 'gh'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
const token = process.env.GH_TOKEN
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: { GH_TOKEN: token } }) + '\\n')
const prefix = ${JSON.stringify(`repos/${repo}/`)}
const endpoint = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).split('?')[0]
const pages = ${JSON.stringify(pages)}[endpoint]
if (!pages) process.exit(1)
if (endpoint === 'pulls') pages[0].push({ number: 2, state: 'open', title: token })
console.log(JSON.stringify(pages))
`, { mode: 0o700 })
  process.env.PATH = dir
  await sync({ exec: undefined, token })

  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
    args: string[]; env: { GH_TOKEN?: string }
  })
  for (const { args, env } of calls) {
    assert.ok(env.GH_TOKEN === token, 'gh must receive the credential in its environment')
    assert.ok(!JSON.stringify(args).includes(token), 'gh argv must not contain the credential')
  }
  assert.ok((await list()).length > 0)
  const { messages } = await team.channel(`mirror/${repo}`).messages()
  assert.ok(!JSON.stringify(messages).includes(token), 'board messages must not contain the credential')

  const result = await readRepo({ repo, token, exec: async () => { throw new Error(`auth failed: ${token}`) } })
    .catch((error: unknown) => String(error))
  assert.ok(!JSON.stringify(result).includes(token), 'reader errors must not contain the credential')
  assert.ok(Array.isArray(result) && result.length > 0 && result.every(
    ({ complete, reason }) => !complete && reason === 'gh_failed',
  ))
})

test('a long branch name with slashes and dots round-trips exactly', async (t) => {
  const { pages, sync, list } = await fixture(t)
  const name = `feature/v1.${'x'.repeat(201)}`
  pages.branches = [[branch(name)]]
  await sync()
  assert.deepEqual((await list('branch')).map(({ key, head }) => [key, head?.ref]), [[name, name]])
})
