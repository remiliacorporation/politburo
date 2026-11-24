import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultConfig, loadConfig, parseScoreInput, scoreParty, scoreRules,
  type Fact, type ScoreOutcomeRecord as OutcomeRecord, type ScoreInput,
} from '../src/index.ts'

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString()
const rules = scoreRules(defaultConfig())
const report = (input: ScoreInput, asOf = day(20), party = 'A') =>
  scoreParty(input, rules, { party, asOf })
const seeds = [1, 17, 701, 2027]

function seeded(seed: number, party = 'A', size = 3): ScoreInput {
  const next = (limit: number) => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    return Math.floor(seed / 2 ** 32 * limit)
  }
  const input: ScoreInput = { dispatches: [], spend: [], outcomes: [], facts: [] }
  for (let i = 0; i < size; i++) {
    const key = { party, work_id: `work-${i}`, attempt: '1' }
    const id = `${party}-${i}`
    const envelope = {
      ...key, repo: 'acme/web', tier: 'sprite' as const, parent: null, session: id,
      trace: { id, execution_id: `run-${id}` },
    }
    input.dispatches.push(envelope)
    input.spend.push({
      record_id: `spend-${id}`, dedupe_key: id, revises: null, envelope,
      coverage: { state: 'closed_reconciled' },
      tokens: {
        input_total: i === 0 ? 10_000_000 : next(1_200_000), output: next(100_000),
        input_uncached: null, cache_read: null, cache_write: null, reasoning: null,
      },
    })
    const at = day(1 + 2 * i)
    input.outcomes.push({
      ...key, contract_revision: 1, result: 'valid', outcome: { kind: 'pr', index: 0 },
      checked_at: at, evidence: `acme/web#${i + 1}`, verifier_version: '1', override: null,
    })
    input.facts.push(
      { ...key, fact_id: `merge-${id}`, at, kind: 'merged', pr: `acme/web#${i + 1}` },
      { ...key, fact_id: `minutes-${id}`, at, kind: 'human_minutes', minutes: i === 0 ? 1_000 : next(30) },
    )
  }
  return input
}

function mergedOnly(size = 1): ScoreInput {
  const { outcomes, facts } = seeded(701, 'A', size)
  return { dispatches: [], spend: [], outcomes, facts: facts.filter(f => f.kind === 'merged') }
}

test('GATE: under-reporting spend ties or beats full reporting for the same merged work', () => {
  const a = seeded(701)
  const b = seeded(701, 'B')
  for (const outcome of b.outcomes) outcome.checked_at = new Date(Date.parse(outcome.checked_at) + 1).toISOString()
  for (const row of [...a.spend, ...b.spend]) row.tokens.input_total = 10_000_000
  b.spend.shift()
  b.spend[0]!.coverage.state = 'partial'
  b.spend[1]!.tokens.output = null
  const input = parseScoreInput({
    dispatches: [...a.dispatches, ...b.dispatches], spend: [...a.spend, ...b.spend],
    outcomes: [...a.outcomes, ...b.outcomes], facts: [...a.facts, ...b.facts],
  })
  const full = report(input)
  const under = report(input, day(20), 'B')
  assert.ok(under.total < full.total, `under-reported ${under.total}, fully reported ${full.total}`)
  assert.equal(full.unknown.items, 0)
  assert.equal(under.unknown.items, 3)
})

test('I1: making any known token or human-minute report unknown does not strictly lower the score', () => {
  for (const seed of seeds) {
    const input = seeded(seed, 'A', 2 + seed % 3)
    const known = report(input)
    const expensive = known.contributions.find(c => c.rule === 'tokens_per_merged_pr' && c.work_id === 'work-0')
    assert.equal(expensive?.points, -rules.tokens_per_merged_pr.max_penalty)
    for (const row of input.spend) {
      for (const missing of ['partial', 'output', 'input_total'] as const) {
        const unknown = missing === 'partial'
          ? { ...row, coverage: { state: 'partial' as const } }
          : { ...row, tokens: { ...row.tokens, [missing]: null } }
        const { total } = report({ ...input, spend: input.spend.map(r => r === row ? unknown : r) })
        assert.ok(total < known.total, `seed ${seed}, ${row.record_id} (${missing}): ${total} >= ${known.total}`)
      }
    }
    for (const fact of input.facts) {
      if (fact.kind !== 'human_minutes') continue
      const facts = input.facts.map(f => f === fact ? { ...fact, minutes: null } : f)
      const { total } = report({ ...input, facts })
      assert.ok(total < known.total, `seed ${seed}, ${fact.fact_id}: ${total} >= ${known.total}`)
    }
  }
})

test('I3: the total disagrees with contributions or a contribution lacks a real input ref', () => {
  for (const seed of seeds) {
    const input = seeded(seed)
    input.spend.pop()
    const ids = {
      dispatch: new Set(input.dispatches.map(d => d.trace.execution_id)),
      spend: new Set(input.spend.map(s => s.record_id)),
      outcome: new Set(input.outcomes.map(o => `${o.work_id}#${o.attempt}@${o.checked_at}`)),
      fact: new Set(input.facts.map(f => f.fact_id)),
    }
    const { total, contributions } = report(input)
    assert.equal(total, contributions.reduce((sum, c) => sum + c.points, 0))
    for (const { rule, refs } of contributions) {
      assert.ok(refs.length > 0, `${rule} has no refs`)
      for (const { kind, id } of refs) assert.ok(ids[kind]?.has(id), `${rule}: missing ${kind} ${id}`)
    }
  }
})

test('a merge earns credit before it is stable, at the wrong boundary, or after a revert', () => {
  const input = mergedOnly()
  const { party, work_id, attempt } = input.facts[0]!
  const stableAt = day(1 + rules.stays_merged_days)
  assert.equal(report(input, new Date(Date.parse(stableAt) - 1).toISOString()).total, 0)
  assert.equal(report(input, stableAt).total, rules.merged_work)
  input.facts.push({ party, work_id, attempt, fact_id: 'revert', at: day(9), kind: 'reverted' })
  const reverted = report(input)
  assert.equal(reverted.total, -rules.revert)
  assert.deepEqual(reverted.contributions.map(c => c.rule), ['revert'])
})

test('an external merge or a merge without a matching valid outcome earns credit', () => {
  const input = mergedOnly()
  const outcome = input.outcomes[0]!
  const cases: [string, OutcomeRecord[]][] = [
    ['missing', []], ['invalid', [{ ...outcome, result: 'invalid' }]],
    ['no outcome', [{ ...outcome, outcome: null }]], ['wrong party', [{ ...outcome, party: 'B' }]],
    ['wrong work', [{ ...outcome, work_id: 'other' }]], ['wrong attempt', [{ ...outcome, attempt: '2' }]],
  ]
  for (const [label, outcomes] of cases) assert.equal(report({ ...input, outcomes }).total, 0, label)
  const facts = input.facts.map(f => ({ ...f, party: 'B' }))
  assert.equal(report({ ...input, facts }).total, 0, 'external merge')
})

test('a superseded spend record still counts alongside its revision', () => {
  const input = seeded(701, 'A', 1)
  const old = input.spend[0]!
  const head = { ...old, record_id: 'amended', revises: old.record_id, tokens: { ...old.tokens, input_total: 0 } }
  assert.deepEqual(report({ ...input, spend: [old, head] }), report({ ...input, spend: [{ ...head, revises: null }] }))
})

test('a cross-party or unbound revision hides a party’s 10M-token spend', () => {
  const input = seeded(701, 'A', 1)
  const old = input.spend[0]!
  const head = { ...old, record_id: 'amended', revises: old.record_id }
  parseScoreInput({ ...input, spend: [old, head] })
  parseScoreInput({ ...input, spend: [{ ...old, envelope: null }, head] })
  for (const envelope of [{ ...old.envelope!, party: 'B' }, null]) {
    assert.throws(() => parseScoreInput({ ...input, spend: [old, { ...head, envelope }] }), {
      name: 'ScoringInputError', message: /spend\/1\/revises:.*same party/,
    }, envelope === null ? 'unbound revision was accepted' : 'party B revision was accepted')
  }
})

test('quarantining a 10M-token report loses its dispatch’s unknown-spend deduction', () => {
  const input = seeded(701, 'A', 1)
  const known = report(parseScoreInput(input))
  const quarantined = report(parseScoreInput({ ...input, spend: [{ ...input.spend[0]!, envelope: null }] }))
  assert.ok(quarantined.total < known.total, `quarantined score ${quarantined.total} >= known score ${known.total}`)
  assert.equal(quarantined.unknown.items, 1)
})

test('facts after asOf change the score report', () => {
  const input = mergedOnly()
  const { party, work_id, attempt } = input.facts[0]!
  const later = { party, work_id, attempt, at: day(21) }
  const future: Fact[] = [
    { ...later, kind: 'reverted', fact_id: 'later-revert' },
    { ...later, kind: 'missed_claim', fact_id: 'later-miss' },
    { ...later, kind: 'human_minutes', minutes: null, fact_id: 'later-minutes' },
  ]
  assert.deepEqual(report({ ...input, facts: [...input.facts, ...future] }), report(input))
})

test('malformed spend is accepted or reported outside the offending field', () => {
  const input = seeded(701, 'A', 1)
  const row = input.spend[0]!
  const cases: [unknown[], RegExp][] = [
    [[row, { ...row }], /spend\/1\/record_id/],
    [[{ ...row, revises: 'missing' }], /spend\/0\/revises/],
    [[{ ...row, typo: true }], /spend\/0\/typo/],
    [[{ ...row, tokens: { ...row.tokens, output: -1 } }], /spend\/0\/tokens\/output/],
  ]
  for (const [spend, message] of cases) {
    assert.throws(() => parseScoreInput({ ...input, spend }), { name: 'ScoringInputError', message })
  }
})

test('empty score input IDs are accepted or reported at the wrong path', () => {
  const input = seeded(701, 'A', 1)
  const [dispatch] = input.dispatches, [spend] = input.spend, [outcome] = input.outcomes, [fact] = input.facts
  const cases: [string, Partial<ScoreInput>][] = [
    ['/spend/0/record_id', { spend: [{ ...spend!, record_id: '' }] }],
    ['/spend/0/revises', { spend: [{ ...spend!, revises: '' }] }],
    ['/dispatches/0/parent', { dispatches: [{ ...dispatch!, parent: '' }] }],
    ['/dispatches/0/trace/execution_id', { dispatches: [{ ...dispatch!, trace: { ...dispatch!.trace, execution_id: '' } }] }],
    ['/facts/0/fact_id', { facts: [{ ...fact!, fact_id: '' }] }],
  ]
  for (const field of ['party', 'work_id', 'attempt'] as const) {
    cases.push(
      [`/dispatches/0/${field}`, { dispatches: [{ ...dispatch!, [field]: '' }] }],
      [`/spend/0/envelope/${field}`, { spend: [{ ...spend!, envelope: { ...dispatch!, [field]: '' } }] }],
      [`/outcomes/0/${field}`, { outcomes: [{ ...outcome!, [field]: '' }] }],
      [`/facts/0/${field}`, { facts: [{ ...fact!, [field]: '' }] }],
    )
  }
  for (const [path, patch] of cases) {
    assert.throws(() => parseScoreInput({ ...input, ...patch }), {
      name: 'ScoringInputError', message: new RegExp(`^${path}:`),
    }, path)
  }
})

test('an outcome with object evidence is accepted or reported at the wrong path', () => {
  const input = mergedOnly()
  assert.throws(() => parseScoreInput({ ...input, outcomes: [{ ...input.outcomes[0], evidence: { uri: 'proof' } }] }), {
    name: 'ScoringInputError', message: /^\/outcomes\/0\/evidence: must be string/,
  })
})

test('two dispatches sharing an execution ID are accepted', () => {
  const input = seeded(701, 'A', 2)
  const [first, second] = input.dispatches
  parseScoreInput(input)
  for (const party of ['A', 'B']) {
    const duplicate = { ...second!, party, trace: { ...second!.trace, execution_id: first!.trace.execution_id } }
    assert.throws(() => parseScoreInput({ ...input, dispatches: [first, duplicate] }), {
      name: 'ScoringInputError', message: /dispatches\/1\/trace\/execution_id:.*duplicate/,
    }, `duplicate dispatch from party ${party} was accepted`)
  }
})

test('two outcome records sharing an emitted ref are accepted', () => {
  const input = mergedOnly()
  const outcome = input.outcomes[0]!
  const cases: [string, OutcomeRecord[]][] = [
    ['same tuple', [outcome, { ...outcome, evidence: 'other' }]],
    ['delimiter collision', [
      { ...outcome, work_id: 'x#y', attempt: 'z' },
      { ...outcome, work_id: 'x', attempt: 'y#z' },
    ]],
    ['different parties', [outcome, { ...outcome, party: 'B' }]],
  ]
  for (const [label, outcomes] of cases) {
    assert.throws(() => parseScoreInput({ ...input, outcomes }), {
      name: 'ScoringInputError', message: /outcomes\/1:.*duplicate outcome ref/,
    }, label)
  }
})

test('a misspelled score setting is accepted or reported at the wrong path', () => {
  assert.throws(() => loadConfig({ party: { score: { merged_wrk: 10 } } }), {
    name: 'ConfigError', field: 'score.merged_wrk',
  })
})

test('a score point value too large for exact integer arithmetic is accepted and hides the unknown-spend deduction', () => {
  assert.throws(() => loadConfig({ party: { score: { merged_work: 1e20 } } }), {
    name: 'ConfigError', field: 'score.merged_work',
  })
})

test('a token penalty cap above 1000000 is accepted or reported at the wrong path', () => {
  const config = (max_penalty: number) => loadConfig({ party: { score: { tokens_per_merged_pr: { max_penalty } } } })
  config(1_000_000)
  assert.throws(() => config(1_000_001), {
    name: 'ConfigError', field: 'score.tokens_per_merged_pr.max_penalty',
  })
})

test('an unsafe score contribution is accepted even when the total is safe', () => {
  const input = mergedOnly()
  const { party, work_id, attempt, at } = input.facts[0]!
  input.facts.push({ kind: 'missed_claim', fact_id: 'miss', party, work_id, attempt, at })
  const unsafe = { ...rules, merged_work: 1, missed_claim: Number.MAX_SAFE_INTEGER + 1 }
  assert.throws(() => scoreParty(input, unsafe, { party, asOf: day(20) }), {
    name: 'RangeError', message: /missed_claim.*not a safe integer/,
  })
})

test('an unsafe score total is accepted when each contribution is safe', () => {
  const unsafe = { ...rules, merged_work: Number.MAX_SAFE_INTEGER }
  assert.throws(() => scoreParty(mergedOnly(2), unsafe, { party: 'A', asOf: day(20) }), {
    name: 'RangeError', message: /score total.*not a safe integer/,
  })
})

test('an oversized missed-claim dock product can round away the unknown-spend deduction', () => {
  const config = (dock: number) => loadConfig({ party: {
    score: { missed_claim: 1_000_000 }, claims: { dock: { missed_claim: dock } },
  } })
  assert.equal(scoreRules(config(1)).missed_claim, 1_000_000)
  for (const dock of [2, 1e14]) {
    const oversized = config(dock)
    assert.throws(() => scoreRules(oversized), {
      name: 'ConfigError', field: 'claims.dock.missed_claim', message: /must not exceed 1000000/,
    })
  }
})

test('a level or milestone changes before or after the second merge reaches the exact boundary', () => {
  const input = mergedOnly(2)
  const milestone = { id: 'second', metric: 'stable_merges', at: 2 } as const
  const configured = scoreRules(loadConfig({ party: { score: { milestones: [milestone] } } }))
  const at = day(3 + configured.stays_merged_days)
  const score = (asOf: string) => scoreParty(input, configured, { party: 'A', asOf })
  const before = score(new Date(Date.parse(at) - 1).toISOString())
  const reached = score(at)
  const nextLevel = configured.levels[1]!
  assert.equal(reached.total, nextLevel.min)
  assert.equal(before.level.name, configured.levels[0]!.name)
  assert.equal(reached.level.name, nextLevel.name)
  assert.equal(before.milestones.find(m => m.id === milestone.id)?.reached_at, null)
  assert.equal(reached.milestones.find(m => m.id === milestone.id)?.reached_at, at)
  assert.equal(score(day(20)).milestones.find(m => m.id === milestone.id)?.reached_at, at)
})
