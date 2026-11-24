import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readRegistry, tagProblems } from '../src/tags.ts'

const exampleRegistry = fileURLToPath(new URL('../registry/tags.example.json', import.meta.url))

test('the example registry has no malformed or duplicate entries', async () => {
  assert.deepEqual(tagProblems(await readRegistry(exampleRegistry)), [])
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

test('tags check does not skip the registry file given with --registry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-tags-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'tags.json')
  await writeFile(file, JSON.stringify({
    tags: [
      { tag: 'aaa', project: 'One' },
      { tag: 'aaa', project: 'Two' },
    ],
  }))
  const result = spawnSync(process.execPath, ['src/cli.ts', 'tags', 'check', '--registry', file], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /aaa/)
})
