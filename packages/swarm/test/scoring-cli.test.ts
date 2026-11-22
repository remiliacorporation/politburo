import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ScoreInput } from '../src/index.ts'

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString()
function seeded(seed: number, party = 'A'): ScoreInput {
  const next = (limit: number) => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    return Math.floor(seed / 2 ** 32 * limit)
  }
  const input: ScoreInput = { dispatches: [], spend: [], outcomes: [], facts: [] }
  for (let i = 0; i < 2; i++) {
    const key = { party, work_id: `work-${i}`, attempt: '1' }, id = `${party}-${i}`
    const envelope = { ...key, repo: 'acme/web', tier: 'sprite' as const, parent: null, session: id,
      trace: { id, execution_id: `run-${id}` } }
    input.dispatches.push(envelope)
    input.spend.push({ record_id: `spend-${id}`, dedupe_key: id, revises: null, envelope,
      coverage: { state: 'closed_reconciled' }, tokens: { input_total: 10_000_000, output: next(100_000),
        input_uncached: null, cache_read: null, cache_write: null, reasoning: null } })
    const at = day(1 + 2 * i)
    input.outcomes.push({ ...key, contract_revision: 1, result: 'valid', outcome: { kind: 'pr', index: 0 },
      checked_at: new Date(Date.parse(at) + (party === 'B' ? 1 : 0)).toISOString(),
      evidence: `acme/web#${i + 1}`, verifier_version: '1', override: null })
    input.facts.push({ ...key, fact_id: `merge-${id}`, at, kind: 'merged', pr: `acme/web#${i + 1}` })
  }
  return input
}

function flags(t: TestContext, input = seeded(701)) {
  const path = join(tempDir(t), 'input.json')
  writeFileSync(path, JSON.stringify(input))
  return ['--input', path, '--as-of', day(20)] as const
}
function output(result: ReturnType<typeof run>) {
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trimEnd()
}
function fails(result: ReturnType<typeof run>, code: number, headline: RegExp) {
  assert.equal(result.status, code, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, headline)
}

test('GATE: leaderboard rewards under-reporting or hides its unknown count', (t) => {
  const a = seeded(701), b = seeded(701, 'B')
  b.spend.shift()
  b.spend[0]!.coverage.state = 'partial'
  const args = flags(t, { dispatches: [...a.dispatches, ...b.dispatches], spend: [...a.spend, ...b.spend],
    outcomes: [...a.outcomes, ...b.outcomes], facts: [...a.facts, ...b.facts] })
  const { leaderboard: [full, under] } = JSON.parse(output(run('score', 'leaderboard', ...args, '--json')))
  assert.deepEqual([full.party, full.unknown, under.party, under.unknown], ['A', 0, 'B', 2])
  assert.ok(under.total < full.total, `under-reported ${under.total}, fully reported ${full.total}`)
  const table = output(run('score', 'leaderboard', ...args)).split('\n').map(row => row.split(/ {2,}/))
  assert.deepEqual(table[0], ['rank', 'party', 'score', 'level', 'milestones', 'unknown'])
  assert.equal(table.find(row => row[1] === 'B')?.[5], String(under.unknown))
})

test('card loses its breakdown or state, or item totals disagree with the score', (t) => {
  const input = seeded(701)
  input.spend[0]!.coverage.state = 'partial'
  const args = ['score', 'card', ...flags(t, input), '--party', 'A']
  const doc = JSON.parse(output(run(...args, '--json')))
  assert.deepEqual(Object.keys(doc).sort(), ['scorecard', 'state'])
  assert.equal(doc.state, 'off')
  const [summary, ...items] = output(run(...args)).split('\n\n')
  for (const [label, value] of Object.entries({ party: 'A', score: doc.scorecard.total,
    level: doc.scorecard.level.name, unknown: 1, state: 'off' })) {
    assert.ok(summary!.split('\n').some(line => line.split(/ {2,}/).join('=') === `${label}=${value}`), label)
  }
  const totals = items.map(item => {
    const [heading, ...contributions] = item.split('\n')
    assert.match(heading!, /^work-[01] {2}-?\d+$/)
    assert.ok(contributions.length > 0)
    for (const line of contributions) assert.match(line, /^ {2}\w+ {2,}-?\d+ {2,}(?:fact|outcome|spend|dispatch):\S/)
    return Number(heading!.split('  ')[1])
  })
  assert.equal(items.length, 2)
  assert.equal(totals.reduce((sum, total) => sum + total, 0), doc.scorecard.total)
})

test('history reorders the given dates or drill loses refs or accepts an empty item', (t) => {
  const args = [...flags(t), '--party', 'A']
  // Oldest first by instant, but not by timestamp string.
  const dates = [day(1), '2026-01-10T01:00:00Z', '2026-01-10T00:30:00-02:00', day(20)]
  const history = output(run('score', 'history', ...args, '--as-ofs', dates.join(','))).split('\n')
  assert.deepEqual(history.slice(1).map(row => row.split(/ {2,}/)[0]), dates)
  const drill = (work: string) => run('score', 'drill', ...args, '--work', work)
  const refs = output(drill('work-0')).split('\n\n')[1]?.split('\n').map(row => row.split(/ {2,}/).join(' '))
  assert.deepEqual(refs?.sort(), ['dispatch run-A-0', 'fact merge-A-0', `outcome work-0#1@${day(1)}`, 'spend spend-A-0'])
  fails(drill('no-work'), 1, /^error: work_id: no score contributions for no-work\n/)
})

test('history hides unknown spend from a null-minutes fact', (t) => {
  const input = seeded(701)
  input.facts.push({ party: 'A', work_id: 'work-1', attempt: '1', fact_id: 'minutes',
    at: day(3), kind: 'human_minutes', minutes: null })
  const args = ['score', 'history', ...flags(t, input), '--party', 'A', '--as-ofs', `${day(2)},${day(20)}`]
  const { history } = JSON.parse(output(run(...args, '--json')))
  assert.deepEqual(history.map((row: { unknown: number }) => row.unknown), [0, 1])
  const [header, ...rows] = output(run(...args)).split('\n').map(row => row.split(/ {2,}/))
  assert.deepEqual(header, ['as-of', 'score', 'level', 'unknown'])
  assert.deepEqual(rows.map(row => row[3]), ['0', '1'])
})

test('drill hides unknown spend on the selected work item', (t) => {
  const input = seeded(701)
  for (const spend of input.spend) spend.coverage.state = 'partial'
  const args = ['score', 'drill', ...flags(t, input), '--party', 'A', '--work', 'work-0']
  assert.equal(JSON.parse(output(run(...args, '--json'))).unknown, 1)
  assert.equal(output(run(...args)).split('\n')[1], 'unknown  1')
})

test('drill JSON prints raw C1 controls or line separators in a fact ID', (t) => {
  const input = seeded(701)
  const id = 'merge-\u007f\u009b\u2028\u2029'
  input.facts[0]!.fact_id = id
  const json = output(run('score', 'drill', ...flags(t, input), '--party', 'A', '--work', 'work-0', '--json'))
  assert.doesNotMatch(json, /[\x7f-\x9f\u2028\u2029]/)
  assert.ok(json.includes(String.raw`merge-\u007f\u009b\u2028\u2029`))
  const { records } = JSON.parse(json)
  assert.equal(records.find(({ ref }: { ref: { kind: string } }) => ref.kind === 'fact')?.ref.id, id)
})

test('drill text conflates a newline with a literal escape in fact IDs', (t) => {
  const input = seeded(701)
  const key = { party: 'A', work_id: 'work-0', attempt: '1', at: day(1), kind: 'missed_claim' } as const
  input.facts.push({ ...key, fact_id: 'missed\n' }, { ...key, fact_id: String.raw`missed\u000a` })
  const text = output(run('score', 'drill', ...flags(t, input), '--party', 'A', '--work', 'work-0'))
  const ids = text.split('\n').filter(line => line.startsWith('fact') && line.includes('missed'))
    .map(line => line.split(/ {2,}/)[1]).sort()
  assert.deepEqual(ids, [String.raw`missed\\u000a`, String.raw`missed\u000a`])
})

test('an empty --party value is mistaken for a missing flag', (t) => {
  fails(run('score', 'card', ...flags(t), '--party', ''), 2, /^error: --party must not be empty\n/)
})

test('misuse or input failures use the wrong exit code, stream, or diagnostic', (t) => {
  const [inputFlag, path, asOfFlag, date] = flags(t)
  fails(run('score', 'other'), 2, /^error: unknown score command/)
  fails(run('score', 'leaderboard', asOfFlag, date), 2, /^error: missing --input/)
  fails(run('score', 'leaderboard', inputFlag, path), 2, /^error: missing --as-of/)
  fails(run('score', 'card', inputFlag, path, asOfFlag, date), 2, /^error: missing --party/)
  fails(run('score', 'leaderboard', inputFlag, path, asOfFlag, 'not-a-date'), 2, /^error: .*--as-of/)
  fails(run('score', 'leaderboard', inputFlag, `${path}.missing`, asOfFlag, date), 1, /^error: cannot read /)
  const bad = seeded(701)
  bad.spend[1]!.record_id = bad.spend[0]!.record_id
  fails(run('score', 'leaderboard', ...flags(t, bad)), 1, /^error: spend\/1\/record_id:/)
})

test('leaderboard ignores --rules or hides a misspelled field path', (t) => {
  const args = ['score', 'leaderboard', ...flags(t), '--json']
  const path = join(tempDir(t), 'rules.yaml')
  const total = (...extra: string[]) => JSON.parse(output(run(...args, ...extra))).leaderboard[0].total
  writeFileSync(path, 'score: { merged_work: 20 }\n')
  assert.equal(total('--rules', path) - total(), 20)
  writeFileSync(path, 'score: { merged_wrk: 20 }\n')
  fails(run(...args, '--rules', path), 1, /^error: score\.merged_wrk:/)
})

test('the score hook breaks config show routing', () => {
  assert.match(output(run('config', 'show')), /^score:/m)
})
