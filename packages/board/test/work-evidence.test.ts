import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import type { AttestationGate, EvidencePolicy } from '../src/contract/evidence.ts'
import { conformance } from '../src/conformance/index.ts'
import { board, BOARD_URL, caller, personToken, testBoard } from './harness.ts'

const principal = (name: string) => `vercel:user:u_${name}`
const commit = 'a'.repeat(40)
const other = 'b'.repeat(40)
const expiry = (ms: number) => new Date(Date.now() + ms).toISOString()
const artifactRef = 'builds/42'
const policy: EvidencePolicy = {
  attesters: { tests: [principal('ci')], review: [principal('worker'), principal('reviewer')], browserQA: [principal('reviewer')], acceptance: [principal('reviewer')], publication: [principal('reviewer')] },
  operators: [principal('operator')],
  resolvers: [principal('operator')],
}

const client = (host: Pick<ReturnType<typeof board>, 'fetch'>, user: string, headers: Record<string, string> = {}) => board({
  backend: http(BOARD_URL, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== new URL(BOARD_URL).pathname) request.headers.set('authorization', `Bearer ${await personToken(`u_${user}`)}`)
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
      return host.fetch(request)
    },
  }),
}).as(null)

const setup = (workEvidence: EvidencePolicy = policy) => {
  const host = testBoard({ workEvidence })
  return { host, worker: client(host, 'worker'), ci: client(host, 'ci'), reviewer: client(host, 'reviewer'), operator: client(host, 'operator') }
}

const attest = (round: number, gate: AttestationGate, verdict: 'pass' | 'fail' = 'pass', sha = commit) => ({ commit: sha, round, gate, verdict, artifactRef })
const create = async (worker: ReturnType<typeof client>, needs?: string[], channel = 'work') => (await worker.tasks.create(channel, { text: 'Ship the patch', ...(needs ? { needs } : {}) })).task
const read = async (worker: ReturnType<typeof client>, id: string) => (await worker.thread(id)).message
const denied = (promise: Promise<unknown>, status: number, code: string) => expect(promise).rejects.toMatchObject({ status, code })

afterEach(() => vi.useRealTimers())

describe('work evidence through the HTTP backend', () => {
  it('gates completion on the current submission, latest tests, and an independent review', async () => {
    const { host, worker, ci, reviewer } = setup()
    expect((await worker.discovery()).workEvidence).toEqual({ version: 1, gates: ['submission', 'tests', 'review'], releaseDependencies: false })
    const root = await create(worker)
    const dependent = await create(worker, [root.id])
    const claim = await worker.tasks.claim(root.id)
    const { epoch } = claim
    await denied(claim.complete('trust me'), 409, 'evidence_required')
    await denied(claim.submit('aaaa', artifactRef), 400, 'invalid_request')
    await denied(reviewer.tasks.held(root.id, claim).submit(commit, artifactRef), 409, 'claim_lost')
    await claim.submit(commit, artifactRef)
    await denied(claim.submit(other, artifactRef), 409, 'already_submitted')
    const send = caller(host.fetch, await personToken('u_ci'))
    expect((await send('POST', `/work/v1/tasks/${root.id}/evidence`, { ...attest(epoch, 'tests'), by: { principal: principal('operator') } })).status).toBe(400)
    expect((await worker.tasks.evidence(root.id)).evidence).toEqual([])
    await denied(ci.tasks.recordEvidence(root.id, attest(epoch, 'tests', 'pass', other)), 409, 'stale_candidate')
    await denied(ci.tasks.recordEvidence(root.id, attest(epoch + 1, 'tests')), 409, 'stale_candidate')
    await denied(reviewer.tasks.recordEvidence(root.id, attest(epoch, 'tests')), 403, 'forbidden')
    await denied(client(host, 'ci', { 'x-board-can': 'work=read' }).tasks.recordEvidence(root.id, attest(epoch, 'tests')), 403, 'forbidden')
    await denied(worker.as('reviewer').tasks.recordEvidence(root.id, attest(epoch, 'review')), 403, 'forbidden')
    await ci.tasks.recordEvidence(root.id, attest(epoch, 'tests'))
    await denied(claim.complete(undefined, { commit }), 409, 'evidence_required')
    await reviewer.tasks.recordEvidence(root.id, attest(epoch, 'review'))
    await ci.tasks.recordEvidence(root.id, attest(epoch, 'tests', 'fail'))
    await denied(claim.complete(undefined, { commit }), 409, 'evidence_required')
    expect((await read(worker, root.id)).task?.state).toBe('claimed')
    await ci.tasks.recordEvidence(root.id, attest(epoch, 'tests'))
    expect((await worker.tasks.evidence(root.id)).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ gate: 'tests', verdict: 'pass', by: { principal: principal('ci'), actor: principal('ci'), profile: null } })]))
    await denied(claim.complete(undefined, { commit: other }), 409, 'stale_candidate')
    expect((await claim.complete(undefined, { commit })).task?.state).toBe('completed')
    expect((await read(worker, dependent.id)).task?.state).toBe('ready')
  })

  it.each(['browserQA', 'acceptance', 'publication'] as const)('can require %s independently', async (gate) => {
    const { worker, ci, reviewer } = setup({ ...policy, [gate]: true })
    const root = await create(worker)
    const claim = await worker.tasks.claim(root.id)
    await claim.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(root.id, attest(claim.epoch, 'tests'))
    await reviewer.tasks.recordEvidence(root.id, attest(claim.epoch, 'review'))
    expect((await worker.tasks.evidence(root.id)).required).toEqual(['submission', 'tests', 'review', gate])
    await denied(claim.complete(undefined, { commit }), 409, 'evidence_required')
    await reviewer.tasks.recordEvidence(root.id, attest(claim.epoch, gate))
    expect((await claim.complete(undefined, { commit })).task?.state).toBe('completed')
  })

  it('expires both verdicts and overrides and exposes every override in the audit feed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { worker, reviewer, ci, operator } = setup()
    const root = await create(worker)
    const claim = await worker.tasks.claim(root.id)
    const round = claim.epoch
    const waive = { commit, round, gate: 'tests' as const, reason: 'CI offline', expiresAt: expiry(2_000) }
    await denied(operator.tasks.overrideEvidence(root.id, waive), 409, 'stale_candidate')
    await claim.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(root.id, { ...attest(round, 'tests'), expiresAt: expiry(1_000) })
    await reviewer.tasks.recordEvidence(root.id, attest(round, 'review'))
    vi.setSystemTime(Date.now() + 1_000)
    await denied(claim.complete(undefined, { commit }), 409, 'evidence_required')
    await denied(worker.tasks.overrideEvidence(root.id, waive), 403, 'forbidden')
    await operator.tasks.overrideEvidence(root.id, waive)
    vi.setSystemTime(Date.now() + 1_000)
    await denied(claim.complete(undefined, { commit }), 409, 'evidence_required')
    await operator.tasks.overrideEvidence(root.id, { ...waive, reason: 'CI still offline', expiresAt: expiry(5_000) })
    expect((await claim.complete(undefined, { commit })).task?.state).toBe('completed')
    const { events } = await worker.poll({ after: root.id, channel: 'work' })
    const audited = events.filter((event) => event.type === 'task.work_override')
    expect(audited).toMatchObject([
      { payload: { id: root.id, by: { principal: principal('operator') }, gate: 'tests', commit, round, reason: waive.reason, expiresAt: waive.expiresAt } },
      { payload: { reason: 'CI still offline' } },
    ])
    expect((await worker.tasks.evidence(root.id)).overrides).toMatchObject([{ id: audited[1]!.cursor, at: audited[1]!.createdAt }])
  })

  it('does not reuse an earlier round or a submission for an edited root', async () => {
    const { worker, ci, reviewer } = setup()
    const root = await create(worker)
    const first = await worker.tasks.claim(root.id)
    await first.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(root.id, attest(first.epoch, 'tests'))
    await reviewer.tasks.recordEvidence(root.id, attest(first.epoch, 'review'))
    await worker.edit(root.id, 'Ship a different patch')
    expect((await worker.tasks.evidence(root.id)).submission).toBeNull()
    await denied(first.complete(undefined, { commit }), 409, 'evidence_required')
    await first.fail('retry')
    await worker.tasks.reopen(root.id)
    const second = await worker.tasks.claim(root.id)
    await second.submit(commit, artifactRef)
    await denied(ci.tasks.recordEvidence(root.id, attest(first.epoch, 'tests')), 409, 'stale_candidate')
    await denied(second.complete(undefined, { commit }), 409, 'evidence_required')
  })

  it('does not accept evidence for a claim invalidated by a pause', async () => {
    const { worker, ci, reviewer, operator } = setup()
    const root = await create(worker)
    const claim = await worker.tasks.claim(root.id)
    const completed = await create(worker)
    const finished = await worker.tasks.claim(completed.id)
    await finished.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(completed.id, attest(finished.epoch, 'tests'))
    await reviewer.tasks.recordEvidence(completed.id, attest(finished.epoch, 'review'))
    await finished.complete(undefined, { commit })
    await claim.submit(commit, artifactRef)
    await operator.pause('stop work')
    expect((await worker.tasks.evidence(root.id)).submission).toBeNull()
    expect((await worker.tasks.evidence(completed.id)).submission?.commit).toBe(commit)
    await operator.resume('resume work')
    await denied(ci.tasks.recordEvidence(root.id, attest(claim.epoch, 'tests')), 409, 'stale_candidate')
    await denied(claim.submit(commit, artifactRef), 409, 'claim_lost')
    const fresh = await worker.tasks.claim(root.id)
    await fresh.submit(other, artifactRef)
    expect((await worker.tasks.evidence(root.id)).submission?.commit).toBe(other)
  })

  it('requires a release per edge and rechecks expired, superseded, and deleted evidence at every claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { host, worker, ci, operator } = setup({ ...policy, gates: false, releaseDependencies: true })
    const a = await create(worker, undefined, 'proofs')
    const b = await create(worker, undefined, 'proofs')
    const dependent = await create(worker, [a.id, b.id])
    const ap = await worker.tasks.claim(a.id)
    const bp = await worker.tasks.claim(b.id)
    await ap.submit(commit, artifactRef)
    await bp.submit(other, artifactRef)
    await ci.tasks.recordEvidence(a.id, { ...attest(ap.epoch, 'tests'), expiresAt: expiry(5_000) })
    await operator.tasks.overrideEvidence(a.id, { commit, round: ap.epoch, gate: 'review', reason: 'skip review', expiresAt: expiry(60_000) })
    const aWork = await worker.tasks.evidence(a.id)
    const bId = (await worker.tasks.evidence(b.id)).submission!.id
    const aId = aWork.evidence[0]!.id
    await ap.complete(undefined, { commit })
    await bp.complete(undefined, { commit: other })
    const resolve = async (needId: string, evidenceId: string) => ({ needId, evidenceId, ifVersion: (await read(operator, dependent.id)).version })
    expect((await read(worker, dependent.id)).task?.state).toBe('waiting')
    await denied(worker.tasks.claim(dependent.id), 409, 'task_waiting')
    await denied(worker.tasks.resolve(dependent.id, await resolve(a.id, aId)), 403, 'forbidden')
    const narrowed = client(host, 'operator', { 'x-board-can': 'work=manage' })
    await denied(narrowed.tasks.resolve(dependent.id, await resolve(a.id, aId)), 404, 'need_not_found')
    await denied(operator.tasks.resolve(dependent.id, await resolve(a.id, aWork.overrides[0]!.id)), 409, 'invalid_evidence')
    await denied(operator.tasks.resolve(dependent.id, await resolve(a.id, bId)), 409, 'invalid_evidence')
    const releaseA = await resolve(a.id, aId)
    expect((await operator.tasks.resolve(dependent.id, releaseA)).task?.state).toBe('waiting')
    await denied(operator.tasks.resolve(dependent.id, releaseA), 409, 'stale_task')
    expect((await operator.tasks.resolve(dependent.id, await resolve(b.id, bId))).task?.state).toBe('ready')
    expect((await narrowed.tasks.evidence(dependent.id)).releases).toEqual([])
    expect((await operator.tasks.evidence(dependent.id)).releases).toEqual([{ needId: a.id, evidenceId: aId }, { needId: b.id, evidenceId: bId }])
    const held = await worker.tasks.claim(dependent.id)
    vi.setSystemTime(Date.now() + 5_000)
    await denied(held.renew(), 409, 'task_waiting')
    await denied(held.complete(), 409, 'task_waiting')
    await held.release()
    await denied(worker.tasks.claim(dependent.id), 409, 'task_waiting')
    expect(await worker.tasks.claim({ channel: 'work' })).toBeNull()
    await worker.tasks.priority(dependent.id, 'urgent')
    const fallback = (await worker.tasks.create('work', { text: 'Still eligible', priority: 'low' })).task
    const fallbackClaim = await worker.tasks.claim({ channel: 'work' })
    expect(fallbackClaim?.task.id).toBe(fallback.id)
    await fallbackClaim!.release()
    const reattest = async (verdict: 'pass' | 'fail') => {
      await ci.tasks.recordEvidence(a.id, attest(ap.epoch, 'tests', verdict))
      return (await worker.tasks.evidence(a.id)).evidence[0]!.id
    }
    const next = await reattest('pass')
    await denied(operator.tasks.resolve(dependent.id, await resolve(a.id, aId)), 409, 'invalid_evidence')
    await operator.tasks.resolve(dependent.id, await resolve(a.id, next))
    const byQueue = await worker.tasks.claim({ channel: 'work' })
    expect(byQueue?.task.id).toBe(dependent.id)
    await reattest('fail')
    await denied(byQueue!.submit(commit, artifactRef), 409, 'task_waiting')
    await byQueue!.release()
    await denied(worker.tasks.claim(dependent.id), 409, 'task_waiting')
    await operator.tasks.resolve(dependent.id, await resolve(a.id, await reattest('pass')))
    await worker.delete(b.id)
    await denied(worker.tasks.claim(dependent.id), 409, 'task_waiting')
    await denied(operator.tasks.resolve(dependent.id, await resolve(b.id, bId)), 404, 'need_not_found')
  })

  it('keeps unconfigured boards unchanged and runs the advertised conformance checks', async () => {
    const legacy = testBoard()
    const worker = client(legacy, 'worker')
    expect((await worker.discovery()).workEvidence).toBeUndefined()
    const root = await create(worker)
    await denied(worker.tasks.evidence(root.id), 501, 'no_work_evidence')
    expect((await (await worker.tasks.claim(root.id)).complete()).task?.state).toBe('completed')
    for (const config of [policy, { gates: false, releaseDependencies: true }, { ...policy, releaseDependencies: true }]) {
      const { worker } = setup(config)
      const report = await conformance(worker)
      expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
      expect(report.checks.filter((check) => check.group === 'work-evidence').map((check) => check.status)).toEqual(config.gates === false ? ['skipped', 'passed'] : ['passed', 'skipped'])
      expect(report.checks.filter((check) => check.group === 'tasks')).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: expect.stringMatching(/^fences what a claim does/), status: 'passed' }),
        expect.objectContaining({ name: expect.stringMatching(/^refuses a change of needs/), status: 'passed' }),
      ]))
    }
  }, 20_000)

  it('reads submission, evidence and override audit after reopening a SQLite board', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'board-evidence-'))
    const backend = () => local({ dir, workEvidence: { operators: ['board:client'], attesters: { tests: ['board:client'] } } })
    const first = backend()
    const second = backend()
    try {
      const team = board({ backend: first })
      const { task } = await team.tasks.create('work', 'publish')
      const claim = await team.tasks.claim(task.id)
      await claim.submit(commit, artifactRef)
      await team.tasks.recordEvidence(task.id, attest(claim.epoch, 'tests'))
      await team.tasks.overrideEvidence(task.id, { commit, round: claim.epoch, gate: 'review', reason: 'review exempt', expiresAt: expiry(60_000) })
      await claim.complete(undefined, { commit })
      const before = await team.tasks.evidence(task.id)
      await first.close()
      const reopened = board({ backend: second })
      expect(await reopened.tasks.evidence(task.id)).toEqual(before)
      const { events } = await reopened.poll({ channel: 'work', after: task.id })
      expect(events.filter((event) => event.type === 'task.work_override')).toMatchObject([{ cursor: before.overrides[0]!.id, payload: { reason: 'review exempt' } }])
    } finally {
      await first.close()
      await second.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
