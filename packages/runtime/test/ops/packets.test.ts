import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { appendAttempt, readAttempts, readResumePacket, writeResumePacket, type Attempt } from '../../src/ops/packets.ts'

async function fixtureDir(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'politburo-packets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'state')
}

const packet = {
  task: 'msg_fixture_1',
  summary: 'Added a draft.\nThe tests are still pending.',
  nextSteps: ['Check the draft', 'Run the tests'],
  files: ['src/draft.ts', 'test/draft.test.ts'],
}

const attempt: Attempt = {
  task: packet.task,
  at: '2026-10-01T10:03:00Z',
  outcome: 'retry',
  note: 'Draft created.\nTry the fixture again.',
}

test('resume packet round-trips as deterministic Markdown at the task path', async (t) => {
  const dir = await fixtureDir(t)
  const path = join(dir, 'resume', 'msg_fixture_1.md')
  assert.equal(await readResumePacket(dir, packet.task), undefined)

  await writeResumePacket(dir, packet)
  const markdown = `# Resume: msg_fixture_1

## Summary

Added a draft.
The tests are still pending.

## Next steps

- Check the draft
- Run the tests

## Files

- src/draft.ts
- test/draft.test.ts
`
  assert.equal(await readFile(path, 'utf8'), markdown)
  assert.equal(await readResumePacket(dir, packet.task), markdown)

  await writeResumePacket(dir, { ...packet, summary: 'A newer draft.', nextSteps: 'Run the focused test.' })
  const updated = await readResumePacket(dir, packet.task)
  assert.ok(updated)
  assert.ok(updated.includes('A newer draft.\n'))
  assert.ok(updated.includes('Run the focused test.\n'))
  assert.ok(!updated.includes(packet.summary))

  await writeResumePacket(dir, packet)
  assert.equal(await readFile(path, 'utf8'), markdown)
})

test('attempt log retains append order, including when filtered by task', async (t) => {
  const dir = await fixtureDir(t)
  assert.deepEqual(await readAttempts(dir), [])
  const attempts = [
    attempt,
    { ...attempt, task: 'msg_fixture_2', at: '2026-10-01T10:02:00Z' },
    { ...attempt, at: '2026-10-01T10:01:00Z', outcome: 'done', note: 'Fixture passed.' },
  ]
  for (const entry of attempts) await appendAttempt(dir, entry)

  const lines = (await readFile(join(dir, 'attempts.jsonl'), 'utf8')).split('\n')
  assert.equal(lines.pop(), '')
  assert.deepEqual(lines.map((line) => JSON.parse(line)), attempts)
  assert.deepEqual(await readAttempts(dir), attempts)
  assert.deepEqual(await readAttempts(dir, attempt.task), [attempts[0], attempts[2]])
  assert.deepEqual(await readAttempts(dir, 'missing'), [])
})

test('every packet and ledger entry point rejects traversal task IDs', async (t) => {
  const dir = await fixtureDir(t)
  for (const task of ['../outside', '..\\outside', 'nested/../fixture', join(dir, 'absolute'), '..', '']) {
    await assert.rejects(writeResumePacket(dir, { ...packet, task }), /invalid task id/)
    await assert.rejects(readResumePacket(dir, task), /invalid task id/)
    await assert.rejects(appendAttempt(dir, { ...attempt, task }), /invalid task id/)
    await assert.rejects(readAttempts(dir, task), /invalid task id/)
  }
  assert.deepEqual(await readAttempts(dir), [])
  await assert.rejects(readFile(join(dir, 'outside.md')), { code: 'ENOENT' })
})

test('concurrent appends preserve every complete JSON line', async (t) => {
  const dir = await fixtureDir(t)
  const attempts = Array.from({ length: 12 }, (_, i) => ({
    ...attempt,
    task: `msg_fixture_${i}`,
    // Include records large enough to catch interleaving if an append is split into writes.
    note: `${i}: résumé\n`.repeat(75_000),
  }))
  await Promise.all(attempts.map((entry) => appendAttempt(dir, entry)))

  const entries = await readAttempts(dir)
  const byTask = new Map(entries.map((entry) => [entry.task, entry]))
  assert.equal(entries.length, attempts.length)
  assert.equal(byTask.size, attempts.length)
  for (const expected of attempts) {
    const entry = byTask.get(expected.task)
    assert.ok(entry, `missing attempt for ${expected.task}`)
    assert.equal(entry.at, expected.at)
    assert.equal(entry.outcome, expected.outcome)
    assert.ok(entry.note === expected.note, `incomplete note for ${expected.task}`)
  }
})
