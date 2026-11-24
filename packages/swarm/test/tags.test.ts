import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRegistry, tagProblems } from '../src/tags.ts'

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
