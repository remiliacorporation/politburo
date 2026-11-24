import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const forkScript = fileURLToPath(new URL('../fork-thinness.sh', import.meta.url))
const claimScript = fileURLToPath(new URL('../time-to-first-claim.mjs', import.meta.url))
const signalScript = fileURLToPath(new URL('./signal-if-same.py', import.meta.url))
const src = 'packages/board/src/'
const unit = 'lines added in packages/board/src vs merge base with the selected upstream branch'

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'metrics-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  return result
}

function fixture(t) {
  const root = temp(t)
  const upstream = join(root, 'upstream with spaces')
  const fork = join(root, 'fork')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, {
    HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Metrics test', GIT_AUTHOR_EMAIL: 'metrics@example.test',
    GIT_COMMITTER_NAME: 'Metrics test', GIT_COMMITTER_EMAIL: 'metrics@example.test',
    GIT_ALLOW_PROTOCOL: 'file',
  })
  function git(repo, ...args) {
    const result = run('git', ['-C', repo, ...args], env)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  function put(repo, path, text) {
    const file = join(repo, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  function commit(repo, message) {
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', message)
    return git(repo, 'rev-parse', 'HEAD')
  }
  git(root, 'init', '-q', '-b', 'main', upstream)
  put(upstream, src + 'cli/main.ts', 'keep\ndelete\n')
  const base = commit(upstream, 'base')
  git(root, 'clone', '-q', upstream, fork)
  put(upstream, 'README.md', 'first\n')
  commit(upstream, 'upstream one')
  put(upstream, src + 'server/tasks.ts', 'upstream-only line\n')
  const tip = commit(upstream, 'upstream two')
  put(fork, src + 'cli/main.ts', 'keep\nadded one\nadded two\n')
  put(fork, src + 'conformance/index.ts', 'hot\n')
  put(fork, src + 'other\tfile.ts', '1\n2\n3\n4\n')
  put(fork, 'packages/board/test/ignored.ts', 'not in src\n')
  const head = commit(fork, 'fork change')
  const metric = (remote = upstream, args = []) => run('bash', [forkScript,
    '--repo', fork, '--upstream-url', remote, ...args], env)
  return { root, upstream, fork, put, commit, git, base, tip, head, metric, env }
}

function failure(result, reason) {
  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^error: [^\r\n]+\n$/)
  assert.match(result.stderr, reason)
}

test('fork metric counts additions, not deletions or upstream-only changes', (t) => {
  const { metric, base, tip, head } = fixture(t)
  const result = metric()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    metric: 'fork_thinness', value: 7, unit, lines_added_src: 7, lines_added_hot: 3,
    hot_files: {
      [src + 'conformance/index.ts']: 1,
      [src + 'cli/main.ts']: 2,
      [src + 'server/tasks.ts']: 0,
      [src + 'cli/commands.ts']: 0,
      [src + 'api/routes.ts']: 0,
      [src + 'server/serve.ts']: 0,
    },
    commits_behind_upstream: 2, head, merge_base: base, upstream: tip,
  })
})

test('fork metric reports zero for an empty diff at an explicit ref', (t) => {
  const { metric, base, git, upstream } = fixture(t)
  git(upstream, 'branch', 'baseline', base)
  const result = metric(upstream, ['--head', base, '--upstream-branch', 'baseline'])
  assert.equal(result.status, 0, result.stderr)
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.head, base)
  assert.equal(doc.upstream, base)
  assert.equal(doc.value, 0)
  assert.equal(doc.unit, unit)
  assert.equal(doc.lines_added_src, 0)
  assert.equal(doc.lines_added_hot, 0)
  assert.equal(doc.commits_behind_upstream, 0)
})

test('fork metric fails quietly when upstream is unreachable', (t) => {
  const { metric, root } = fixture(t)
  failure(metric(join(root, 'missing')), /could not fetch/)
})

test('fork metric fails quietly with no merge base', (t) => {
  const { metric, root, put, commit, git } = fixture(t)
  const unrelated = join(root, 'unrelated')
  git(root, 'init', '-q', '-b', 'main', unrelated)
  put(unrelated, 'README.md', 'unrelated\n')
  commit(unrelated, 'unrelated')
  failure(metric(unrelated), /no merge base/)
})

test('fork metric rejects binary additions under src', (t) => {
  const { metric, fork, put, commit } = fixture(t)
  put(fork, src + 'binary', Buffer.from([0, 1, 2]))
  commit(fork, 'binary')
  failure(metric(), /binary row/)
})

function shim(root, env, name, body) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 })
  if (!env.PATH.startsWith(`${bin}:`)) env.PATH = `${bin}:${env.PATH}`
}

function systemCommand(name) {
  const result = run('bash', ['-c', `command -v ${name}`])
  assert.equal(result.status, 0)
  return JSON.stringify(result.stdout.trim())
}

test('fork metric counts only the appended lines across 1,300 renames', (t) => {
  const { upstream, fork, put, git, commit, metric } = fixture(t)
  const count = 1300
  for (let i = 0; i < count; i++) {
    put(fork, `${src}old/${i}`, Array.from({ length: 20 }, (_, j) => `file ${i} line ${j}\n`).join(''))
  }
  put(fork, 'outside.txt', 'one\ntwo\n')
  const before = commit(fork, 'before renames')
  git(upstream, 'fetch', '-q', fork, `${before}:refs/heads/baseline`)
  mkdirSync(join(fork, src, 'new'), { recursive: true })
  for (let i = 0; i < count; i++) {
    const renamed = join(fork, src, 'new', `renamed-${i}`)
    renameSync(join(fork, src, 'old', String(i)), renamed)
    writeFileSync(renamed, 'appended\n', { flag: 'a' })
  }
  renameSync(join(fork, 'outside.txt'), join(fork, src, 'entered.txt'))
  commit(fork, 'after renames')
  const result = metric(upstream, ['--upstream-branch', 'baseline'])
  assert.equal(result.status, 0, result.stderr)
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.value, count + 2)
  assert.equal(doc.lines_added_src, count + 2)
})

test('fork metric fails quietly on a skipped rename warning even when Git exits zero', (t) => {
  const { root, env, metric } = fixture(t)
  const git = systemCommand('git')
  shim(root, env, 'git', `for arg; do
  if [[ $arg == diff ]]; then
    ${git} "$@"
    printf '%s\\n' 'warning: exhaustive rename detection was skipped due to too many files.' >&2
    exit 0
  fi
done
exec ${git} "$@"`)
  failure(metric(), /skipped exhaustive rename detection/)
})

test('fork metric leaves source object ctime untouched', (t) => {
  const { fork, head, metric } = fixture(t)
  const object = join(fork, '.git/objects', head.slice(0, 2), head.slice(2))
  const before = statSync(object, { bigint: true })
  assert.equal(metric().status, 0)
  assert.equal(statSync(object, { bigint: true }).ctimeNs, before.ctimeNs)
})

for (const [deadline, reason] of [[60, /could not resolve source head/], [360, /overall timeout exceeded/]]) {
  test(`fork metric escalates the ${deadline}s deadline for a stuck Git`, (t) => {
    const { root, env, metric } = fixture(t)
    const timeout = systemCommand('timeout')
    // Exercise real GNU timeout with shortened deadlines and KILL grace.
    shim(root, env, 'timeout', `args=()
for arg; do
  case "$arg" in
    --kill-after=5) args+=(--kill-after=.1) ;;
    ${deadline}) args+=(.1) ;;
    *) args+=("$arg") ;;
  esac
done
exec ${timeout} "\${args[@]}"`)
    shim(root, env, 'git', `trap '' TERM
while :; do :; done`)
    const start = performance.now()
    failure(metric(), reason)
    assert.ok(performance.now() - start < 2000, 'the stuck Git outlasted the shortened deadline')
  })
}

const claim = (...args) => run(process.execPath, [claimScript, ...args])
for (const [name, args, reason] of [
  ['unknown argument', ['--bogus'], /unknown argument/],
  ['missing value', ['--repo', '--head', 'HEAD'], /missing value for --repo/],
  ['invalid timeout', ['--timeout', '0'], /--timeout must be a positive integer/],
]) {
  test(`claim metric rejects ${name}`, () => failure(claim(...args), reason))
}

test('claim metric fails quietly when its source is missing', (t) => {
  failure(claim('--repo', join(temp(t), 'not-a-repo'), '--timeout', '5'), /clone failed/)
})

function claimEnv() {
  return { PATH: process.env.PATH }
}

test('claim metric refuses Node debugging before spawning', (t) => {
  const env = { ...claimEnv(), NODE_DEBUG: 'child_process' }
  failure(run(process.execPath, [claimScript, '--repo', join(temp(t), 'missing')], env), /NODE_DEBUG must be unset or empty/)
})

test('claim metric passes only approved ambient values to children', (t) => {
  const { root, fork } = fixture(t)
  const marker = join(root, 'allowlist-ok')
  const env = {
    ...claimEnv(), CI: 'not-the-judge', NODE_OPTIONS: '--no-warnings',
    EXAMPLE_TOKEN: 'synthetic', EXAMPLE_AUTH: 'synthetic', UNUSED_VALUE: 'synthetic',
    HTTPS_PROXY: 'https://proxy.example.test', CURL_CA_BUNDLE: '/synthetic-ca',
  }
  shim(root, env, 'pnpm', `[[ ! -v EXAMPLE_TOKEN && ! -v EXAMPLE_AUTH && ! -v UNUSED_VALUE && ! -v NODE_OPTIONS && ! -v NODE_DEBUG ]]
[[ $CI == 1 && $HOME == "$TMPDIR" && $XDG_CONFIG_HOME == "$HOME/config" ]]
[[ $HTTPS_PROXY == https://proxy.example.test && $CURL_CA_BUNDLE == /synthetic-ca ]]
touch ${JSON.stringify(marker)}
exit 9`)
  failure(run(process.execPath, [claimScript, '--repo', fork], env), /install failed/)
  assert.ok(existsSync(marker), 'install did not receive the allowlisted environment')
})

function processIdentity(pid) {
  pid = Number(pid)
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // After the parenthesized comm, state is field 3 and start time is field 22.
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    if (fields[0] !== 'Z' && /^\d+$/.test(fields[19])) return { pid, startTime: fields[19] }
  } catch (err) {
    if (!['ENOENT', 'ESRCH', 'EACCES'].includes(err.code)) throw err
  }
}

function live(identity) {
  const current = identity && processIdentity(identity.pid)
  return Boolean(current && current.startTime === identity.startTime)
}

function signalIfSame(identity, signal, { python = 'python3', script = signalScript } = {}) {
  return spawnSync(python, ['-I', script, String(identity.pid), identity.startTime, signal], {
    stdio: 'ignore', timeout: 1_000, killSignal: 'SIGKILL',
  })
}

export function killIfSame(identity, signal, options) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 1) return false
  const result = signalIfSame(identity, signal, options)
  return !result.error && result.signal === null && result.status === 0
}

function killOwnedGroup(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch (err) {
    if (err.code !== 'ESRCH') throw err
  }
}

for (const stale of [true, false]) {
  test(`cleanup ${stale ? 'ignores a stale' : 'kills a matching'} process identity`, { timeout: 2_000 }, async (t) => {
    // cat stays alive until stdin closes, so a stale PID must exit normally, not by SIGKILL.
    const child = spawn('cat', { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: claimEnv() })
    t.after(() => killOwnedGroup(child, 'SIGKILL'))
    const exited = once(child, 'exit')
    await once(child, 'spawn')
    const identity = processIdentity(child.pid)
    assert.ok(identity)
    const signalled = killIfSame(stale ? { ...identity, startTime: '-1' } : identity, 'SIGKILL')
    if (stale) child.stdin.end()
    assert.equal(signalled, !stale)
    assert.deepEqual(await exited, stale ? [0, null] : [null, 'SIGKILL'])
  })
}

for (const [name, option] of [['helper script', 'script'], ['python3 command', 'python']]) {
  test(`cleanup leaves a matching process alive when the ${name} is missing`, { timeout: 2_000 }, async (t) => {
    const missing = join(temp(t), 'missing')
    const child = spawn('cat', { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: claimEnv() })
    t.after(() => killOwnedGroup(child, 'SIGKILL'))
    const exited = once(child, 'exit')
    await once(child, 'spawn')
    const identity = processIdentity(child.pid)
    assert.ok(identity)
    const signalled = killIfSame(identity, 'SIGKILL', { [option]: missing })
    child.stdin.end()
    assert.deepEqual(await exited, [0, null], 'cleanup killed the sleeper despite the helper startup failure')
    assert.equal(signalled, false)
  })
}

test('pidfd helper refuses a live PID with a stale start time', { timeout: 3_000 }, async (t) => {
  const child = spawn('cat', { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: claimEnv() })
  t.after(() => killOwnedGroup(child, 'SIGKILL'))
  const exited = once(child, 'exit')
  await once(child, 'spawn')
  const identity = processIdentity(child.pid)
  assert.ok(identity)

  // Model a reused PID: the PID exists, but belongs to a different start tick.
  const stale = { ...identity, startTime: String(BigInt(identity.startTime) - 1n) }
  const result = signalIfSame(stale, 'SIGKILL')
  // A refusal alone does not prove pidfd is available; a matching signal must succeed.
  const matching = signalIfSame(identity, 'SIGCONT')
  child.stdin.end()
  assert.deepEqual(await exited, [0, null], 'the helper signalled a stale identity')
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.ifError(matching.error)
  assert.equal(matching.status, 0, 'Python with working pidfd support is required')
})

test('fork metric fails quietly on a stalled HTTP fetch and kills the remote helper', { timeout: 8_000 }, async (t) => {
  const { root, fork, env } = fixture(t)
  const timeout = systemCommand('timeout')
  shim(root, env, 'timeout', `args=()
for arg; do
  case "$arg" in
    120) args+=(1) ;;
    360) args+=(5) ;;
    --kill-after=5) args+=(--kill-after=.1) ;;
    *) args+=("$arg") ;;
  esac
done
exec ${timeout} "\${args[@]}"`)
  Object.assign(env, { GIT_ALLOW_PROTOCOL: 'file:http', no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' })
  const sockets = new Set()
  let remote
  const helpers = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', () => {
      // Record only the real helper for this fixture's URL, then never reply.
      helpers.push(...httpHelpers())
    })
  })
  function isHttpHelper(pid) {
    try {
      return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'git-remote-http' &&
        readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(remote)
    } catch (err) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(err.code)) throw err
      return false
    }
  }
  function httpHelpers() {
    if (!remote) return []
    return readdirSync('/proc').map(processIdentity).filter((identity) => identity && isHttpHelper(identity.pid))
  }
  t.after(async () => {
    try {
      for (const identity of [...helpers, ...httpHelpers()]) killIfSame(identity, 'SIGKILL')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  remote = `http://127.0.0.1:${server.address().port}/stalled.git`
  const judge = spawn('bash', [forkScript, '--repo', fork, '--upstream-url', remote], { env, detached: true })
  t.after(() => killOwnedGroup(judge, 'SIGTERM'))
  let stdout = '', stderr = ''
  judge.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  judge.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const closed = once(judge, 'close')
  const [status, signal] = await once(judge, 'exit')
  assert.ok(helpers.length, 'the HTTP remote helper never requested data')
  const until = performance.now() + 250
  while (helpers.some(live) && performance.now() < until) await sleep(10)
  assert.ok(!helpers.some(live), 'git-remote-http survived the fetch timeout')
  await closed
  failure({ status, signal, stdout, stderr }, /could not fetch upstream branch/)
})

// Publish field 22 from the sleeper itself, before the judge can exit and its PID be reused.
const recordedSleeper = `stat=$(<"/proc/$$/stat")
set -- "$1" \${stat##*) }
printf "%s %s\\n" "$$" "\${21}" > "$1"
exec sleep 120`

function recordedIdentity(file) {
  if (!existsSync(file)) return
  const [pid, startTime] = readFileSync(file, 'utf8').trim().split(' ')
  if (Number.isSafeInteger(Number(pid)) && Number(pid) > 1 && /^\d+$/.test(startTime)) {
    return { pid: Number(pid), startTime }
  }
}

for (const [prefix, name] of [
  ['', 'kills a background child that clears its environment'],
  ['setsid ', 'kills a separate-session child that clears its environment'],
]) {
  // A new session escapes the process group; env -i also removes the /proc marker.
  const skip = prefix ? 'a new session with no marker cannot be tracked by this judge' : false
  test(`claim metric ${name}`, { skip }, async (t) => {
    const { root, fork } = fixture(t)
    const pidFile = join(root, 'cleared-env-pid')
    const env = claimEnv()
    shim(root, env, 'pnpm', `env -i ${prefix}/bin/bash -c '${recordedSleeper}' child ${JSON.stringify(pidFile)} &
while [[ ! -s ${JSON.stringify(pidFile)} ]]; do sleep .01; done
exit 9`)
    let identity
    t.after(() => killIfSame(identity, 'SIGKILL'))
    let result
    try {
      result = run(process.execPath, [claimScript, '--repo', fork, '--timeout', '3'], env)
    } finally {
      identity = recordedIdentity(pidFile)
    }
    assert.ok(identity, 'the env -i child did not start')
    failure(result, /install failed \(exit 9\)/)
    const until = performance.now() + 250
    while (live(identity) && performance.now() < until) await sleep(10)
    assert.ok(!live(identity), 'the env -i child survived its command')
  })
}

test('claim metric kills a detached pnpm descendant on timeout', (t) => {
  const { root, fork } = fixture(t)
  const pidFile = join(root, 'detached-pid')
  const env = claimEnv()
  shim(root, env, 'pnpm', `setsid /bin/bash -c '${recordedSleeper}' child ${JSON.stringify(pidFile)} &
wait`)
  let identity
  t.after(() => killIfSame(identity, 'SIGKILL'))
  let result
  try {
    result = run(process.execPath, [claimScript, '--repo', fork, '--timeout', '2'], env)
  } finally {
    identity = recordedIdentity(pidFile)
  }
  assert.ok(identity, 'the detached descendant did not start')
  failure(result, /timed out|overall timeout/)
  assert.ok(!live(identity), 'a detached descendant is still live')
})

const worktree = fileURLToPath(new URL('../../..', import.meta.url))
const builtDist = join(worktree, 'packages/board/dist')
const realBoard = {
  skip: !existsSync(join(builtDist, 'cli.mjs')) && 'build packages/board/dist/cli.mjs to run this real-board test',
}

function offlineBoard(t) {
  const env = claimEnv()
  // Use the real built CLI without downloading or building dependencies in a fixture.
  shim(temp(t), env, 'pnpm', `if [[ $1 == install ]]; then exit 0; fi
[[ $* == '--filter @vercel/board build' ]]
ln -s ${JSON.stringify(builtDist)} packages/board/dist`)
  return env
}

test('claim metric completes a real-board handoff and reads persisted history', realBoard, (t) => {
  const result = run(process.execPath, [claimScript, '--repo', worktree], offlineBoard(t))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.metric, 'time_to_first_claim')
  assert.ok(doc.value > 0)
  assert.equal(doc.value, doc.seconds)
  assert.ok(doc.commands >= 12)
  assert.deepEqual(Object.keys(doc.phases), ['clone', 'install', 'build', 'serve_ready', 'create', 'claim', 'complete'])
  assert.ok(Object.values(doc.phases).every((seconds) => seconds > 0 && seconds < doc.value))
})

test('claim metric rejects a persisted completion with the wrong author', realBoard, (t) => {
  const { root, fork } = fixture(t)
  const env = claimEnv()
  const wrapper = join(root, 'cli.mjs')
  const cli = JSON.stringify(join(builtDist, 'cli.mjs'))
  // Keep the real board and CLI; change only the completion author reported by wait.
  writeFileSync(wrapper, `import { spawnSync } from 'node:child_process'
if (process.argv[2] !== 'wait') {
  await import(${cli})
} else {
  const result = spawnSync(process.execPath, [${cli}, ...process.argv.slice(2)], { encoding: 'utf8' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  const doc = JSON.parse(result.stdout)
  if (doc.event?.type === 'task.completed') doc.event.payload.by.profile = 'other-worker'
  process.stdout.write(JSON.stringify(doc))
}
`)
  shim(root, env, 'pnpm', `if [[ $1 == install ]]; then exit 0; fi
[[ $* == '--filter @vercel/board build' ]]
mkdir -p packages/board/dist
ln -s ${JSON.stringify(wrapper)} packages/board/dist/cli.mjs`)
  failure(run(process.execPath, [claimScript, '--repo', fork], env),
    /persisted completion by the second identity was not confirmed/)
})

function servingChild(judge) {
  try {
    for (const pid of readFileSync(`/proc/${judge}/task/${judge}/children`, 'utf8').trim().split(/\s+/)) {
      const identity = processIdentity(pid)
      if (!identity) continue
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      if (args[2] === 'serve' && args[3] === '--port') return { ...identity, port: Number(args[4]) }
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ESRCH') throw err
  }
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (open) => { socket.destroy(); resolve(open) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(100, () => finish(false))
  })
}

test('claim metric times out after a real board starts and kills the stopped server', { ...realBoard, timeout: 10_000 }, async (t) => {
  const start = performance.now()
  const judge = spawn(process.execPath, [claimScript, '--repo', worktree, '--timeout', '5'], {
    env: offlineBoard(t), detached: true,
  })
  const closed = once(judge, 'close')
  let stdout = '', stderr = '', stopped
  judge.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  judge.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  t.after(() => {
    try {
      killIfSame(stopped, 'SIGKILL')
    } finally {
      killOwnedGroup(judge, 'SIGTERM')
    }
  })
  const until = performance.now() + 4500
  while (judge.exitCode === null && performance.now() < until) {
    const board = servingChild(judge.pid)
    if (board && await listening(board.port) && killIfSame(board, 'SIGSTOP')) {
      stopped = board
      break
    }
    await sleep(10)
  }
  assert.ok(stopped, 'the real board never reached its listening port')
  const [status, signal] = await closed
  failure({ status, signal, stdout, stderr }, /timed out|overall timeout/)
  assert.ok(performance.now() - start < 7500, 'the judge outlasted the five-second deadline')
  assert.ok(!live(stopped), 'the stopped server is still live')
})
