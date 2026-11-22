import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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
    workId: workId.toLowerCase(), result: 'valid', reasons: [], path: reportPath, sha256: input.evidence.sha256,
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

test('duplicate front matter work_id keys still bind when a key is quoted', async (t) => {
  for (const key of ['work_id', '"work_id"', "'work_id'"]) {
    const { input } = await fixture(t, report().replace(`work_id: ${workId}\n`, `work_id: ${workId}\n${key}: ${workId}\n`))
    const validation = await validateEvidence(input)
    assert.equal(validation.result, 'invalid', key)
    assert.ok(validation.reasons.includes('front matter work_id does not match work id'), key)
  }
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

test('a replacement at the same path during a read is accepted', async (t) => {
  const { input, file, text } = await fixture(t)
  const open = fs.open
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    const readFile = handle.readFile.bind(handle)
    t.mock.method(handle, 'readFile', async () => {
      const bytes = await readFile()
      await rename(file, join(input.root, 'original.md'))
      await writeFile(file, text)
      return bytes
    })
    return handle
  })
  syncBuiltinESMExports()
  try {
    const validation = await validateEvidence(input)
    assert.equal(validation.result, 'invalid')
    assert.deepEqual(validation.reasons, ['evidence path changed during validation'])
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('tampered evidence completes despite invalid validation, or a missing file is not unverifiable', async (t) => {
  const { input, file, text } = await fixture(t)
  const tampered = text + 'Additional measurements.\n'
  await writeFile(file, tampered)
  const validation = await validateEvidence(input)
  assert.equal(validation.result, 'invalid', 'tampered bytes')
  assert.equal(validation.sha256, digest(tampered))
  assert.equal(completion(validation, [accept(digest(tampered))]), false, 'accepted tampered digest')
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

test('valid evidence for one ticket completes another ticket with a matching accept', async (t) => {
  const { input } = await fixture(t)
  const validation = await validateEvidence(input)
  const otherWorkId = 'WP-409'
  const review = { ...accept(checkedDigest(validation)), work_id: otherWorkId }
  assert.equal(decideCompletion({
    workId: otherWorkId, validation, reviews: [review], declared: 'jockey',
    claimant: 'producer', jockeys: ['jockey-1'],
  }).complete, false)
})

test('a matching review is ignored when the work id uses different case', async (t) => {
  const { input } = await fixture(t)
  const validation = await validateEvidence(input)
  const review = { ...accept(checkedDigest(validation)), work_id: workId.toLowerCase() }
  assert.equal(completion(validation, [review]), true)
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

test('a declared section list drops or duplicates a kind default', async (t) => {
  const { input } = await fixture(t)
  for (const [required_sections, missing] of [
    [[], ['scope']],
    [['SCOPE', 'appendix'], ['scope', 'appendix']],
  ] as const) {
    const validation = await validateEvidence({
      ...input, outcome: { kind: 'research', required_sections: [...required_sections] },
      evidence: { ...input.evidence, kind: 'research' },
    })
    assert.equal(validation.result, 'invalid')
    assert.deepEqual(validation.reasons, missing.map((section) => `missing or empty section: ${section}`))
  }
})

test('complete research or ops evidence is rejected, or evidence missing a default section is accepted', async (t) => {
  for (const [kind, sections] of [
    ['research', ['scope', 'sources', 'findings']],
    ['ops', ['operation', 'verification']],
  ] as const) {
    for (const missing of [undefined, ...sections]) {
      const body = sections.filter((name) => name !== missing).map((name) => `## ${name}\nDetails.\n`).join('\n')
      const { input } = await fixture(t, report(body))
      const validation = await validateEvidence({
        ...input, outcome: { kind }, evidence: { ...input.evidence, kind },
      })
      if (missing === undefined) {
        assert.equal(validation.result, 'valid', `${kind} with every default section`)
      } else {
        assert.equal(validation.result, 'invalid', `${kind} without ${missing}`)
        assert.deepEqual(validation.reasons, [`missing or empty section: ${missing}`])
      }
    }
  }
})
