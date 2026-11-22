import assert from 'node:assert/strict'
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chownSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { acquire, tryAcquire } from '../src/checks/lock.ts'
import { checkAndPush } from '../src/checks/checkAndPush.ts'
import { exec } from '../src/checks/exec.ts'
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

function fixture(t: TestContext, format = 'sha1') {
  const dir = tempDir(t), repo = join(dir, 'repo'), remote = join(dir, 'origin.git')
  git(dir, 'init', '--template=', `--object-format=${format}`, '-b', 'main', repo)
  git(dir, 'init', '--template=', `--object-format=${format}`, '--bare', '-b', 'main', remote)
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

test('lock refuses reserved suffixes and status-directory paths before writing', async (t) => {
  const f = fixture(t), { statusDir } = f.options
  const alias = join(f.dir, 'alias')
  mkdirSync(statusDir)
  symlinkSync(statusDir, alias)
  symlinkSync(join(statusDir, 'target.json'), join(f.dir, 'linked-lock'))
  const tryLock = async (path: string) => {
    const result = await tryAcquire(path)
    if (result.ok) await result.release()
  }
  for (const path of [join(f.dir, 'lock.owner'), join(f.dir, 'lock.json')]) {
    await assert.rejects(tryLock(path), /cannot end in/)
    await assert.rejects(checkAndPush({ ...f.options, lockPath: path }), /cannot end in/)
    assert.ok(!existsSync(path))
  }
  await assert.rejects(tryLock(join(f.dir, 'linked-lock')), /cannot open check lock file/)
  assert.ok(!existsSync(join(statusDir, 'target.json')))
  for (const path of [join(statusDir, 'lock'), join(alias, 'lock')]) {
    await assert.rejects(checkAndPush({ ...f.options, lockPath: path }), /inside the status directory/)
    assert.ok(!existsSync(path))
  }
})

test('passing check preserves the owner inode, keeps argv out of records, and pushes the checked SHA', async (t) => {
  const f = fixture(t), token = fakeToken(), owner = `${f.options.lockPath}.owner`
  const file = join(f.dir, token)
  symlinkSync(process.execPath, file)
  writeFileSync(owner, 'old owner\n')
  const inode = statSync(owner).ino
  git(f.repo, 'switch', '--detach') // Local main still points at the base.
  const sha = f.commit()
  assert.deepEqual(await checkAndPush({ ...f.options, command: [file, '-e', '', token] }), { status: 'pushed', sha })
  f.expectRemote(sha)
  assert.equal(statSync(owner).ino, inode, 'owner was replaced instead of updated')
  assert.equal(statSync(f.options.statusDir).mode & 0o777, 0o700)
  assert.equal(f.state(sha), 'pass')
  for (const path of [owner, join(f.options.statusDir, `${sha}.json`)]) {
    const record = readFileSync(path, 'utf8')
    assert.ok(!record.includes(token), 'record exposed argv')
    assert.equal(JSON.parse(record).command, 'check (3 args)')
  }
})

test('status directory refuses final symlinks, including a late swap, and foreign ownership', async (t) => {
  const f = fixture(t), sha = f.commit(), { statusDir } = f.options
  const target = join(f.dir, 'unrelated'), marker = join(target, `${sha}.json`)
  mkdirSync(target)
  writeFileSync(marker, 'unrelated')
  symlinkSync(target, statusDir)
  const invalidDir = /real directory owned by the current user/
  await assert.rejects(checkAndPush({ ...f.options, statusDir: `${statusDir}/` }), invalidDir)
  assert.ok(!existsSync(f.options.lockPath))
  rmSync(statusDir)
  mkdirSync(statusDir)
  await assert.rejects(checkAndPush({ ...f.options, run: async () => {
    rmSync(statusDir, { recursive: true })
    symlinkSync(target, statusDir)
    return { stdout: '', exitCode: 0 }
  } }), invalidDir)
  assert.equal(readFileSync(marker, 'utf8'), 'unrelated')
  const foreign = process.getuid?.() === 0 ? target : '/usr'
  if (foreign === target) chownSync(target, 65534, 65534)
  await assert.rejects(checkAndPush({ ...f.options, statusDir: foreign }), invalidDir)
  f.expectRemote()
})

test('status files are replaced atomically and never named with a SHA-256 ID', async (t) => {
  const f = fixture(t), sha = f.commit(), old = join(f.dir, 'old-status')
  const path = join(f.options.statusDir, `${sha}.json`)
  mkdirSync(f.options.statusDir)
  writeFileSync(path, 'old status')
  linkSync(path, old)
  assert.equal((await checkAndPush(f.options)).status, 'pushed')
  assert.equal(readFileSync(old, 'utf8'), 'old status')
  assert.equal(f.state(sha), 'pass')
  const wide = fixture(t, 'sha256')
  wide.commit()
  await assert.rejects(checkAndPush(wide.options), /40-character commit sha/)
  assert.ok(!existsSync(wide.options.statusDir))
  wide.expectRemote()
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

test('late HEAD change in statusSink stops the push', async (t) => {
  const f = fixture(t), sha = f.commit()
  const result = await checkAndPush({ ...f.options, statusSink: () => { f.commit('late change') } })
  assert.notEqual(f.head(), sha)
  assert.deepEqual(result, { status: 'head_changed', sha })
  f.expectRemote()
})

test('HEAD moving at push time cannot replace the captured SHA on origin', async (t) => {
  const f = fixture(t), sha = f.commit()
  git(f.repo, 'commit', '--allow-empty', '-m', 'not checked')
  const unchecked = f.head()
  git(f.repo, 'update-ref', 'HEAD', sha)
  const result = await checkAndPush({ ...f.options, git: (argv, options) => {
    if (argv[1] === 'push') git(f.repo, 'update-ref', 'HEAD', unchecked)
    return exec(argv, options)
  } })
  assert.deepEqual(result, { status: 'pushed', sha })
  assert.equal(f.head(), unchecked)
  f.expectRemote(sha)
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

test('retire rejects unpushed local tips, failed inventory, and an empty inventory', async (t) => {
  const f = fixture(t)
  const check = (run = exec) => retireCheck({ worktrees: [f.repo], exec: run, runningSprites: () => [] })
  const sha = f.commit()
  git(f.repo, 'branch', 'unpublished', sha)
  git(f.repo, 'update-ref', 'HEAD', f.base)
  git(f.repo, 'restore', '--source=HEAD', '--staged', '--worktree', 'sample.txt')
  const result = await check()
  assert.equal(result.worktrees[0]?.onOrigin, true)
  assert.equal(result.ok, false)
  assert.deepEqual(result.branches.map(({ name, onOrigin }) => [name, onOrigin]), [['main', true], ['unpublished', false]])
  git(f.repo, 'branch', '-D', 'unpublished')
  assert.equal((await check()).ok, true)
  assert.equal((await check((argv, options) => argv.at(-1) === 'refs/heads'
    ? Promise.resolve({ stdout: 'refs/heads/main ' + f.base, exitCode: 1 }) : exec(argv, options))).ok, false)
  git(f.repo, 'switch', '--detach')
  git(f.repo, 'branch', '-D', 'main')
  assert.equal((await check()).ok, false)
})

function checkCli(...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'check', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000,
  })
  if (result.error) throw result.error
  return result
}

test('preflight refuses credentials added then removed from outgoing history, including merges', async (t) => {
  for (const merge of [false, true]) {
    const f = fixture(t), token = fakeToken()
    if (merge) {
      git(f.repo, 'branch', 'side')
      git(f.repo, 'commit', '--allow-empty', '-m', 'main parent')
      const side = git(f.repo, 'commit-tree', 'HEAD^{tree}', '-p', f.base, '-m', 'side parent')
      git(f.repo, 'update-ref', 'refs/heads/side', side)
      git(f.repo, 'merge', '--no-commit', '--no-ff', 'side')
    }
    f.commit(token)
    f.commit('base')
    assert.equal((await checkAndPush(f.options)).status, 'refused_privacy', `push, merge=${merge}`)
    f.expectRemote()
    const cli = checkCli('preflight', '--repo', f.repo, '--base', f.base)
    assert.ok(!(cli.stdout + cli.stderr).includes(token), 'CLI exposed matched text')
    assert.equal(cli.status, 1, `preflight, merge=${merge}`)
    assert.match(cli.stdout, /^github-token sample\.txt:1\n/)
  }
})

test('finding paths cannot expose private text in results, text, or JSON', async (t) => {
  const f = fixture(t), token = fakeToken()
  writeFileSync(join(f.repo, `${token}.txt`), `${['npm', 'Q'.repeat(36)].join('_')}\n`)
  git(f.repo, 'add', '.')
  f.commit(token)
  const result = await checkAndPush(f.options)
  assert.ok(!JSON.stringify(result).includes(token), 'result exposed a private path')
  assert.equal(result.status, 'refused_privacy')
  assert.ok(result.findings.some(({ file }) => file === '[redacted]'))
  for (const args of [[], ['--json']]) {
    const cli = checkCli('preflight', '--repo', f.repo, '--base', f.base, ...args)
    assert.ok(!(cli.stdout + cli.stderr).includes(token), 'preflight exposed a private path')
    assert.equal(cli.status, 1)
    assert.ok(cli.stdout.includes('[redacted]'))
  }
  const cli = checkCli('run', '--repo', f.repo, '--branch', 'main', '--lock', f.options.lockPath,
    '--status-dir', f.options.statusDir, '--', ...f.options.command)
  assert.ok(!(cli.stdout + cli.stderr).includes(token), 'check run exposed a private path')
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /npm-token \[redacted\]:1/)
  f.expectRemote()
})

test('swarm check reaches its area: a bad subcommand is the area\'s misuse, not an unknown command', () => {
  const result = checkCli('bogus')
  if (result.status !== 2 || /unknown command/.test(result.stderr)) {
    throw new Error(`not routed to check: ${result.status} ${result.stderr}`)
  }
})
