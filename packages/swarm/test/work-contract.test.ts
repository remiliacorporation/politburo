import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contractFingerprint, parseOutcomesContract } from '../src/index.ts'

const marker = '<!-- politburo-outcomes:v1 -->'
const heading = '## Acceptable outcomes'
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
const ops = `- [ ] kind: ops
      receipt: Deployment ID
      verification: Smoke check: passed
      evidence: url`
const verification = `## Verification
- completion_rule: any_outcome
- on_no_match: release_and_dock`
const description = (items = pr, review = verification) => `${heading}\n${marker}\n${items}\n\n${review}`
const namedReview = `${verification}\n- reviewer: @james`

function rejects(text: string) {
  const result = parseOutcomesContract(text)
  assert.equal(result.valid, false, text.length < 1000 ? text : 'Oversized contract was accepted')
  if (!result.valid) assert.ok(result.problems.some(problem => problem.trim()))
}

test('a PR-only contract does not require a reviewer or silently allow drafts', () => {
  assert.deepEqual(parseOutcomesContract(description()), {
    valid: true,
    contract: {
      outcomes: [{ kind: 'pull_request', repo: 'acme/web', base: 'main', state: 'open_or_merged',
        checks: 'required_pass', evidence: 'url', draft: 'not_allowed' }],
      completionRule: 'any_outcome', reviewer: null, onNoMatch: 'release_and_dock',
    },
  })
})

test('mixed contracts do not drop evidence criteria, explicit draft policy, or named review', () => {
  const items = [pr + '\n      draft: allowed', report, report.replace('kind: report', 'kind: research'), ops]
  const result = parseOutcomesContract(description(items.join('\n'), namedReview.replace('any_outcome', 'all_outcomes')))
  assert.ok(result.valid)
  assert.equal(result.contract.completionRule, 'all_outcomes')
  assert.equal(result.contract.reviewer, '@james')
  assert.deepEqual(result.contract.outcomes, [
    { kind: 'pull_request', repo: 'acme/web', base: 'main', state: 'open_or_merged',
      checks: 'required_pass', evidence: 'url', draft: 'allowed' },
    { kind: 'report', location: 'docs/report.md', required_sections: ['findings', 'sources'], evidence: 'path' },
    { kind: 'research', location: 'docs/report.md', required_sections: ['findings', 'sources'], evidence: 'path' },
    { kind: 'ops', receipt: 'Deployment ID', verification: 'Smoke check: passed', evidence: 'url' },
  ])
})

test('a missing, duplicated, misplaced, or fenced marker cannot make work claimable', () => {
  const text = description()
  for (const bad of [text.replace(marker, ''), `${text}\n\n## Notes\n${marker}`, text.replace(heading, ''),
    `\`\`\`md\n${text}\n\n## Notes\n\`\`\``]) {
    rejects(bad)
  }
})

test('duplicate contract headings or an intervening section cannot change the contract', () => {
  const text = description()
  for (const bad of [
    `${text}\n\n## Verification\n- on_no_match: keep_claim`,
    `${text}\n\n${heading}\nWork on it`,
    `  ##\tVerification ##\n\n${text}`,
    description(pr, `# Notes\n\n${verification}`),
    description(pr, verification.replace('- on_no_match', '## Notes\n- on_no_match')),
  ]) rejects(bad)

  assert.equal(parseOutcomesContract(`${text}\n\n## Notes\nMore prose`).valid, true)
})

test('a non-ASCII fence closer or an HTML code context cannot hide a contract', () => {
  const text = description()
  for (const bad of [
    `~~~md\nSample\n~~~\u00a0\n\n${text}`,
    ...['<pre>', '<CODE class="sample">', '<script>', '<textarea>', '<!--'].map(open => `${open}\n\n${text}`),
    text.replace('release_and_dock', 'release_and_dock\n<!-- <pre> -->'),
  ]) {
    rejects(bad)
    assert.equal(contractFingerprint(bad), null)
  }
  assert.equal(parseOutcomesContract(`~~~md\nSample\n~~~~ \t\n\n${text}`).valid, true)
})

test('a raw style block or inline raw HTML cannot hide a valid contract', () => {
  const text = description()
  for (const bad of [`<style>\n${text}\n</style>`, `<details>\n${text}\n</details>`,
    `Code: \`<div>\`\n\n${text}`, `Link: <https://example.com>\n\n${text}`]) {
    rejects(bad)
    assert.equal(contractFingerprint(bad), null)
  }
  assert.equal(parseOutcomesContract(`${text}\n\n## Notes\n<div>Extra</div>`).valid, true)
})

test('empty, kindless, or unknown outcomes are invalid, including "work on it" alongside a valid PR', () => {
  for (const item of ['', '- [ ] work on it', `${pr}\n- [ ] work on it`, '- [ ] repo: acme/web',
    pr.replace('pull_request', 'code')]) {
    rejects(description(item))
  }
})

test('outcome parsing rejects missing, blank, and duplicate fields, including a missing ops receipt', () => {
  for (const item of [pr.replace('      base: main\n', ''), pr.replace('base: main', 'base:  '),
    `${pr}\n      base: develop`, ops.replace('      receipt: Deployment ID\n', '')]) {
    rejects(description(item, namedReview))
  }
})

test('every outcome kind rejects unknown fields', () => {
  for (const item of [pr, report, report.replace('kind: report', 'kind: research'), ops]) {
    rejects(description(`${item}\n      title: Refactor`, namedReview))
  }
})

test('malformed outcome criteria are rejected, including draft as a PR state', () => {
  for (const item of [pr.replace('acme/web', 'web'), pr.replace('open_or_merged', 'open'),
    pr.replace('open_or_merged', 'draft'),
    pr.replace('required_pass', 'optional'), pr.replace('evidence: url', 'evidence: path'), `${pr}\n      draft: yes`,
    report.replace('docs/report.md', 'docs/../report.md'), report.replace('docs/report.md', '/report.md'),
    report.replace('docs/report.md', 'https://example.com/report.md'),
    report.replace('[findings, sources]', '[]'), ops.replace('evidence: url', 'evidence: log')]) {
    rejects(description(item, namedReview))
  }
})

test('malformed PR repos and bases or control characters in artifact paths are rejected', () => {
  for (const base of ['feature branch', 'bad\tname', 'main\x7f', 'one..two', '-main', '/main', 'main/',
    'main.lock', 'release.lock/main', 'feat//main', '.hidden/main', 'main.',
    ...['~', '^', ':', '?', '*', '[', '\\', '@{'].map(char => `feat${char}main`)]) {
    rejects(description(pr.replace('base: main', `base: ${base}`)))
  }
  for (const repo of ['acme/wéb', 'acme//web', 'ac me/web', 'web', 'acme/web/extra']) {
    rejects(description(pr.replace('acme/web', repo)))
  }
  assert.equal(parseOutcomesContract(description(pr.replace('acme/web', 'acme_inc/web.v2')
    .replace('base: main', 'base: release/v1.2'))).valid, true)

  for (const item of [report, report.replace('kind: report', 'kind: research')]) {
    for (const location of ['docs/re\0port.md', 'docs/re\x85port.md', 'docs/report.md\t']) {
      rejects(description(item.replace('docs/report.md', location), namedReview))
    }
  }
})

test('non-PR outcomes cannot be claimed without a nonblank reviewer', () => {
  rejects(description(report))
  rejects(description(ops, `${verification}\n- reviewer:   `))
})

test('a missing or malformed Verification section cannot supply an implicit completion policy', () => {
  for (const review of ['', verification.replace('- completion_rule: any_outcome\n', ''),
    verification.replace('any_outcome', 'first_try'), verification.replace('release_and_dock', 'keep_claim'),
    `${verification}\n- on_no_match: release_and_dock`, `${verification}\n- deadline: today`]) {
    rejects(description(pr, review))
  }
})

test('the parser rejects over-limit text and outcome counts', () => {
  assert.equal(parseOutcomesContract(description(Array(20).fill(pr).join('\n'))).valid, true)
  rejects(description(Array(21).fill(pr).join('\n')))
  const text = description()
  const prefix = 'x'.repeat(20_000 - text.length - 2)
  assert.equal(parseOutcomesContract(`${prefix}\n\n${text}`).valid, true)
  rejects(`x${prefix}\n\n${text}`)
})

test('oversized fence-heavy text is rejected by parsing and fingerprinting without slowing near-cap input', () => {
  const text = description()
  const fingerprint = contractFingerprint(text)
  assert.ok(fingerprint)
  for (const length of [19_000, 20_001]) {
    const prefix = '~~~\n'
    const suffix = `\n~~~\n\n${text}`
    const width = length - prefix.length - suffix.length
    const repeats = '~~~ ``` '.repeat(Math.ceil(width / 8)).slice(0, width)
    const input = prefix + repeats + suffix
    assert.equal(input.length, length)

    const start = performance.now()
    const parsed = parseOutcomesContract(input)
    const hash = contractFingerprint(input)
    const elapsed = performance.now() - start
    assert.ok(elapsed < 250, `${length} characters took ${elapsed.toFixed(1)} ms`)
    assert.equal(parsed.valid, length === 19_000)
    assert.equal(hash, length === 19_000 ? fingerprint : null)
  }
})

test('fingerprints change when contract text changes, even when parsed fields stay equal', () => {
  const text = description()
  const original = contractFingerprint(text)
  const edited = contractFingerprint(text.replace('base: main', 'base:  main'))
  assert.ok(original)
  assert.ok(edited)
  assert.notEqual(edited, original)
})

test('fingerprints ignore edits to prose before and after the contract block', () => {
  const text = description().replaceAll('\n', '\r\n')
  assert.equal(
    contractFingerprint(`Context\r\n\r\n${text}\r\n\r\n## Notes\r\nMore prose`),
    contractFingerprint(`Revised context\r\n\r\n${text}\r\n\r\n## Notes\r\nRevised prose`),
  )
})

test('fingerprints are null when a contract block is absent or ambiguous', () => {
  assert.equal(contractFingerprint('Work on it.'), null)
  assert.equal(contractFingerprint(description().replace(marker, '')), null)
  assert.equal(contractFingerprint(`${description()}\n\n## Notes\n${marker}`), null)
})
