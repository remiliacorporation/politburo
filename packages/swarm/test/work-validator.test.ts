import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkOutcomes, parseOutcomesContract, type Evidence, type OutcomesContract } from '../src/work/index.ts'

const pr = `- [ ] kind: pull_request
      repo: acme/web
      base: main
      state: open_or_merged
      checks: required_pass
      evidence: url`
const report = `- [ ] kind: report
      location: docs/report.md
      required_sections: [findings, sources]
      evidence: path`
const description = (items = pr, rule = 'any_outcome') => `## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
${items}

## Verification
- completion_rule: ${rule}
- reviewer: jockey
- on_no_match: release_and_dock`

function contract(items = pr, rule?: string): OutcomesContract {
  const parsed = parseOutcomesContract(description(items, rule))
  assert.ok(parsed.valid)
  return parsed.contract
}
const pull: Evidence = {
  kind: 'pull_request', url: 'https://github.com/acme/web/pull/42', repo: 'acme/web', base: 'main',
  state: 'open', draft: false, checks: 'pass', headSha: '42'.repeat(20),
}
const file: Evidence = { kind: 'report', path: 'docs/report.md', digest: `sha256:${'ab'.repeat(32)}`, sections: ['sources', 'findings'], reviewedBy: 'jockey' }
const ops = `- [ ] kind: ops
      receipt: deploy-123
      verification: smoke check passed
      evidence: url`
const receipt = {
  kind: 'ops', receipt: 'deploy-123', accepted_by: 'jockey', ref: 'https://example.com/deploy-123', verification: 'smoke check passed',
} as const

test('rejects a contract exposed by a fence opener inside a closed HTML comment', () => {
  assert.equal(parseOutcomesContract(`<!-- sample\n~~~\n-->\n~~~\n\n${description()}`).valid, false)
})

test('rejects a dot or dot-dot PR owner or repo', () => {
  for (const repo of ['./web', '../web', 'acme/.', 'acme/..']) {
    assert.equal(parseOutcomesContract(description(pr.replace('acme/web', repo))).valid, false, repo)
  }
})

test('rejects HEAD and bare @ as PR base branch names', () => {
  for (const base of ['HEAD', '@']) {
    assert.equal(parseOutcomesContract(description(pr.replace('base: main', `base: ${base}`))).valid, false, base)
  }
})

test('a matching PR records the observed URL and exact head', () => {
  assert.deepEqual(checkOutcomes(contract(), [pull]), {
    result: 'valid', outcome: { kind: 'pull_request', index: 0 }, evidence: { ref: pull.url, revision: pull.headSha },
  })
})

test('a PR on the wrong base or repo is unverifiable even with passing checks', () => {
  assert.equal(checkOutcomes(contract(), [{ ...pull, base: 'develop' }]).result, 'unverifiable')
  assert.equal(checkOutcomes(contract(), [{ ...pull, repo: 'acme/api' }]).result, 'unverifiable')
})

test('a non-PR URL, unknown head, or missing draft status cannot prove a PR', () => {
  const missing = { draft: undefined, url: 'https://github.com/acme/web/issues/42', headSha: 'unknown' }
  for (const patch of [missing, { draft: missing.draft }, { url: missing.url }, { headSha: missing.headSha },
    { url: `${pull.url}?tab=checks` }, { url: 'https://github.com/acme/weB/pull/42' }, { headSha: 'AB'.repeat(20) }]) {
    const observation = { ...pull, ...patch } as Evidence // Unchecked data from an observer.
    assert.equal(checkOutcomes(contract(), [observation]).result, 'unverifiable', JSON.stringify(patch))
  }
})

test('a draft PR is rejected unless the contract allows drafts', () => {
  const draft = { ...pull, draft: true }
  assert.equal(checkOutcomes(contract(), [draft]).result, 'invalid')
  assert.equal(checkOutcomes(contract(`${pr}\n      draft: allowed`), [draft]).result, 'valid')
})

test('pending and unknown checks are not passes or definitive failures', () => {
  for (const checks of ['pending', 'unknown'] as const) {
    assert.equal(checkOutcomes(contract(), [{ ...pull, checks }]).result, 'unverifiable')
  }
  for (const checks of ['fail', 'absent'] as const) {
    assert.equal(checkOutcomes(contract(), [{ ...pull, checks }]).result, 'invalid')
  }
})

test('a PR URL alone cannot prove the candidate without its head', () => {
  assert.equal(checkOutcomes(contract(), [{ ...pull, headSha: '' }]).result, 'unverifiable')
})

test('a report missing a required section does not match', () => {
  assert.equal(checkOutcomes(contract(report), [{ ...file, sections: ['sources'] }]).result, 'invalid')
})

test('review by the wrong actor does not satisfy the contract reviewer', () => {
  assert.equal(checkOutcomes(contract(report), [{ ...file, reviewedBy: 'someone-else' }]).result, 'invalid')
  assert.equal(checkOutcomes(contract(report), [file]).result, 'valid')
})

test('one valid outcome satisfies any_outcome but cannot satisfy all_outcomes', () => {
  const items = `${pr}\n${report}`
  assert.equal(checkOutcomes(contract(items), [pull]).result, 'valid')
  assert.equal(checkOutcomes(contract(items, 'all_outcomes'), [pull]).result, 'invalid')
  assert.equal(checkOutcomes(contract(items, 'all_outcomes'), [pull, file]).result, 'valid')
  assert.deepEqual(checkOutcomes(contract(), []), { result: 'invalid', outcome: null, evidence: null })
})

test('review cannot validate report or research evidence with a short digest or a different path', () => {
  for (const kind of ['report', 'research'] as const) {
    const expected = contract(report.replace('kind: report', `kind: ${kind}`))
    const observed: Evidence = { ...file, kind }
    assert.equal(checkOutcomes(expected, [{ ...observed, digest: 'sha256:abc' }]).result, 'unverifiable')
    assert.equal(checkOutcomes(expected, [{ ...observed, path: 'docs/another.md' }]).result, 'invalid')
  }
})

test('an ops receipt must match the declared receipt and carry reviewer acceptance', () => {
  const expected = contract(ops)
  assert.equal(checkOutcomes(expected, [receipt]).result, 'valid')
  assert.equal(checkOutcomes(expected, [{ ...receipt, receipt: 'deploy-456' }]).result, 'invalid')
  assert.equal(checkOutcomes(expected, [{ ...receipt, accepted_by: null }]).result, 'unverifiable')
})

test('reviewer acceptance cannot validate ops evidence with the wrong ref type or missing or mismatched verification', () => {
  const expected = contract(ops)
  const path = 'deploy/output.log'
  for (const patch of [{ ref: path, verification: undefined }, { ref: path }, { verification: undefined }, { verification: '' }]) {
    const observation = { ...receipt, ...patch } as Evidence // Unchecked data from an observer.
    assert.equal(checkOutcomes(expected, [observation]).result, 'unverifiable', JSON.stringify(patch))
  }
  assert.equal(checkOutcomes(expected, [{ ...receipt, verification: 'a different check passed' }]).result, 'invalid')
  const pathContract = contract(ops.replace('evidence: url', 'evidence: path'))
  assert.equal(checkOutcomes(pathContract, [receipt]).result, 'unverifiable')
  assert.equal(checkOutcomes(pathContract, [{ ...receipt, ref: path }]).result, 'valid')
})
