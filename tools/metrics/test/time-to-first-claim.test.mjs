import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../time-to-first-claim.mjs', import.meta.url))

function judge(args, timeoutSeconds = '300', temp, extraEnv = {}) {
  const run = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: Number(timeoutSeconds) * 1000 + 5000,
    env: { ...judgeEnv(timeoutSeconds, temp), ...extraEnv },
  })
  assert.ifError(run.error)
  assert.equal(run.signal, null)
  return run
}

function judgeEnv(timeoutSeconds, temp) {
  return {
    PATH: process.env.PATH, TTFC_TIMEOUT_SECONDS: timeoutSeconds,
    ...(temp ? { TMPDIR: temp } : { TTFC_PNPM_STORE_DIR: process.env.TTFC_PNPM_STORE_DIR }),
  }
}

function fixture(t, build, files = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'time-to-first-claim-test-'))
  t.after(() => rmSync(temp, { force: true, recursive: true }))
  const checkout = join(temp, 'checkout space')
  mkdirSync(join(checkout, 'packages/board'), { recursive: true })
  for (const [file, data] of Object.entries({
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { build: 'node build.mjs' } }),
    'packages/board/package.json': '{"name":"fixture-board","version":"1.0.0"}',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  packages/board: {}\n",
    '.npmrc': 'offline=true\n',
    'build.mjs': build,
    ...files,
  })) {
    writeFileSync(join(checkout, file), data)
  }
  const git = (args, input) => {
    const result = spawnSync('git', ['--no-optional-locks', '-C', checkout, ...args], {
      encoding: 'utf8', input, timeout: 3000,
      env: { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0)
    return result.stdout
  }
  git(['init', '-q', '--template='])
  git(['add', '.'])
  const tree = git(['write-tree']).trim()
  const head = git(['hash-object', '-w', '-t', 'commit', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture\n`).trim()
  writeFileSync(join(checkout, '.git/HEAD'), `${head}\n`)
  return { temp, checkout, head, status: () => git(['status', '--porcelain=v1']) }
}

function snapshot(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name)
    return [relative(root, path), lstatSync(path).mode, entry.isFile() ? readFileSync(path) : null]
  }).sort(([a], [b]) => a.localeCompare(b))
}

const processGroupOnly = process.platform !== 'linux'
const containmentDiagnostic = 'time-to-first-claim: containment is process-group only on this platform\n'
const errors = (run) => processGroupOnly ? run.stderr.replace(containmentDiagnostic, '') : run.stderr

function assertClean(temp) {
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('time-to-first-claim-')), [])
}

test('a broken checkout exits nonzero with no metric and a one-line reason', () => {
  const run = judge([dirname(script)], '2')
  assert.notEqual(run.status, 0)
  assert.equal(run.stdout, '')
  assert.match(errors(run), /^time-to-first-claim: checkout is not a board workspace\n$/)
})

test('the measurement deadline exits nonzero with no metric', () => {
  const run = judge([], '0.001')
  assert.notEqual(run.status, 0)
  assert.equal(run.stdout, '')
  assert.match(errors(run), /^time-to-first-claim: measurement timed out\n$/)
})

test('install gets the proxy setting without exposing it in judge output', (t) => {
  const { temp, checkout } = fixture(t, 'process.exit(92)\n')
  const bin = join(temp, 'bin')
  mkdirSync(bin)
  const proxy = 'http://proxy-fixture.invalid:1234'
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}
if (process.argv[2] !== 'install') process.exit(90)
if (process.env.HTTPS_PROXY !== ${JSON.stringify(proxy)}) process.exit(91)
if (process.env.TTFC_UNRELATED !== undefined) process.exit(92)
console.log(process.env.HTTPS_PROXY)
console.error(process.env.HTTPS_PROXY)
process.exitCode = 42
`, { mode: 0o755 })
  const run = judge([checkout], '10', temp, {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HTTPS_PROXY: proxy,
    TTFC_UNRELATED: 'not forwarded',
  })
  assert.equal(run.status, 1)
  assert.ok(!run.stdout.includes(proxy), 'proxy value leaked to stdout')
  assert.ok(!run.stderr.includes(proxy), 'proxy value leaked to stderr')
  assert.equal(run.stdout, '')
  assert.equal(errors(run), 'time-to-first-claim: pnpm install failed (42)\n')
  assertClean(temp)
})

test('a cold install and build do not modify a dirty input checkout (Repro C)', (t) => {
  const { temp, checkout, status } = fixture(t, "import {writeFileSync} from 'node:fs'; writeFileSync('build-marker','fixture');\n")
  // The benchmark must not execute this dirty worktree version, or use the warm artifacts.
  writeFileSync(join(checkout, 'build.mjs'), 'process.exit(91)\n')
  mkdirSync(join(checkout, 'node_modules'))
  writeFileSync(join(checkout, 'node_modules/.modules.yaml'), '')
  mkdirSync(join(checkout, 'packages/board/dist'))
  writeFileSync(join(checkout, 'packages/board/dist/cli.mjs'), 'process.exit(92)\n')
  const beforeStatus = status()
  const beforeBytes = snapshot(checkout)
  assert.match(beforeStatus, / M build\.mjs/)
  const run = judge([checkout], '10', temp)
  assert.equal(run.status, 1)
  assert.equal(run.stdout, '')
  assert.match(errors(run), /pnpm build did not produce the clone board CLI/)
  assert.equal(status(), beforeStatus)
  assert.deepEqual(snapshot(checkout), beforeBytes)
  assertClean(temp)
})

for (const { name, wrongCwd, reason } of [
  {
    name: 'a TCP listener and forged CLI success do not earn a score',
    wrongCwd: false,
    reason: /independent verification could not confirm the completed task/,
  },
  {
    name: 'a listener whose PID leaves the clone is rejected',
    wrongCwd: true,
    reason: /vb serve PID does not own the clone board listener/,
  },
]) test(`${name} (Repro B)`, { skip: processGroupOnly }, (t) => {
  const { temp, checkout } = fixture(t, `
    import { copyFileSync, mkdirSync } from 'node:fs';
    mkdirSync('packages/board/dist');
    copyFileSync('fake-cli.mjs', 'packages/board/dist/cli.mjs');
  `, { 'fake-cli.mjs': `
    import { createServer } from 'node:net';
    const args = process.argv.slice(2);
    if (args[0] === 'serve') {
      if (args[args.indexOf('--port') + 1] !== '0') process.exit(20);
      ${wrongCwd ? 'process.chdir(process.env.TMPDIR);' : ''}
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        console.log('serving a local board at http://127.0.0.1:' + server.address().port + '/api/board as fixture');
      });
    } else if (args.includes('create')) {
      console.log(JSON.stringify({task:{id:1,by:{profile:'creator',principal:'fixture'}}}));
    } else if (args.includes('claim')) {
      console.log(JSON.stringify({task:{id:1,task:{claim:{actor:'fixture+worker'}}}}));
    } else if (args.includes('read')) {
      console.log(JSON.stringify({message:{id:1,task:{state:'completed',result:'Local handoff verified'}}}));
    }
  ` })
  const run = judge([checkout], '10', temp)
  assert.equal(run.status, 1)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, reason)
  assertClean(temp)
})

for (const ending of ['deadline', 'SIGINT', 'SIGTERM', 'build failure']) {
  test(`a detached build helper is stopped on ${ending} (Repro C)`, { skip: processGroupOnly, timeout: 14000 }, async (t) => {
    const { temp, checkout } = fixture(t, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const helper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      helper.unref();
      writeFileSync(join(process.env.TMPDIR, '..', '..', 'helper.pid'), String(helper.pid));
      ${ending === 'build failure' ? 'process.exitCode = 42;' : 'setInterval(() => {}, 100);'}
    `)
    const pidFile = join(temp, 'helper.pid')
    const timeout = ending === 'deadline' ? '3' : '8'
    const child = spawn(process.execPath, [script, checkout], { env: judgeEnv(timeout, temp) })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const closed = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', (status, signal) => done({ status, signal }))
    })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), Number(timeout) * 1000 + 4000)
    let pid
    function helperAlive() {
      if (!pid) return false
      try {
        return !/^\S+ \([^)]*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return false
      }
    }
    try {
      const limit = performance.now() + Number(timeout) * 1000 + 500
      while (!existsSync(pidFile) && performance.now() < limit) await delay(20)
      assert.ok(existsSync(pidFile), 'build started its detached helper')
      pid = Number(readFileSync(pidFile, 'utf8'))
      assert.ok(Number.isSafeInteger(pid) && pid > 1)
      if (ending.startsWith('SIG')) {
        assert.ok(helperAlive(), 'helper was live before signalling the judge')
        assert.ok(child.kill(ending))
      }
      assert.deepEqual(await closed, { status: 1, signal: null })
      assert.equal(stdout, '')
      const reason = ending === 'deadline' ? 'measurement timed out' :
        ending === 'build failure' ? 'pnpm build failed' : `interrupted by ${ending}`
      assert.ok(stderr.includes(reason), stderr)
      assert.equal(helperAlive(), false, 'detached helper survived the judge')
      assertClean(temp)
    } finally {
      clearTimeout(watchdog)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      if (helperAlive()) process.kill(pid, 'SIGKILL')
    }
  })
}

test('a real local handoff prints one metric after verifying completion', {
  skip: process.env.TTFC_TEST_FULL !== '1',
}, () => {
  const run = judge([])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stderr, processGroupOnly ? containmentDiagnostic : '')
  assert.match(run.stdout, /^\{[^\r\n]*\}\n$/)
  const record = JSON.parse(run.stdout)
  assert.equal(record.metric, 'time-to-first-claim')
  // Clone, install, build, two HEAD checks, five vb calls, plus non-Linux lsof checks.
  assert.equal(record.commands, processGroupOnly ? 12 : 10)
  assert.equal(record.board_commands, 5) // serve, create, claim, complete, read
  assert.equal(record.task_final_state, 'done')
  assert.match(record.head, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  assert.equal(record.node, process.version)
  assert.equal(record.verified_by, 'http')
  assert.equal(typeof record.dirty, 'boolean')
  assert.ok(!('built_by_script' in record))
  const phases = ['clone_seconds', 'install_seconds', 'build_seconds', 'board_seconds']
  for (const field of ['seconds', ...phases]) {
    assert.ok(Number.isFinite(record[field]) && record[field] >= 0, field)
  }
  assert.ok(record.seconds + 0.03 >= phases.reduce((sum, field) => sum + record[field], 0))
})
