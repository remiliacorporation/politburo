import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { createInstance, runCreateInstance } from '../../src/ops/scaffold.ts'

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'politburo-scaffold-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('createInstance writes the four starter files with the supplied name', async (t) => {
  const dir = join(await scratch(t), 'new instance')
  const name = 'acme "west"'
  await createInstance(dir, { name })
  for (const file of ['politburo.config.json', '.env.example', 'run.sh', 'README.md']) {
    assert.ok((await stat(join(dir, file))).isFile(), `${file} is a file`)
  }
  assert.equal(JSON.parse(await readFile(join(dir, 'politburo.config.json'), 'utf8')).name, name)
})

test('the scaffold contains only empty environment placeholders, not ambient credentials', async (t) => {
  const dir = await scratch(t)
  const value = 'synthetic-scaffold-test-value'
  const previous = process.env.BOARD_TOKEN
  process.env.BOARD_TOKEN = value
  t.after(() => {
    if (previous === undefined) delete process.env.BOARD_TOKEN
    else process.env.BOARD_TOKEN = previous
  })
  await createInstance(dir, { name: 'acme' })
  assert.ok(!(await readdir(dir)).includes('.env'))
  const env = await readFile(join(dir, '.env.example'), 'utf8')
  for (const line of env.trimEnd().split('\n')) assert.match(line, /^[A-Z][A-Z0-9_]*=$/)
  for (const file of await readdir(dir)) {
    assert.ok(!(await readFile(join(dir, file), 'utf8')).includes(value), `${file} does not copy the test value`)
  }
})

test('run.sh can be executed from elsewhere and runs vb serve in the instance directory', async (t) => {
  const cwd = await scratch(t)
  const dir = join(cwd, 'my instance')
  await createInstance(dir, { name: 'acme' })
  // A local stand-in reports what it was asked to serve without starting a board.
  await writeFile(join(cwd, 'vb'), '#!/bin/sh\npwd -P\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
  const { stdout } = await promisify(execFile)(join(dir, 'run.sh'), ['--port', '4101'], {
    cwd, env: { PATH: `${cwd}:/bin:/usr/bin` }, timeout: 5_000,
  })
  const [at, verb, ...args] = stdout.trimEnd().split('\n')
  assert.equal(at, await realpath(dir))
  assert.equal(verb, 'serve')
  assert.equal(args[args.indexOf('--dir') + 1], '.board')
  assert.equal(args[args.indexOf('--port') + 1], '4101')
})

test('createInstance refuses a directory containing even just an unrelated hidden file', async (t) => {
  const dir = await scratch(t)
  const existing = join(dir, '.keep')
  await writeFile(existing, 'leave me here\n')
  await assert.rejects(createInstance(dir, { name: 'acme' }), /directory is not empty/)
  assert.deepEqual(await readdir(dir), ['.keep'])
  assert.equal(await readFile(existing, 'utf8'), 'leave me here\n')
})

test('the create command returns a plain success line and creates the requested instance', async (t) => {
  const dir = await scratch(t)
  const result = await runCreateInstance([dir, '--name', 'acme'])
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.lines, [`created instance  ${dir}`])
  assert.equal(JSON.parse(await readFile(join(dir, 'politburo.config.json'), 'utf8')).name, 'acme')
})

test('the create command reports a non-empty destination as a conflict without overwriting it', async (t) => {
  const dir = await scratch(t)
  const existing = join(dir, 'politburo.config.json')
  await writeFile(existing, '{"name":"original"}\n')
  const result = await runCreateInstance([dir, '--name', 'replacement'])
  assert.equal(result.exitCode, 1)
  assert.equal(result.error.class, 'conflict')
  assert.equal(result.error.reason, 'directory_not_empty')
  assert.match(result.lines[0] ?? '', /^error: .*directory is not empty/)
  assert.deepEqual(await readdir(dir), ['politburo.config.json'])
  assert.equal(JSON.parse(await readFile(existing, 'utf8')).name, 'original')
})

test('the create command reports missing arguments as misuse without writing files', async (t) => {
  const dir = await scratch(t)
  const result = await runCreateInstance([dir])
  assert.equal(result.exitCode, 2)
  assert.equal(result.error.class, 'usage')
  assert.equal(result.error.reason, 'invalid_arguments')
  assert.match(result.lines[0] ?? '', /^error: .*--name/)
  assert.deepEqual(await readdir(dir), [])
})
