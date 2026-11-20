import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InvalidRemoteStatus, reviewGate, signVerdict, watchRemote, type CheckResult } from '../src/index.ts'
import { branch, git, memoryHost, openDraft, refsAt, shaA, shaB, tempDir } from './remote-support.ts'

const key = Buffer.from('fixture-key')
const fields = { sha: shaA, reviewer: 'reviewer', outcome: 'clean' } as const
const verdict = signVerdict(fields, key)
const statusBranch = 'remote/worker/status'
const work = { branch, statusBranch, title: 'Fixture work' }
const pass: CheckResult = { sha: shaA, state: 'pass' }

async function statusRepo(t: Parameters<typeof tempDir>[0]) {
  const repo = await tempDir(t)
  git(repo, 'init', '-b', 'main')
  return refsAt(repo)
}

test('only a finished status opens a draft; repeat polls reuse it and refresh checks', async (t) => {
  const refs = await statusRepo(t)
  const host = memoryHost()
  const watcher = watchRemote({ refs, host })
  assert.deepEqual(await watcher.poll(work), { status: 'not_finished' })
  const working = await refs.write(statusBranch, 'status.json', '{"state":"working"}', null)
  assert.deepEqual(await watcher.poll(work), { status: 'not_finished' })
  assert.equal(await host.findPr(branch), null)
  await refs.write(statusBranch, 'status.json', '{"state":"finished"}', working)
  host.checks = async (sha) => ({ sha, state: 'pending' })
  const first = await watcher.poll(work)
  assert.deepEqual(first, { status: 'checked', pr: 1, check: { sha: shaA, state: 'pending' } })
  host.canOpen = false
  host.checks = async (sha) => ({ sha, state: 'pass' })
  assert.deepEqual(await watcher.poll(work), { status: 'checked', pr: 1, check: pass })
  assert.deepEqual(await watchRemote({ refs, host }).poll(work), { status: 'checked', pr: 1, check: pass })
  assert.equal(host.prs.size, 1)
  assert.equal(host.prs.get(1)?.draft, true)
  assert.deepEqual(watcher.checkFor(shaA), pass)
})

test('malformed status is a typed error and never opens a PR', async (t) => {
  const refs = await statusRepo(t)
  const host = memoryHost()
  await refs.write(statusBranch, 'status.json', '{"state":"finished"', null)
  await assert.rejects(watchRemote({ refs, host }).poll(work), InvalidRemoteStatus)
  assert.equal(await host.findPr(branch), null)
})

test('a push during checks keeps the old result on the old SHA and requires a fresh verdict', async (t) => {
  const refs = await statusRepo(t)
  await refs.write(statusBranch, 'status.json', '{"state":"finished"}', null)
  const host = memoryHost()
  const watcher = watchRemote({ refs, host })
  host.checks = async (sha) => {
    host.heads.set(branch, shaB)
    return { sha, state: 'pass' }
  }
  const result = await watcher.poll(work)
  assert.deepEqual(result, { status: 'checked', pr: 1, check: pass })
  assert.deepEqual(watcher.checkFor(shaA), pass)
  assert.equal(watcher.checkFor(shaB), undefined)
  const verdicts = [verdict]
  const gate = reviewGate({ host, key, checkFor: watcher.checkFor, verdictsFor: () => verdicts })
  assert.deepEqual(await gate.markReadyIfAllowed(1), { status: 'refused', sha: shaB, reason: 'check_missing' })
  assert.deepEqual(await watcher.poll(work), { status: 'checked', pr: 1, check: { sha: shaB, state: 'pass' } })
  assert.deepEqual(await gate.markReadyIfAllowed(1), { status: 'refused', sha: shaB, reason: 'stale_verdict' })
  assert.equal(host.prs.get(1)?.draft, true)
  verdicts.push(signVerdict({ ...fields, sha: shaB }, key))
  assert.deepEqual(await gate.markReadyIfAllowed(1), { status: 'ready', sha: shaB })
  assert.equal(host.prs.get(1)?.draft, false)
})

test('the watcher will not record a check reported for a different SHA', async (t) => {
  const refs = await statusRepo(t)
  await refs.write(statusBranch, 'status.json', '{"state":"finished"}', null)
  const host = memoryHost()
  host.checks = async () => ({ sha: shaB, state: 'pass' })
  const watcher = watchRemote({ refs, host })
  await assert.rejects(watcher.poll(work), { name: 'CodeHostError', reason: 'check_sha_mismatch' })
  assert.equal(watcher.checkFor(shaA), undefined)
  assert.equal(watcher.checkFor(shaB), undefined)
})

test('signVerdict emits an interoperable HMAC-SHA256 signature', () => {
  assert.deepEqual(signVerdict({ outcome: 'clean', reviewer: 'reviewer', sha: shaA }, key), {
    ...fields, signature: '1dbe857fb3625eac65ca08c1805506b0cfd619655fc150e4cdd153d1c425eccb',
  })
})

const findings = signVerdict({ ...fields, outcome: 'findings' }, key)
const refusals = [
  ['forged digest', pass, [{ ...verdict, signature: '0'.repeat(64) }], 'invalid_signature'],
  ['changed reviewer', pass, [{ ...verdict, reviewer: 'imposter' }], 'invalid_signature'],
  ['changed outcome', pass, [{ ...findings, outcome: 'clean' }], 'invalid_signature'],
  ['relabelled SHA', pass, [{ ...signVerdict({ ...fields, sha: shaB }, key), sha: shaA }], 'invalid_signature'],
  ['wrong key', pass, [signVerdict(fields, Buffer.from('wrong-fixture-key'))], 'invalid_signature'],
  ['findings', pass, [findings], 'review_findings'],
  ['no review', pass, [], 'review_missing'],
  ['pending check', { ...pass, state: 'pending' }, [verdict], 'check_pending'],
  ['failed check', { ...pass, state: 'fail' }, [verdict], 'check_failed'],
  ['stale check', { ...pass, sha: shaB }, [verdict], 'stale_check'],
] as const

for (const [scenario, check, verdicts, reason] of refusals) {
  test(`the gate keeps a PR draft with ${scenario}`, async () => {
    const { host, pr, draft } = await openDraft()
    const gate = reviewGate({ host, key, checkFor: () => check, verdictsFor: () => verdicts })
    assert.deepEqual(await gate.markReadyIfAllowed(pr), { status: 'refused', sha: shaA, reason })
    assert.equal(draft(), true)
  })
}

test('a push at the ready transition leaves the PR in draft', async () => {
  const { host, pr, draft } = await openDraft()
  host.beforeReady = () => { host.heads.set(branch, shaB) }
  const gate = reviewGate({ host, key, checkFor: () => pass, verdictsFor: () => [verdict] })
  assert.deepEqual(await gate.markReadyIfAllowed(pr), { status: 'refused', sha: shaA, reason: 'head_changed' })
  assert.equal(draft(), true)
})
