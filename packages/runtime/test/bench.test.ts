import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { block, board, BoardError } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { benchStore, formatReport, isBenchRun, registerBenchSchema, report, type BenchRun } from '../src/index.ts'
import { benchCli } from '../src/bench/cli.ts'

const time = '2026-01-01T00:00:00.000Z'
const run = (runId: string, options: Partial<BenchRun> = {}): BenchRun => ({
  schema: 'bench-run@1', runId, level: 'sprite', parentId: null, taskId: 'fixture', repo: null,
  model: { provider: 'a', name: 'small' }, byModel: null, thinking: 'low', startedAt: time,
  endedAt: '2026-01-01T00:00:04.000Z', wallSeconds: 4, activeSeconds: 3.5, turns: 1, toolCalls: 2,
  tokens: { in: 8, out: 2, reasoning: null, cached: null }, costMicros: null,
  outcome: { state: 'done', reason: null }, changes: { files: 1, linesAdded: 1, linesRemoved: 1 }, reviewRounds: null,
  check: { result: 'pass', command: 'pnpm check' }, coverage: { tokens: 'partial' },
  complexity: { rating: { score: 2, size: 'S', reason: 'small scope', ratedBy: 'rater', ratedAt: time },
    proxies: { files: 1, lines: 2, reviewRounds: null, failedChecks: null, retries: null } },
  sprites: null,
  ...options,
})

async function fixture(t: TestContext, loose = false) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  const writer = team.as('bench-writer')
  const author = (await writer.me()).actor
  if (loose) await team.createSchema({ name: 'bench-run', version: 1, schema: { type: 'object' } })
  else await registerBenchSchema(team)
  return { team, writer, bench: benchStore({ board: writer, author }), author }
}

test('round trips unsynced benchmark blocks', async (t) => {
  const { bench, team } = await fixture(t)
  const first = run('a~1', { parentId: 'b' })
  const { turns, toolCalls, tokens, costMicros } = first
  const second = run('b', { level: 'task', model: null,
    byModel: [{ provider: 'a', name: 'small', turns, toolCalls, tokens, costMicros }],
    sprites: { count: 1, wallSeconds: 4, activeSeconds: 3.5 } })
  await bench.record(first)
  await bench.record(second)
  assert.deepEqual(await bench.read(), [first, second])
  assert.ok((await team.channel('bench').messages()).messages.every((message) => message.noSync))
})

test('replays leave one message per ID and the first valid write wins', async (t) => {
  const { bench, team, writer } = await fixture(t)
  const first = run('once')
  await bench.record(first)
  await bench.record(first)
  await bench.record({ ...first, turns: 5 })
  assert.equal((await team.channel('bench').messages()).messages.length, 1)
  await writer.post('bench', block('bench-run@1', { ...first, turns: 6 }))
  assert.deepEqual(await bench.read(), [first])
})

test('record validates the serialized payload before posting', async (t) => {
  const { bench, writer } = await fixture(t, true)
  const sample = run('original')
  const invalid = Object.assign(Object.create({ toJSON: () => ({ ...sample, schema: {} }) }), sample)
  await assert.rejects(bench.record(invalid), TypeError)
  assert.deepEqual((await writer.channel('bench').messages()).messages, [])
  const parsed = { ...sample, runId: 'serialized' }
  let next = parsed
  const valid = Object.assign(Object.create({ toJSON() {
    const result = next
    next = sample
    return result
  } }), sample)
  await bench.record(valid)
  assert.deepEqual((await writer.posted('bench-run:serialized')).blocks[0]?.data, parsed)
})

test('record refuses a block over 9000 characters that the board could store', async (t) => {
  const { bench, writer } = await fixture(t)
  const { turns, toolCalls, tokens, costMicros } = run('leaf')
  const large = run('large', { level: 'mob', model: null,
    byModel: Array.from({ length: 35 }, (_, i) => ({ provider: 'a', name: `small-${i}`, turns, toolCalls, tokens, costMicros })),
    sprites: { count: 35, wallSeconds: 4, activeSeconds: null } })
  const text = block('bench-run@1', large)
  assert.ok(text.length > 9000 && text.length <= 10000)
  await assert.rejects(bench.record(large), { name: 'TypeError' })
  assert.deepEqual((await writer.channel('bench').messages()).messages, [])
  await writer.post('bench', text)
})

test('record refuses a mismatched writer without occupying the post ID', async (t) => {
  const { team, bench, author, writer } = await fixture(t)
  const other = team.as('other')
  const sample = run('reserved')
  await assert.rejects(benchStore({ board: other, author }).record(sample), /writer does not match/)
  assert.deepEqual((await other.channel('bench').messages()).messages, [])
  await bench.record(sample)
  assert.equal((await writer.posted('bench-run:reserved')).by.actor, author)
})

test('record rejects successful replays and duplicate lookups that are not matching live roots', async (t) => {
  const { bench, writer } = await fixture(t)
  const root = await writer.post('bench', { id: 'bench-run:unrelated', text: 'unrelated' })
  await writer.post('bench', { id: 'bench-run:wrong-id', text: block('bench-run@1', run('different')) })
  const deleted = await writer.post('bench', { id: 'bench-run:deleted', text: block('bench-run@1', run('deleted')) })
  await writer.delete(deleted.id)
  await writer.reply(root.id, { id: 'bench-run:reply', text: block('bench-run@1', run('reply')) })
  await writer.post('elsewhere', { id: 'bench-run:wrong-channel', text: block('bench-run@1', run('wrong-channel')) })
  for (const id of ['unrelated', 'wrong-id', 'deleted', 'reply', 'wrong-channel']) {
    await t.test(id, async () => {
      await assert.rejects(bench.record(run(id)), /matching live benchmark record/)
    })
  }
})

test('reads ignore other writers, deleted messages, replies, other schemas, and malformed records', async (t) => {
  // A board may already have a looser schema. Use real writes to exercise reader-side validation.
  const { team, writer, bench } = await fixture(t, true)
  const first = run('keep')
  await bench.record(first)
  const root = await writer.posted('bench-run:keep')
  await team.as('other').post('bench', block('bench-run@1', run('other')))
  const gone = await writer.post('bench', block('bench-run@1', run('gone')))
  await writer.delete(gone.id)
  await writer.reply(root.id, block('bench-run@1', run('reply')))
  await team.createSchema({ name: 'other-run', version: 1, schema: { type: 'object' } })
  await writer.post('bench', block('other-run@1', run('other-schema')))
  await writer.post('bench', block('bench-run@1', { ...run('extra'), extra: true }))
  assert.deepEqual(await bench.read(), [first])
})

test('reads all 120 records across pages', async (t) => {
  const { bench } = await fixture(t)
  const runs = Array.from({ length: 120 }, (_, i) => run(`run-${i}`))
  for (const sample of runs) await bench.record(sample)
  assert.deepEqual(await bench.read(), runs)
})

test('reads continue when an empty page advances the cursor', async (t) => {
  const { bench, writer, author } = await fixture(t)
  const sample = run('later')
  await bench.record(sample)
  const message = await writer.posted('bench-run:later')
  // Stub only the handle's paging response to model a Vercel scan that advances past non-post events.
  const store = benchStore({ author, board: { ...writer, channel: () => ({
    async messages({ after } = {}) {
      if (after === '0') return { messages: [], cursor: '100' }
      if (after === '100') return { messages: [message], cursor: '101' }
      return { messages: [], cursor: '101' }
    },
  }) } })
  assert.deepEqual(await store.read(), [sample])
})

test('validates outcome codes, check names, and run ID lengths', () => {
  for (const reason of ['retry:IO_1.2-later', 'exit 124', 'r'.repeat(80)]) {
    assert.ok(isBenchRun(run('valid', { outcome: { state: 'blocked', reason } })))
  }
  for (const reason of ['', 'bad/code', 'bad!', '-retry', 'Please rerun the job', 'exit 1234', 'r'.repeat(81)]) {
    assert.equal(isBenchRun(run('invalid', { outcome: { state: 'blocked', reason } })), false, reason)
  }
  for (const command of ['check-build', 'pnpm check', 'pnpm test', 'vitest', 'c'.repeat(60)]) {
    assert.ok(isBenchRun(run('valid', { check: { result: 'pass', command } })))
  }
  for (const command of ['-check', 'check --flag', 'deploy dummy-token', 'one two three', 'c'.repeat(61)]) {
    assert.equal(isBenchRun(run('invalid', { check: { result: 'pass', command } })), false, command)
  }
  assert.ok(isBenchRun(run('r'.repeat(150))))
  assert.equal(isBenchRun(run('r'.repeat(151))), false)
})

test('registered schema enforces the length limits on direct board writes', async (t) => {
  const { writer } = await fixture(t)
  const samples = {
    runId: run('r'.repeat(151)),
    reason: run('reason', { outcome: { state: 'blocked', reason: 'r'.repeat(81) } }),
    command: run('command', { check: { result: 'pass', command: 'c'.repeat(61) } }),
  }
  for (const [field, sample] of Object.entries(samples)) {
    await t.test(field, async () => {
      await assert.rejects(writer.post('bench', block('bench-run@1', sample)), BoardError)
    })
  }
})

test('validation checks elapsed and active time', () => {
  assert.ok(isBenchRun(run('near', { wallSeconds: 4.001, activeSeconds: 4.001 })))
  assert.equal(isBenchRun(run('elapsed', { wallSeconds: 4.002 })), false)
  assert.equal(isBenchRun(run('active', { activeSeconds: 4.001 })), false)
})

test('validation checks token coverage while allowing partial totals and an unknown sprite model', () => {
  const none = { in: null, out: null, reasoning: null, cached: null }
  const complete = { in: 8, out: 2, reasoning: 0, cached: 0 }
  assert.ok(isBenchRun(run('early', { model: null, tokens: none, coverage: { tokens: 'none' } })))
  assert.ok(isBenchRun(run('complete', { tokens: complete, coverage: { tokens: 'complete' } })))
  assert.ok(isBenchRun(run('partial', { tokens: complete })))
  for (const key of ['in', 'out', 'reasoning', 'cached'] as const) {
    assert.equal(isBenchRun(run('none', { tokens: { ...none, [key]: 0 }, coverage: { tokens: 'none' } })), false, key)
    assert.equal(isBenchRun(run('complete', { tokens: { ...complete, [key]: null }, coverage: { tokens: 'complete' } })), false, key)
  }
})

test('strict validation rejects unknown keys and invalid counts but accepts nulls', () => {
  const sample = run('validate')
  assert.equal(isBenchRun({ ...sample, outcome: { ...sample.outcome, extra: true } }), false)
  assert.equal(isBenchRun({ ...sample, extra: true }), false)
  for (const count of [0.5, -1]) assert.equal(isBenchRun({ ...sample, tokens: { ...sample.tokens, in: count } }), false)
  assert.equal(isBenchRun({ ...sample, tokens: { in: null, out: null, reasoning: null, cached: null } }), true)
})

test('reports leaf statistics by model, thinking, and rating', () => {
  const a = run('a')
  const b = run('b', { wallSeconds: 10, check: { result: 'fail', command: null },
    tokens: { ...a.tokens, in: 38 }, changes: { files: 1, linesAdded: 2, linesRemoved: 1 } })
  const c = run('c', { wallSeconds: 2, tokens: { ...a.tokens, out: null }, check: { result: 'not_run', command: null } })
  const d = run('d', { thinking: 'high', tokens: { ...a.tokens, in: null }, check: { result: null, command: null } })
  const e = run('e', { model: { provider: 'b', name: 'large' }, changes: null })
  const f = run('f', { complexity: { ...a.complexity, rating: { ...a.complexity.rating!, score: 4 } } })
  const g = run('g', { complexity: { ...a.complexity, rating: null } })
  const rollup = run('parent', { level: 'mob', model: null, sprites: { count: 7, wallSeconds: 32, activeSeconds: null } })
  const h = run('h', { model: { provider: 'b', name: 'small' } })
  const i = run('i', { model: { provider: 'a', name: 'large' } })
  assert.deepEqual(report([b, c, a, d, e, f, g, h, i, rollup]).rows, [
    { ...row(a, 2), runs: 3, runIds: ['b', 'c', 'a'], checked: 2, passRate: 0.5, medianWallSeconds: 4,
      medianTokens: 25, p90Tokens: 40, tokensPerChangedLine: 10, runsWithTokens: 2, noTokens: 1 },
    { ...row(d, 2), checked: 0, passRate: null, medianTokens: null, p90Tokens: null, tokensPerChangedLine: null, runsWithTokens: 0, noTokens: 1 },
    { ...row(e, 2), tokensPerChangedLine: null }, row(f, 4), row(g, 'unrated'), row(h, 2), row(i, 2),
  ])
  const ten = Array.from({ length: 10 }, (_, i) => run(`rank-${i}`, { wallSeconds: i, tokens: { ...a.tokens, in: i } }))
  assert.equal(report(ten).rows[0]?.p90Tokens, 10) // Ninth of 2 through 11, not the max.
  assert.equal(report(ten).rows[0]?.medianWallSeconds, 4.5)
})

test('zero-churn runs do not contribute tokens to tokens per changed line', () => {
  const changed = run('changed')
  const unchanged = run('unchanged', { changes: { files: 0, linesAdded: 0, linesRemoved: 0 }, tokens: { ...changed.tokens, in: 998 } })
  assert.equal(report([changed, unchanged]).rows[0]?.tokensPerChangedLine, 5)
  assert.equal(report([unchanged]).rows[0]?.tokensPerChangedLine, null)
})

function row(sample: BenchRun, rating: 2 | 4 | 'unrated') {
  return { model: sample.model, thinking: sample.thinking, rating, runs: 1, runIds: [sample.runId], checked: 1,
    passRate: 1, medianWallSeconds: 4, medianTokens: 10, p90Tokens: 10, tokensPerChangedLine: 5, runsWithTokens: 1, noTokens: 0 }
}

test('text fits 80 columns and CLI JSON is one document with the same rows', async (t) => {
  const { writer, bench } = await fixture(t)
  const sample = run('one', { model: { provider: 'a', name: 'x'.repeat(190) } })
  await bench.record(sample)
  const data = report([sample])
  const text = formatReport(data)
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines.every((line) => /^[ -~]{1,80}$/.test(line)))
  assert.equal(lines[1], 'runs  one')
  assert.equal(formatReport(data, { ids: true }), text)
  for (const args of [[], ['--ids']]) {
    const printed: string[] = []
    assert.equal(await benchCli(['report', ...args], () => writer, (line) => printed.push(line), assert.fail), 0)
    assert.deepEqual(printed, [text])
  }
  const printed: string[] = []
  assert.equal(await benchCli(['report', '--json'], () => writer, (line) => printed.push(line), assert.fail), 0)
  assert.equal(printed.length, 1)
  assert.deepEqual(JSON.parse(printed[0]!), data)
})

test('CLI exits 2 for misuse and when no board is available', async () => {
  const stderr: string[] = []
  const error = (line: string) => stderr.push(line)
  assert.equal(await benchCli(['ingest'], () => assert.fail('unexpected connection'), assert.fail, error), 2)
  assert.match(stderr.pop() ?? '', /^usage:/)
  const connect = () => { throw new BoardError('no_board', 'no board', 400) }
  assert.equal(await benchCli(['report'], connect, assert.fail, error), 2)
  assert.deepEqual(stderr, ['error: could not open benchmark board'])
})

test('CLI exits 1 for malformed ingest without echoing the input', async (t) => {
  const { writer } = await fixture(t)
  const dir = await mkdtemp(join(tmpdir(), 'runtime-bench-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'input.jsonl')
  const sentinel = 'BENCH_INPUT_SENTINEL'
  await writeFile(file, `\n${sentinel}\n`)
  const stderr: string[] = []
  assert.equal(await benchCli(['ingest', file], () => writer, assert.fail, (line) => stderr.push(line)), 1)
  assert.ok(!stderr.join('\n').includes(sentinel))
  assert.deepEqual(stderr, ['error: invalid benchmark record in input 1, line 2'])
})

test('CLI exits 1 for a board failure without echoing its message', async (t) => {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const sentinel = 'BENCH_BOARD_SENTINEL'
  const team = board({ backend, middleware: [({ respond }) => respond(sentinel)] })
  await registerBenchSchema(team)
  await assert.rejects(team.post('bench', 'sample'), { message: sentinel })
  const dir = await mkdtemp(join(tmpdir(), 'runtime-bench-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'input.jsonl')
  await writeFile(file, JSON.stringify(run('refused')) + '\n')
  const stderr: string[] = []
  assert.equal(await benchCli(['ingest', file], () => team, assert.fail, (line) => stderr.push(line)), 1)
  assert.ok(!stderr.join('\n').includes(sentinel))
  assert.deepEqual(stderr, ['error: could not store benchmark record from input 1, line 1'])
})

test('sprite records have no sprite summary and roll-ups must have one', () => {
  const summary = { count: 1, wallSeconds: 4, activeSeconds: null }
  assert.ok(isBenchRun(run('leaf')))
  assert.equal(isBenchRun(run('leaf', { sprites: summary })), false)
  assert.ok(isBenchRun(run('top', { level: 'task', model: null, byModel: [], sprites: summary })))
  assert.equal(isBenchRun(run('top', { level: 'task', model: null, byModel: [], sprites: null })), false)
  assert.equal(isBenchRun(run('top', { level: 'task', model: null, byModel: null, sprites: summary })), false)
})

test('a sprite that ends before it starts is invalid, and an SDK Infinity is refused before it serializes to null', async (t) => {
  assert.equal(isBenchRun(run('backwards', { startedAt: '2026-01-01T00:00:00.001Z', endedAt: time, wallSeconds: 0, activeSeconds: 0 })), false)
  const { bench, team } = await fixture(t)
  const infinite = run('infinite', { tokens: { in: Infinity, out: 2, reasoning: null, cached: null }, coverage: { tokens: 'partial' } })
  await assert.rejects(bench.record(infinite), TypeError)
  assert.equal((await team.channel('bench').messages()).messages.length, 0)
})
