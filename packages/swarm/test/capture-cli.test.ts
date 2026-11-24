import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function capture(action: 'run' | 'collect', ...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'capture', action, ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10_000,
  })
  if (result.error) throw result.error
  return result
}

const required = (ledger: string) => [
  '--name', 'sprite-cli', '--ledger', ledger, '--party', 'default', '--session', 'sess-1', '--trace', 'tr-1',
]

test('capture collect does not print missing counts as zero, leak transcripts, mix JSON output, or accept misuse', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-capture-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const name = 'sprite-cli'
  const ledger = join(dir, 'ledger')
  const timestamp = '2025-01-01T00:00:00Z'
  const log = [
    { type: 'session', timestamp },
    { type: 'message_end', message: { role: 'user', content: 'private fixture prompt', timestamp } },
    { type: 'message_end', message: {
      role: 'assistant', provider: 'cursor', model: 'fallback', stopReason: 'stop', timestamp,
      content: [{ type: 'text', text: 'private fixture answer' }],
    } },
  ]
  await writeFile(join(dir, `${name}.jsonl`), log.map(e => JSON.stringify(e)).join('\n') + '\n')
  await writeFile(join(dir, `${name}.rc`), '0\n')
  const flags = [...required(ledger), '--dir', dir, '--execution', 'exec-cli']
  function collect(...args: string[]) {
    const result = capture('collect', ...args)
    assert.doesNotMatch(result.stdout + result.stderr, /private fixture/)
    return result
  }
  const plain = collect(...flags)
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout, `${name}  cursor/fallback  in unknown out unknown cache unknown  completed  normal\n`)
  const spend = join(ledger, 'spend.jsonl')
  const first = await readFile(spend, 'utf8')
  const json = collect(...flags, '--json')
  assert.equal(json.status, 0, json.stderr)
  assert.equal(json.stderr, '')
  const result = JSON.parse(json.stdout)
  assert.deepEqual(Object.keys(result), ['attempts'])
  assert.equal(result.attempts.length, 1)
  const [attempt] = result.attempts
  assert.deepEqual([attempt.name, attempt.rc, attempt.written], [name, 0, 0])
  assert.equal(attempt.execution_id, 'exec-cli')
  assert.equal(JSON.parse(first).envelope.trace.execution_id, 'exec-cli')
  assert.equal(attempt.records[0].tokens.output, null)
  assert.equal(await readFile(spend, 'utf8'), first)

  for (const args of [[], [...flags, '--unknown'], [...flags, '--task', 'task.md']]) {
    const bad = collect(...args)
    assert.equal(bad.status, 2)
    assert.equal(bad.stdout, '')
    assert.match(bad.stderr, /^error: [^\n]+\nusage: swarm capture /)
  }
})

test('capture run rejects --dir instead of looking outside the launcher directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-capture-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // Prevent a real launch even if the misuse check regresses.
  const ledger = join(dir, 'not-a-directory')
  await writeFile(ledger, '')
  const result = capture('run', ...required(ledger), '--dir', dir, '--task', 'task.md')
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^error: --dir is for collect only\n/)
})

test('capture collect without --execution rejects misuse instead of deriving a second ID', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-capture-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = join(dir, 'ledger')
  const flags = [...required(ledger), '--dir', dir]
  await writeFile(join(dir, 'sprite-cli.rc'), '0\n')
  await writeFile(join(dir, 'sprite-cli.jsonl'), '{"type":"session","timestamp":"2025-01-01T00:00:00Z"}\n')
  const known = capture('collect', ...flags, '--execution', 'exec-known')
  assert.equal(known.status, 0, known.stderr)
  const spend = join(ledger, 'spend.jsonl')
  const before = await readFile(spend, 'utf8')
  const omitted = capture('collect', ...flags)
  assert.equal(omitted.status, 2)
  assert.equal(omitted.stdout, '')
  assert.match(omitted.stderr, /^error: --execution is required for collect\n/)
  assert.equal(await readFile(spend, 'utf8'), before)
})

test('capture collect with a missing .rc does not send plain stderr in JSON mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-capture-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const flags = [...required(join(dir, 'ledger')), '--dir', dir, '--execution', 'exec-cli']
  const plain = capture('collect', ...flags)
  assert.equal(plain.status, 1)
  assert.equal(plain.stdout, '')
  assert.equal(plain.stderr, 'error: sprite did not finish\n')
  const json = capture('collect', ...flags, '--json')
  assert.equal(json.status, 1)
  assert.equal(json.stderr, '')
  assert.deepEqual(JSON.parse(json.stdout), { error: 'sprite did not finish', reason: 'unfinished' })
})
