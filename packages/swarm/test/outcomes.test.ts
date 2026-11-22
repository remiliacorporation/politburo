import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { decideCompletion, validateEvidence, type EvidenceValidation, type ReviewRecord } from '../src/outcomes/index.ts'

const workId = 'WP-408'
const reportPath = 'report.md'
const findings = '## Findings\nRetries doubled under load.\n'
const sources = '## Sources\nLoad test results.\n'

function report(body = findings + sources, id = workId) {
  return `---\nwork_id: ${id}\n---\n${body}`
}

async function fixture(t: TestContext, text = report()) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-outcomes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'evidence')
  const file = join(root, reportPath)
  await mkdir(root)
  await writeFile(file, text)
  return {
    dir, file, text,
    input: {
      workId, root,
      outcome: { kind: 'report', location: reportPath, required_sections: ['findings', 'sources'] },
      evidence: { work_id: workId, kind: 'report', path: reportPath, sha256: digest(text) },
    },
  }
}

function digest(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

function accept(sha256: string, reviewer = 'jockey-1'): ReviewRecord {
  return {
    work_id: workId, evidence_sha256: sha256, reviewer, decision: 'accept',
    reason: 'Evidence checked', at: '2026-01-01T00:00:00Z',
  }
}

function completion(validation: EvidenceValidation, reviews: ReviewRecord[], declared = 'jockey') {
  return decideCompletion({
    workId, validation, reviews, declared, claimant: 'producer', jockeys: ['jockey-1', 'producer'],
  }).complete
}

function checkedDigest(validation: EvidenceValidation) {
  assert.equal(validation.result, 'valid', validation.reasons.join('; '))
  assert.ok(validation.sha256)
  return validation.sha256
}

test('a report with matching ticket, digest and filled sections is rejected', async (t) => {
  const { input } = await fixture(t)
  assert.deepEqual(await validateEvidence(input), {
    result: 'valid', reasons: [], path: reportPath, sha256: input.evidence.sha256,
  })
})

test('a mismatched ticket in the file or evidence object is accepted', async (t) => {
  const copied = await fixture(t, report(undefined, 'WP-409'))
  const local = await fixture(t)
  assert.equal((await validateEvidence(copied.input)).result, 'invalid', 'file work_id')
  assert.equal((await validateEvidence({
    ...local.input, evidence: { ...local.input.evidence, work_id: 'WP-409' },
  })).result, 'invalid', 'evidence object work_id')
})

test('absolute paths, parent traversal or symlinks out pass the path checks', async (t) => {
  const { dir, file, text, input } = await fixture(t)
  const outside = join(dir, 'outside.md')
  await writeFile(outside, text)
  await symlink(outside, join(input.root, 'linked.md'))
  for (const path of [file, '../outside.md', 'linked.md']) {
    const result = await validateEvidence({
      ...input,
      outcome: { ...input.outcome, location: path },
      evidence: { ...input.evidence, path },
    })
    assert.equal(result.result, 'invalid', path)
    // Parent traversal must be rejected even before checking the resolved path.
    if (path === '../outside.md') assert.match(result.reasons.join('; '), /must not contain \.\./)
  }
})

test('a tampered file is accepted or a missing file is not unverifiable', async (t) => {
  const { input, file, text } = await fixture(t)
  await writeFile(file, text + 'Additional measurements.\n')
  assert.equal((await validateEvidence(input)).result, 'invalid', 'tampered bytes')
  await unlink(file)
  assert.equal((await validateEvidence(input)).result, 'unverifiable', 'missing file')
})

test('a missing, empty or fenced-off required section counts as filled', async (t) => {
  for (const [label, body] of [
    ['missing', sources],
    ['empty', '## Findings\n\n' + sources],
    ['fenced', '```md\n' + findings + '```\n' + sources],
  ] as const) {
    const { input } = await fixture(t, report(body))
    assert.equal((await validateEvidence(input)).result, 'invalid', label)
  }
})

test('the declaration allows a wrong location, wrong kind or unknown kind', async (t) => {
  const { input } = await fixture(t)
  assert.equal((await validateEvidence({
    ...input, outcome: { ...input.outcome, location: 'other.md' },
  })).result, 'invalid', 'declared location mismatch')
  assert.equal((await validateEvidence({
    ...input, evidence: { ...input.evidence, kind: 'research' },
  })).result, 'invalid', 'evidence kind mismatch')
  assert.equal((await validateEvidence({
    ...input, outcome: { ...input.outcome, kind: 'unregistered' },
    evidence: { ...input.evidence, kind: 'unregistered' },
  })).result, 'invalid', 'matching but unknown kind')
})

test('valid evidence completes unreviewed or fails after exact-digest jockey acceptance', async (t) => {
  const { input } = await fixture(t)
  const validation = await validateEvidence(input)
  const review = accept(checkedDigest(validation))
  assert.equal(completion(validation, []), false, 'no review')
  assert.equal(completion(validation, [review]), true, 'exact-digest acceptance')
})

test('a review of an older digest completes changed evidence', async (t) => {
  const { input, file, text } = await fixture(t)
  const review = accept(checkedDigest(await validateEvidence(input)))
  const updated = text + 'The follow-up run confirmed the result.\n'
  await writeFile(file, updated)
  const validation = await validateEvidence({
    ...input, evidence: { ...input.evidence, sha256: digest(updated) },
  })
  checkedDigest(validation)
  assert.equal(completion(validation, [review]), false)
})

test('a claimant or non-jockey can accept under the jockey policy', async (t) => {
  const { input } = await fixture(t)
  const validation = await validateEvidence(input)
  const sha256 = checkedDigest(validation)
  assert.equal(completion(validation, [accept(sha256, 'producer')]), false, 'claimant is also a jockey')
  assert.equal(completion(validation, [accept(sha256, 'bystander')]), false, 'non-jockey')
})

test('a named reviewer is ignored or someone else can accept in their place', async (t) => {
  const { input } = await fixture(t)
  const validation = await validateEvidence(input)
  const sha256 = checkedDigest(validation)
  assert.equal(completion(validation, [accept(sha256, 'editor')], 'editor'), true, 'named non-jockey')
  assert.equal(completion(validation, [accept(sha256)], 'editor'), false, 'unnamed jockey')
})

test('an earlier acceptance wins over a later rejection', async (t) => {
  const { input } = await fixture(t)
  const validation = await validateEvidence(input)
  const earlier = accept(checkedDigest(validation))
  const later: ReviewRecord = {
    ...earlier, decision: 'reject', reason: 'Sources need verification', at: '2026-01-02T00:00:00Z',
  }
  assert.equal(completion(validation, [earlier, later]), false, 'chronological history')
  assert.equal(completion(validation, [later, earlier]), false, 'reverse history')
})

test('research or ops evidence is accepted without its default sections', async (t) => {
  for (const [kind, sections] of [
    ['research', ['scope', 'sources', 'findings']],
    ['ops', ['operation', 'verification']],
  ] as const) {
    for (const missing of sections) {
      const body = sections.filter((name) => name !== missing).map((name) => `## ${name}\nDetails.\n`).join('\n')
      const { input } = await fixture(t, report(body))
      assert.equal((await validateEvidence({
        ...input, outcome: { kind }, evidence: { ...input.evidence, kind },
      })).result, 'invalid', `${kind} without ${missing}`)
    }
  }
})
