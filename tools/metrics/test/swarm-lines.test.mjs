import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../swarm-lines.sh', import.meta.url))

test('swarm lines excludes uncommitted and non-TypeScript lines, tracks commit changes, and rejects a bad ref', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'swarm-lines-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, {
    HOME: repo, XDG_CONFIG_HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Metrics test', GIT_AUTHOR_EMAIL: 'metrics@example.test',
    GIT_COMMITTER_NAME: 'Metrics test', GIT_COMMITTER_EMAIL: 'metrics@example.test',
  })
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 10_000 })
    assert.ifError(result.error)
    return result
  }
  function git(...args) {
    const result = run('git', args)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  function put(path, text) {
    const file = join(repo, 'packages/swarm', path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  function commit(message) {
    git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  function metric(...args) {
    return run('bash', [script, '--repo', repo, ...args])
  }
  function counts(result, head, src, tests) {
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /^\{[^\r\n]+\}\n$/)
    assert.deepEqual(JSON.parse(result.stdout), {
      metric: 'swarm_lines', value: src,
      unit: 'lines of TypeScript in packages/swarm/src (tests counted separately)',
      lines_src: src, lines_test: tests, head,
    })
  }

  git('init', '-q')
  put('src/one.ts', 'first\nsecond\nunterminated')
  put('src/nested/two\twords.ts', 'nested\n')
  put('src/data.json', '{}\n')
  put('test/one.test.ts', 'test\n')
  put('parity/ignored.ts', 'parity\n')
  git('add', 'packages')
  const first = commit('first swarm files')
  put('src/untracked.ts', 'untracked\n')
  put('src/one.ts', 'first\nsecond\nthird\n')
  counts(metric(), first, 3, 1)

  git('add', 'packages/swarm/src/one.ts')
  const second = commit('extend swarm source')
  counts(metric(), second, 4, 1)
  counts(metric('--head', first), first, 3, 1)

  const bad = metric('--head', 'does-not-exist')
  assert.equal(bad.status, 1)
  assert.equal(bad.stdout, '')
  assert.match(bad.stderr, /^error: [^\r\n]+\n$/)
})

test('swarm lines leaks Git traces or fails repo lookup with CDPATH', () => {
  function metric(env, ...args) {
    const result = spawnSync('bash', ['tools/metrics/swarm-lines.sh', ...args], {
      cwd: new URL('../../../', import.meta.url),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.ifError(result.error)
    return result
  }

  const bad = metric({ GIT_TRACE: '3' }, '--head', 'nope')
  assert.equal(bad.status, 1)
  assert.equal(bad.stderr, 'error: could not resolve head\n')

  const good = metric({ CDPATH: '.' })
  assert.equal(good.status, 0, good.stderr)
  assert.equal(good.stderr, '')
  assert.equal(JSON.parse(good.stdout).metric, 'swarm_lines')
})
