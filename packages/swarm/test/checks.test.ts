import { spawnSync as spawnSwarm } from 'node:child_process'
import { test as routingTest } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { acquire, tryAcquire } from '../src/checks/lock.ts'
import { checkAndPush } from '../src/checks/checkAndPush.ts'
import { liveSprites, retireCheck } from '../src/checks/retire.ts'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_ALLOW_PROTOCOL = 'file'

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-checks-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture(t: TestContext) {
  const dir = tempDir(t), repo = join(dir, 'repo'), remote = join(dir, 'origin.git')
  git(dir, 'init', '--template=', '-b', 'main', repo)
  git(dir, 'init', '--template=', '--bare', '-b', 'main', remote)
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'remote', 'add', 'origin', remote)
  const head = () => git(repo, 'rev-parse', 'HEAD')
  const commit = (text = 'candidate') => {
    writeFileSync(join(repo, 'sample.txt'), `${text}\n`)
    git(repo, 'add', 'sample.txt')
    git(repo, 'commit', '-m', 'fixture')
    return head()
  }
  const base = commit('base')
  git(repo, 'push', 'origin', 'main')
  const options = { repo, branch: 'main', command: [process.execPath, '-e', ''],
    lockPath: join(dir, 'lock'), statusDir: join(dir, 'statuses') }
  const expectRemote = (sha = base) => assert.equal(git(remote, 'show-ref', '--heads'), `${sha} refs/heads/main`)
  const state = (sha: string) => JSON.parse(readFileSync(join(options.statusDir, `${sha}.json`), 'utf8')).state
  return { dir, repo, remote, head, commit, base, options, expectRemote, state }
}

const fakeToken = () => ['ghp', 'Z'.repeat(36)].join('_')

test('check lock: never breaks for a live holder and releases after its parent dies', { timeout: 12_000 }, async (t) => {
  const path = join(tempDir(t), 'lock')
  const assertBusy = async (pending: ReturnType<typeof tryAcquire>) => {
    const result = await pending
    if (result.ok) await result.release()
    assert.equal(result.ok ? 'acquired' : result.reason, 'busy')
  }
  for (const stop of ['SIGKILL', 'EOF'] as const) {
    const holder = fork(new URL('./checks-holder.mjs', import.meta.url), [path], { silent: true })
    const closed = once(holder, 'close')
    t.after(async () => { holder.kill('SIGKILL'); await closed })
    const [message] = await once(holder, 'message', { signal: AbortSignal.timeout(3000) })
    assert.equal(message, 'held')
    await assertBusy(tryAcquire(path))
    if (stop === 'SIGKILL') {
      const start = performance.now()
      await assertBusy(acquire(path, { waitMs: 1500, pollMs: 50 }))
      assert.ok(performance.now() - start >= 1450, 'acquire returned early')
      await assertBusy(tryAcquire(path))
      assert.ok(process.kill(holder.pid!, 0), 'holder must still be alive')
      // Kill only Node; its Perl helper gets EOF when the OS closes the pipe.
      assert.ok(holder.kill('SIGKILL'))
      assert.deepEqual(await closed, [null, 'SIGKILL'])
    } else {
      holder.stdin!.end()
      assert.deepEqual(await closed, [0, null])
    }
    const next = await acquire(path, { waitMs: 2000, pollMs: 50 })
    assert.ok(next.ok, `lock stayed busy after ${stop}`)
    await next.release()
  }
})

test('passing check: does not push the wrong SHA or lose its pass record', async (t) => {
  const f = fixture(t)
  git(f.repo, 'switch', '--detach') // Local main still points at the base.
  const sha = f.commit()
  assert.deepEqual(await checkAndPush(f.options), { status: 'pushed', sha })
  f.expectRemote(sha)
  assert.equal(f.state(sha), 'pass')
})

test('failing check: does not advance origin or mark the SHA as passing', async (t) => {
  const f = fixture(t), sha = f.commit()
  const result = await checkAndPush({ ...f.options, command: [process.execPath, '-e', 'process.exit(7)'] })
  assert.equal(result.status, 'check_failed')
  f.expectRemote()
  assert.equal(f.state(sha), 'fail')
})

test('check changes HEAD: does not push either commit or miss head_changed', async (t) => {
  const f = fixture(t), sha = f.commit()
  const result = await checkAndPush({ ...f.options, command: ['git', 'commit', '--allow-empty', '-m', 'check changed HEAD'] })
  assert.notEqual(f.head(), sha)
  assert.deepEqual(result, { status: 'head_changed', sha })
  f.expectRemote()
})

test('private diff: does not push or expose the matched text in the result', async (t) => {
  const f = fixture(t), token = fakeToken()
  f.commit(token)
  const result = await checkAndPush(f.options)
  assert.equal(result.status, 'refused_privacy')
  assert.ok(!JSON.stringify(result).includes(token), 'result exposed matched text')
  f.expectRemote()
})

test('dirty worktree: does not push a check of uncommitted inputs', async (t) => {
  const f = fixture(t)
  f.commit()
  writeFileSync(join(f.repo, 'untracked.txt'), 'local work\n')
  assert.equal((await checkAndPush(f.options)).status, 'dirty')
  f.expectRemote()
})

test('concurrent check: does not let a second run through the held lock', async (t) => {
  const f = fixture(t), sha = f.commit()
  const started = Promise.withResolvers<'started'>(), finish = Promise.withResolvers<void>()
  // Fake only the external check command so its completion is controlled by the test.
  const first = checkAndPush({ ...f.options, run: async () => {
    started.resolve('started')
    await finish.promise
    return { stdout: '', exitCode: 0 }
  } })
  try {
    assert.equal(await Promise.race([started.promise, first]), 'started')
    assert.equal((await checkAndPush(f.options)).status, 'busy')
    f.expectRemote()
  } finally {
    finish.resolve()
    await first
  }
  f.expectRemote(sha)
})

test('retire readiness: does not block a safe tree or allow a running sprite, dirty tree, or unpushed commit', async (t) => {
  const f = fixture(t), sprites = join(f.dir, 'sprites')
  const check = () => retireCheck({ worktrees: [f.repo], runningSprites: () => liveSprites(sprites) })
  assert.equal((await check()).ok, true, 'clean HEAD on origin')
  mkdirSync(sprites)
  writeFileSync(join(sprites, 'fixture.pid'), `${process.pid}\n`)
  assert.equal((await check()).ok, false, 'running sprite')
  rmSync(sprites, { recursive: true })
  const untracked = join(f.repo, 'untracked.txt')
  writeFileSync(untracked, 'local work\n')
  assert.equal((await check()).ok, false, 'dirty tree')
  rmSync(untracked)
  f.commit()
  assert.equal((await check()).ok, false, 'unpushed commit')
})

test('retire fetch failure: does not authorize retirement from cached origin refs', async (t) => {
  const f = fixture(t)
  assert.equal(git(f.repo, 'rev-parse', 'origin/main'), f.head())
  renameSync(f.remote, `${f.remote}.offline`)
  assert.equal((await retireCheck({ worktrees: [f.repo], runningSprites: () => liveSprites(join(f.dir, 'sprites')) })).ok, false)
})

test('check preflight CLI: does not exit zero, omit the finding location, or echo matched text', (t) => {
  const f = fixture(t), token = fakeToken()
  f.commit(token)
  const cli = new URL('../src/checks/cli.ts', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import { run } from ${JSON.stringify(cli)}; process.exitCode = await run(process.argv.slice(1))`,
    '--', 'preflight', '--repo', f.repo, '--base', f.base], { encoding: 'utf8', timeout: 5000 })
  if (result.error) throw result.error
  assert.ok(!(result.stdout + result.stderr).includes(token), 'CLI exposed matched text')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, 'github-token sample.txt:1\n')
  assert.equal(result.stderr, '')
})

routingTest('swarm check reaches its area: a bad subcommand is the area\'s misuse, not an unknown command', () => {
  const result = spawnSwarm(process.execPath, ['src/cli.ts', 'check', 'bogus'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 2 || /unknown command/.test(result.stderr)) {
    throw new Error(`not routed to check: ${result.status} ${result.stderr}`)
  }
})
