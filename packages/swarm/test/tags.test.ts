import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRegistry, tagProblems } from '../src/tags.ts'

function swarm(...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

test('the checked-in registry has no malformed or duplicate entries', async () => {
  assert.deepEqual(tagProblems(await readRegistry()), [])
})

test('reading the registry silently accepts a duplicate key in an entry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-tags-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'tags.json')
  await writeFile(file, '{"tags":[{"tag":"abc","tag":"def","project":"Example"}]}')
  await assert.rejects(readRegistry(file), /unique|duplicate key/i)
})

test('the tag check does not silently accept a duplicate tag', () => {
  const problems = tagProblems({
    tags: [
      { tag: 'abc', project: 'First' },
      { tag: 'abc', project: 'Second' },
    ],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /\babc\b/)
})

test('the tag check rejects uppercase, short, long, and digit-containing tags', () => {
  for (const tag of ['ABC', 'ab', 'abcd', 'ab1']) {
    assert.equal(tagProblems({ tags: [{ tag, project: 'Example' }] }).length, 1, tag)
  }
})

test('tags check reads the default registry and a file given with --registry', async (t) => {
  const shipped = swarm('tags', 'check')
  assert.equal(shipped.status, 0, shipped.stderr)
  assert.equal(shipped.stdout, 'valid\n')

  const dir = await mkdtemp(join(tmpdir(), 'swarm-tags-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'tags.json')
  await writeFile(file, JSON.stringify({
    tags: [
      { tag: 'aaa', project: 'One' },
      { tag: 'aaa', project: 'Two' },
    ],
  }))
  const plain = swarm('tags', 'check', '--registry', file)
  assert.equal(plain.status, 1, plain.stderr)
  assert.match(plain.stdout, /aaa/)
  assert.equal(plain.stderr, '')
  const json = swarm('tags', 'check', '--registry', file, '--json')
  assert.equal(json.status, 1, json.stderr)
  const body = JSON.parse(json.stdout) as { valid: boolean; problems: string[] }
  assert.equal(body.valid, false)
  assert.match(body.problems.join('\n'), /aaa/)

  const missing = swarm('tags', 'check', '--registry', join(dir, 'missing.json'))
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /^error: cannot read /)
  const misuse = swarm('tags', 'check', '--nope')
  assert.equal(misuse.status, 2)
  assert.match(misuse.stderr, /\nusage: swarm tags check \[--registry FILE\] \[--json\]\n$/)
})
