import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { RefConflict, RefStoreError } from '../src/index.ts'
import { git, identity, refsAt, tempDir } from './remote-support.ts'

const brief = 'remote/worker/brief'
const full = `refs/heads/${brief}`

async function clones(t: TestContext) {
  const root = await tempDir(t)
  const seed = join(root, 'seed')
  const remote = join(root, 'remote.git')
  const one = join(root, 'one')
  const two = join(root, 'two')
  await mkdir(seed)
  git(seed, 'init', '-b', 'main')
  await writeFile(join(seed, 'app.txt'), 'code\n')
  git(seed, 'add', 'app.txt')
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-m', 'seed')
  git(root, 'clone', '--bare', seed, remote)
  git(root, 'clone', remote, one)
  git(root, 'clone', remote, two)
  return { remote, one, two, a: refsAt(one), b: refsAt(two) }
}

test('exchange commits travel between clones by ordinary Git sync', async (t) => {
  const { remote, one, two, a, b } = await clones(t)
  const first = await a.write(brief, 'brief.md', 'hello, 世界\n\n', null)
  const second = await a.write(brief, 'notes/empty.txt', '', first)
  assert.deepEqual(await b.read(brief, 'brief.md'), { head: null, text: null })
  git(one, 'push', remote, `${full}:${full}`)
  git(two, 'fetch', remote, `${full}:${full}`)
  assert.deepEqual(await b.read(brief, 'brief.md'), { head: second, text: 'hello, 世界\n\n' })
  assert.deepEqual(await b.read(brief, 'notes/empty.txt'), { head: second, text: '' })
  assert.equal(git(two, 'show', '-s', '--format=%an <%ae>%n%cn <%ce>', second),
    `${identity.name} <${identity.email}>\n`.repeat(2))
})

test('after syncing a moved head, a stale writer is rejected without overwriting the winner', async (t) => {
  const { remote, one, two, a, b } = await clones(t)
  const first = await a.write(brief, 'brief.md', 'first', null)
  git(one, 'push', remote, `${full}:${full}`)
  git(two, 'fetch', remote, `${full}:${full}`)
  const snapshot = await b.read(brief, 'brief.md')
  assert.equal(snapshot.head, first)
  const latest = await a.write(brief, 'brief.md', 'latest', first)
  git(one, 'push', remote, `${full}:${full}`)
  git(two, 'fetch', remote, `${full}:${full}`)
  await assert.rejects(b.write(brief, 'brief.md', 'stale', snapshot.head), {
    name: 'RefConflict', reason: 'head_moved', expectedHead: first, actualHead: latest,
  })
  assert.deepEqual(await b.read(brief, 'brief.md'), { head: latest, text: 'latest' })
})

test('competing same-head writes in one clone cannot both succeed', async (t) => {
  const { a } = await clones(t)
  const head = await a.write(brief, 'brief.md', 'initial', null)
  const texts = ['one', 'two', 'three', 'four']
  const results = await Promise.allSettled(texts.map((text) => a.write(brief, 'brief.md', text, head)))
  const successes = results.flatMap((result, i) => result.status === 'fulfilled' ? [{ head: result.value, text: texts[i] }] : [])
  assert.equal(successes.length, 1)
  for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof RefConflict)
  assert.deepEqual(await a.read(brief, 'brief.md'), successes[0])
})

test('exchange writes do not share files between branches or touch staged work', async (t) => {
  const { a, one } = await clones(t)
  await writeFile(join(one, 'app.txt'), 'staged\n')
  git(one, 'add', 'app.txt')
  await writeFile(join(one, 'app.txt'), 'unstaged\n')
  const main = git(one, 'rev-parse', 'HEAD')
  const state = git(one, 'status', '--porcelain=v1')
  const briefHead = await a.write(brief, 'brief.md', 'only here', null)
  const control = 'remote/worker/control'
  const controlHead = await a.write(control, 'stop.txt', 'only there', null)
  assert.deepEqual(await a.read(control, 'brief.md'), { head: controlHead, text: null })
  assert.deepEqual(await a.read(brief, 'app.txt'), { head: briefHead, text: null })
  assert.deepEqual(await a.read(brief, 'stop.txt'), { head: briefHead, text: null })
  assert.equal(git(one, 'rev-parse', 'HEAD'), main)
  assert.equal(git(one, 'ls-tree', '--name-only', 'main'), 'app.txt\n')
  assert.equal(git(one, 'status', '--porcelain=v1'), state)
  assert.equal(git(one, 'show', ':app.txt'), 'staged\n')
  await assert.rejects(a.write('main', 'brief.md', 'no', main.trim()), { name: 'RefStoreError', reason: 'invalid_branch' })
})

test('exchange files are bounded by UTF-8 bytes', async (t) => {
  const { a } = await clones(t)
  const text = 'é'.repeat(32 * 1024)
  const head = await a.write(brief, 'brief.md', text, null)
  await assert.rejects(a.write(brief, 'brief.md', `${text}é`, head), (error) =>
    error instanceof RefStoreError && error.reason === 'file_too_large')
  assert.deepEqual(await a.read(brief, 'brief.md'), { head, text })
})
