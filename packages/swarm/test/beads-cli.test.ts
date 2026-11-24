import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ScanResult } from '../src/trackers/beads/index.ts'

const fixture = 'test/fixtures/bd-1.3.4.json'
const usage = 'usage: swarm trackers beads queue --epic ID --store-name NAME (--dir DIR | --fixture FILE) [--bd PATH] [--json]'
const command = ['trackers', 'beads', 'queue']

function run(args: readonly string[], env?: NodeJS.ProcessEnv, nodeArgs: readonly string[] = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, 'src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env }, timeout: 30_000,
  })
  if (result.error) throw result.error
  return result
}

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-beads-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function ids(stdout: string) {
  return (JSON.parse(stdout) as { id: string }[]).map(({ id }) => id).sort()
}

function runnableIds({ items }: ScanResult) {
  return items.filter(({ runnable }) => runnable.runnable).map(({ id }) => id).sort()
}

test('fixture queue cannot misreport readiness or hide disagreements in text or JSON', () => {
  const queue = (epic: string, ...flags: string[]) => {
    const result = run([...command, '--epic', epic, '--store-name', 'rw', '--fixture', fixture, ...flags])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    return result.stdout
  }
  const text = queue('rw-cn1')
  assert.match(text, /^runnable  7 of 13$/m)
  assert.match(text, /^disagreements  1\nrw-cn1\.12 +bd withholds$/m)
  assert.match(queue('rw-xae'), /^disagreements  2$/m)

  const recorded = JSON.parse(readFileSync(new URL('./fixtures/bd-1.3.4.json', import.meta.url), 'utf8')) as {
    calls: { argv: string[]; stdout: string }[]
  }
  const ready = recorded.calls.find(({ argv }) => argv[0] === 'ready' && argv.at(-1) === 'rw-cn1')
  assert.ok(ready, 'missing recorded ready set')
  const { queue: scan } = JSON.parse(queue('rw-cn1', '--json')) as { queue: ScanResult }
  assert.deepEqual(runnableIds(scan), ids(ready.stdout))
  assert.deepEqual(scan.disagreements.map(({ id }) => id), ['rw-cn1.12'])
})

test('invalid queue invocations cannot succeed or report a runtime failure instead of misuse', (t) => {
  const base = [...command, '--epic', 'rw-cn1', '--store-name', 'rw']
  for (const args of [
    [...base, '--dir', tempDir(t), '--fixture', fixture], base,
    ...['rw cn1', '-rw-cn1'].map((epic) => [...command, `--epic=${epic}`, '--store-name', 'rw', '--fixture', fixture]),
    [...command, '--epic', 'rw-cn1', '--fixture', fixture],
    ['trackers', 'unknown', ...base.slice(2), '--fixture', fixture],
    [...base, '--fixture', fixture, '--unknown'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^error: [^\n]+\n/)
    assert.equal(result.stderr.split('\n')[1], usage)
  }
})

test('an unrecorded epic cannot look like an empty fixture queue', () => {
  const epic = 'sk-livetestkey'
  const result = run([...command, '--epic', epic, '--store-name', 'rw', '--fixture', fixture])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'error: unrecorded call\n')
  assert.equal(result.stderr.includes(epic), false)
})

test('--dir with a symlink followed by .. cannot scan the symlink’s parent store', (t) => {
  const dir = realpathSync(tempDir(t))
  const remote = join(dir, 'remote')
  const child = join(remote, 'child')
  mkdirSync(child, { recursive: true })
  mkdirSync(join(remote, '.beads'))
  mkdirSync(join(dir, '.beads'))
  symlinkSync(child, join(dir, 'link'))
  const bin = join(dir, 'bd')
  writeFileSync(bin, `#!/bin/sh
pwd -P >> "\${0%/*}/cwd"
printf '[]\\n'
`, { mode: 0o700 })
  const result = run([...command, '--epic', 'rw-cn1', '--store-name', 'rw', '--dir', `${dir}/link/..`, '--bd', bin])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(new Set(readFileSync(join(dir, 'cwd'), 'utf8').trimEnd().split('\n')), new Set([remote]))
})

test('an unopenable store directory cannot expose its path or report a missing .beads', (t) => {
  const dir = join(tempDir(t), 'private@example.test')
  const result = run([...command, '--epic', 'rw-cn1', '--store-name', 'rw', '--dir', dir])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'error: cannot open the store directory\n')
})

test('invalid store names cannot be copied to the queue or diagnostics', () => {
  for (const name of ['private@example.test', `token_${'abc123'.repeat(10)}`,
    'AKIAIOSFODNN7EXAMPLE', 'sk-live-abcdefghijklmnopqrst']) {
    const result = run([...command, '--epic', 'rw-cn1', '--store-name', name, '--fixture', fixture])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `error: invalid store name\n${usage}\n`)
  }
})

test('a queue subprocess cannot inherit a caller token', (t) => {
  const dir = tempDir(t)
  const flag = join(dir, 'flag')
  const preload = join(dir, 'preload.cjs')
  writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(flag)}, process.env.GITHUB_TOKEN ? 'set' : 'unset')\n`)
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'synthetic-not-a-secret'
  try {
    const result = run([...command, '--help'], undefined, ['--require', preload])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(flag, 'utf8'), 'unset')
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
})

test('fixture and argument errors cannot echo email addresses in caller input', (t) => {
  const email = 'private@example.test'
  const base = [...command, '--epic', 'rw-cn1', '--store-name', 'rw']
  for (const [args, status, headline] of [
    [[...base, '--fixture', join(tempDir(t), email)], 1, 'cannot read the fixture file'],
    [['trackers', email], 2, 'unknown tracker'],
    [['trackers', 'beads', email], 2, 'unknown beads command'],
    [[...base, '--fixture', fixture, `--${email}`], 2, 'invalid arguments'],
  ] as const) {
    const result = run(args)
    assert.equal(result.status, status)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, /@/)
    assert.equal(result.stderr, `error: ${headline}\n${status === 2 ? `${usage}\n` : ''}`)
  }
})

function storeHashes(dir: string) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.lock'))
    .map(({ parentPath, name }) => {
      const path = join(parentPath, name)
      return `${path}: ${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    }).sort()
}

test('a live queue cannot write to the store, diverge from bd ready or lose reasons', (t) => {
  const dir = tempDir(t)
  const home = join(dir, 'home')
  mkdirSync(home)
  const configured = process.env.BD_BIN ?? 'bd'
  const bin = configured.includes('/') ? resolve(configured) : configured
  const env = { PATH: process.env.PATH, HOME: home, BD_NON_INTERACTIVE: '1', NO_COLOR: '1' }
  const options = { cwd: dir, env, encoding: 'utf8', timeout: 30_000 } as const
  const version = spawnSync(bin, ['--version'], options)
  if (version.error || version.status !== 0) {
    t.skip(`bd --version unavailable: ${version.error?.message ?? (version.stderr.trim() || version.signal || `exit ${version.status}`)}`)
    return
  }
  const git = spawnSync('git', ['init', '-q'], options)
  assert.equal(git.status, 0, git.error?.message ?? git.stderr)
  function bd(...args: string[]) {
    const result = spawnSync(bin, args, options)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.error?.message ?? result.stderr}`)
    return result.stdout.trim()
  }
  bd('init', '--non-interactive', '--prefix', 'rw', '-q')
  const epic = bd('create', 'epic', '-t', 'epic', '--silent')
  const child = (title: string, ...args: string[]) => bd('create', title, '--parent', epic, '--silent', ...args)
  const ready = child('ready')
  const blocked = child('blocked', '--deps', `blocked-by:${ready}`)
  child('in progress', '-s', 'in_progress', '-a', 'worker')
  const closed = child('closed')
  bd('close', closed)

  const store = join(dir, '.beads')
  const before = storeHashes(store)
  assert.ok(before.length > 0, 'no store files to compare')
  const result = run([...command, '--epic', epic, '--store-name', 'rw', '--dir', dir, '--bd', bin, '--json'], env)
  assert.deepEqual(storeHashes(store), before, 'queue changed .beads files')
  assert.equal(result.status, 0, result.stderr)
  const { queue } = JSON.parse(result.stdout) as { queue: ScanResult }
  assert.ok(runnableIds(queue).includes(ready), 'seeded ready child is missing')
  assert.deepEqual(runnableIds(queue), ids(bd('ready', '--json', '-n', '0', '--parent', epic)))
  for (const [id, reason] of [[blocked, 'blocked_by'], [closed, 'closed']]) {
    const item = queue.items.find((item) => item.id === id)
    assert.ok(item, `missing ${id}`)
    assert.equal(item.runnable.runnable, false, `${id} is runnable`)
    assert.ok(item.runnable.reasons.some(({ kind }) => kind === reason), `${id} lacks ${reason}`)
  }
})
