import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardEventView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { oidcTokens } from '../src/access/index.ts'
import type { AttestationGate, EvidencePolicy } from '../src/contract/evidence.ts'
import { conformance } from '../src/conformance/index.ts'
import { HttpError } from '../src/server/index.ts'
import { memory } from '../src/store/memory.ts'
import { sqlite } from '../src/store/sqlite.ts'
import { board, BOARD_URL, caller, personToken, testAuth, testBoard } from './harness.ts'

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
  it('returns the same error for unreadable non-tasks and missing IDs on every evidence write', async () => {
    const { host, worker } = setup({ ...policy, releaseDependencies: true })
    const hidden = await worker.post('private', 'private note')
    const visible = await worker.post('work', 'ordinary note')
    const write = caller(host.fetch, await personToken('u_operator'), { 'x-board-can': 'work=manage' })
    const operations = {
      submit: { epoch: 1, token: 'A'.repeat(43), commit, artifactRef },
      evidence: attest(1, 'tests'),
      override: { commit, round: 1, gate: 'tests', reason: 'CI offline', expiresAt: expiry(60_000) },
      resolve: { needId: visible.id, evidenceId: '1', ifVersion: visible.version },
    }
    for (const [path, body] of Object.entries(operations)) {
      for (const [id, code] of [[hidden.id, 'message_not_found'], ['999999', 'message_not_found'], [visible.id, 'not_a_task']]) {
        const response = await write('POST', `/work/v1/tasks/${id}/${path}`, body)
        expect(response.status, path).toBe(404)
        expect(response.body, path).toMatchObject({ error: { code } })
      }
    }
  })

  it('wakes a local channel watcher on all four work evidence events, as shown in the feed', async () => {
    const seen: BoardEventView[] = []
    const isWorkEvent = (event: BoardEventView) => event.type.startsWith('task.work_')
    const host = testBoard({
      workEvidence: { ...policy, releaseDependencies: true },
      watch: { audit: { tail: 'work', run: ({ event }) => { if (isWorkEvent(event)) seen.push(event) } } },
    })
    const worker = client(host, 'worker')
    const ci = client(host, 'ci')
    const operator = client(host, 'operator')
    const need = await create(worker)
    const dependent = await create(worker, [need.id])
    const claim = await worker.tasks.claim(need.id)
    await claim.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(need.id, attest(claim.epoch, 'tests'))
    await operator.tasks.overrideEvidence(need.id, { commit, round: claim.epoch, gate: 'review', reason: 'approved exception', expiresAt: expiry(60_000) })
    await claim.complete(undefined, { commit })
    const [record] = (await worker.tasks.evidence(need.id)).evidence
    await operator.tasks.resolve(dependent.id, { needId: need.id, evidenceId: record!.id, ifVersion: dependent.version })

    const { events } = await worker.poll({ channel: 'work', after: need.id })
    const evidenceEvents = events.filter(isWorkEvent)
    expect(evidenceEvents.map(({ type, message }) => [type, message?.id])).toEqual([
      ['task.work_submitted', need.id],
      ['task.work_evidence', need.id],
      ['task.work_override', need.id],
      ['task.work_resolved', dependent.id],
    ])
    await vi.waitFor(() => expect(seen).toEqual(expect.arrayContaining(evidenceEvents)))
  })

  it('rejects discovery returned for an evidence read by an older HTTP board', async () => {
    const legacy = testBoard()
    // Older mounts return discovery for an unknown GET, including the evidence path.
    const worker = client({ fetch: () => legacy.fetch(new Request(BOARD_URL)) }, 'worker')
    expect((await worker.discovery()).workEvidence).toBeUndefined()
    await expect(worker.tasks.evidence('1')).rejects.toMatchObject({
      status: 501, code: 'no_work_evidence', message: expect.stringMatching(/work evidence/),
    })
  })

  it.each([false, true])('does not complete with a commit on a legacy HTTP board (stale discovery: %s)', async (staleDiscovery) => {
    const legacy = testBoard()
    const advertised = testBoard({ workEvidence: policy })
    const worker = client({
      async fetch(request) {
        const path = new URL(request.url).pathname.slice(new URL(BOARD_URL).pathname.length)
        if (path === '' && staleDiscovery) return advertised.fetch(request)
        if (path.startsWith('/work/')) return Response.json({ error: { code: 'not_found', message: 'no route' } }, { status: 404 })
        if (request.method === 'POST' && /^\/tasks\/[^/]+\/complete$/.test(path)) {
          // The pre-evidence schema strips fields it does not know.
          const { commit: _ignored, ...body } = await request.json()
          request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
        }
        return legacy.fetch(request)
      },
    }, 'worker')
    const root = await create(worker)
    const claim = await worker.tasks.claim(root.id)
    await expect(claim.complete(undefined, { commit })).rejects.toMatchObject({
      status: 501, code: 'no_work_evidence', origin: 'handle', hint: expect.stringMatching(/upgrade the board/i),
    })
    expect((await read(worker, root.id)).task?.state).toBe('claimed')
    expect((await claim.complete()).task?.state).toBe('completed')
  })

  it('returns 501 for all five work evidence methods on a custom backend that omits them', async () => {
    const base = local({ memory: true })
    const { workEvidence, submitWork, recordEvidence, overrideEvidence, resolveWorkEdge, ...backend } = base
    const host = board({ backend, authenticate: oidcTokens(testAuth), url: BOARD_URL })
    try {
      const worker = client(host, 'worker')
      const root = await create(worker)
      const claim = await worker.tasks.claim(root.id)
      await denied(worker.tasks.evidence(root.id), 501, 'no_work_evidence')
      await denied(claim.submit(commit, artifactRef), 501, 'no_work_evidence')
      await denied(worker.tasks.recordEvidence(root.id, attest(claim.epoch, 'tests')), 501, 'no_work_evidence')
      await denied(worker.tasks.overrideEvidence(root.id, { commit, round: claim.epoch, gate: 'tests', reason: 'CI offline', expiresAt: expiry(60_000) }), 501, 'no_work_evidence')
      await denied(worker.tasks.resolve(root.id, { needId: '1', evidenceId: '1', ifVersion: root.version }), 501, 'no_work_evidence')
      expect((await claim.complete()).task?.state).toBe('completed')
    } finally {
      await base.close()
    }
  })

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
    const { host, worker, reviewer, ci, operator } = setup()
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
    const narrowed = client(host, 'operator', { 'x-board-can': 'work=read,post;elsewhere=manage' })
    await denied(narrowed.tasks.overrideEvidence(root.id, waive), 403, 'forbidden')
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

  it.each(['memory', 'SQLite'])('rejects evidence that expires while completion waits to append (%s)', async (adapter) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const dir = await mkdtemp(join(tmpdir(), 'board-evidence-expiry-'))
    const store = adapter === 'memory' ? memory() : sqlite({ path: join(dir, 'board.db') })
    const host = testBoard({ workEvidence: policy, store })
    const worker = client(host, 'worker')
    const ci = client(host, 'ci')
    const reviewer = client(host, 'reviewer')
    const append = store.log.append.bind(store.log)
    try {
      const root = await create(worker)
      const dependent = await create(worker, [root.id])
      const claim = await worker.tasks.claim(root.id)
      await claim.submit(commit, artifactRef)
      const expiresAt = expiry(1_000)
      await ci.tasks.recordEvidence(root.id, { ...attest(claim.epoch, 'tests'), expiresAt })
      await reviewer.tasks.recordEvidence(root.id, attest(claim.epoch, 'review'))
      // Time passes at the storage boundary, without any other write moving the log head.
      store.log.append = (session, events, options) => {
        if (events.some((event) => event.type === 'task.completed')) vi.setSystemTime(Date.parse(expiresAt))
        return append(session, events, options)
      }
      await denied(claim.complete(undefined, { commit }), 409, 'evidence_required')
      expect((await read(worker, root.id)).task?.state).toBe('claimed')
      expect((await read(worker, dependent.id)).task?.state).toBe('waiting')
      await ci.tasks.recordEvidence(root.id, attest(claim.epoch, 'tests'))
      expect((await claim.complete(undefined, { commit })).task?.state).toBe('completed')
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
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

  it('cannot complete a reclaimed, unedited task using the previous claim’s verdicts', async () => {
    const { worker, ci, reviewer } = setup()
    const root = await create(worker)
    const first = await worker.tasks.claim(root.id)
    await first.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(root.id, attest(first.epoch, 'tests'))
    await reviewer.tasks.recordEvidence(root.id, attest(first.epoch, 'review'))
    await first.release()

    const second = await worker.tasks.claim(root.id)
    await denied(second.complete(undefined, { commit }), 409, 'evidence_required')
    expect((await worker.tasks.evidence(root.id)).submission).toBeNull()
    await second.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(root.id, attest(second.epoch, 'tests'))
    await reviewer.tasks.recordEvidence(root.id, attest(second.epoch, 'review'))
    expect((await second.complete(undefined, { commit })).task?.state).toBe('completed')
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
    const manageNeedOnly = client(host, 'operator', { 'x-board-can': 'work=read,post;proofs=manage' })
    await denied(manageNeedOnly.tasks.resolve(dependent.id, await resolve(a.id, aId)), 403, 'forbidden')
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
    expect(await worker.tasks.claim({ channel: 'work' })).toBeNull()
    expect((await read(worker, fallback.id)).task?.state).toBe('ready')
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

  it.each(['claim', 'renew', 'claim-next'])('treats an unreadable release prerequisite as missing on %s', async (operation) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { host, worker, ci, operator } = setup({ ...policy, gates: false, releaseDependencies: true })
    const prerequisite = await create(worker, undefined, 'proofs')
    const dependent = await create(worker, [prerequisite.id])
    const source = await worker.tasks.claim(prerequisite.id)
    await source.submit(commit, artifactRef)
    const expiresAt = expiry(5_000)
    await ci.tasks.recordEvidence(prerequisite.id, { ...attest(source.epoch, 'tests'), expiresAt })
    await source.complete()
    const [record] = (await worker.tasks.evidence(prerequisite.id)).evidence
    await operator.tasks.resolve(dependent.id, { needId: prerequisite.id, evidenceId: record!.id, ifVersion: dependent.version })
    const held = await worker.tasks.claim(dependent.id)
    if (operation !== 'renew') await held.release()

    const narrowed = caller(host.fetch, await personToken('u_worker'), { 'x-board-can': 'work=read,label' })
    const attempt = async () => {
      const { status, body } = operation === 'claim-next' ? await narrowed('POST', '/tasks/claim', { channel: 'work' }) :
        await narrowed('POST', `/tasks/${dependent.id}/${operation}`, operation === 'renew' ? { epoch: held.epoch, token: held.token } : {})
      return { status, body }
    }
    const current = await attempt()
    vi.setSystemTime(Date.parse(expiresAt))
    const expired = await attempt()
    await worker.delete(prerequisite.id)
    const missing = await attempt()
    expect(missing).toMatchObject(operation === 'claim-next' ? { status: 200, body: { task: null } } : { status: 409, body: { error: { code: 'task_waiting' } } })
    expect(current).toEqual(missing)
    expect(expired).toEqual(missing)
  })

  it('does not walk a readable completed chain when adding a prerequisite with evidence releases enabled', async () => {
    const worker = testBoard({ workEvidence: { gates: false, releaseDependencies: true, resolvers: ['board:client'] } })
    let last: { id: string; evidenceId: string } | undefined
    // The documented cycle-walk limit is 500 tasks.
    for (let step = 0; step <= 500; step++) {
      const task = await create(worker, last ? [last.id] : undefined, 'proofs')
      if (last) await worker.tasks.resolve(task.id, { needId: last.id, evidenceId: last.evidenceId, ifVersion: task.version })
      const claim = await worker.tasks.claim(task.id)
      await claim.submit(commit, artifactRef)
      await claim.complete()
      last = { id: task.id, evidenceId: (await worker.tasks.evidence(task.id)).submission!.id }
    }
    const recent = await create(worker, [last!.id])
    const root = await create(worker)
    expect((await worker.tasks.needs(root.id, [recent.id])).task).toMatchObject({ state: 'waiting', needs: [recent.id] })

    // Without access to the chain, the cycle walk still follows it, completed or not.
    const narrowed = client(worker, 'worker', { 'x-board-can': 'work=manage' })
    const another = await create(narrowed)
    await denied(narrowed.tasks.needs(another.id, [recent.id]), 400, 'invalid_needs')
  }, 60_000)

  it('returns a failed task to waiting when its evidence release has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { worker, ci, operator } = setup({ ...policy, gates: false, releaseDependencies: true })
    const prerequisite = await create(worker)
    const dependent = await create(worker, [prerequisite.id])
    const claim = await worker.tasks.claim(prerequisite.id)
    await claim.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(prerequisite.id, { ...attest(claim.epoch, 'tests'), expiresAt: expiry(5_000) })
    await claim.complete()
    const [record] = (await worker.tasks.evidence(prerequisite.id)).evidence
    await operator.tasks.resolve(dependent.id, { needId: prerequisite.id, evidenceId: record!.id, ifVersion: dependent.version })
    await (await worker.tasks.claim(dependent.id)).fail('retry later')
    vi.setSystemTime(Date.now() + 5_000)
    expect((await worker.tasks.reopen(dependent.id)).task?.state).toBe('waiting')
    await denied(worker.tasks.claim(dependent.id), 409, 'task_waiting')
  })

  it('keeps a bound claim subject to the evidence gate after an operator parks the task', async () => {
    const { worker, ci, reviewer, operator } = setup()
    expect(await worker.discovery()).toMatchObject({ task_authority: true, workEvidence: { version: 1 } })
    const root = await create(worker)
    const owner = { principal: principal('worker'), actor: principal('worker') }
    const binding = { owner, controller: owner, provider: 'test', model: 'test', session: 'first', branch: 'topic/evidence', worktree: '/workspace', baseCommit: commit }
    const claim = await worker.tasks.claim(root.id, { binding })
    await claim.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(root.id, attest(claim.epoch, 'tests'))
    await reviewer.tasks.recordEvidence(root.id, attest(claim.epoch, 'review'))
    await operator.tasks.park(root.id, 'hold for maintenance')
    expect((await worker.tasks.evidence(root.id)).submission).toBeNull()
    await denied(claim.complete(undefined, { commit }), 409, 'claim_lost')
    await operator.tasks.unpark(root.id, 'resume work')
    const fresh = await worker.tasks.claim(root.id, { binding: { ...binding, session: 'second' } })
    await fresh.submit(commit, artifactRef)
    await denied(fresh.complete(undefined, { commit }), 409, 'evidence_required')
    await ci.tasks.recordEvidence(root.id, attest(fresh.epoch, 'tests'))
    await reviewer.tasks.recordEvidence(root.id, attest(fresh.epoch, 'review'))
    expect((await fresh.complete(undefined, { commit })).task?.state).toBe('completed')
  })

  it('keeps unconfigured boards unchanged and runs the advertised conformance checks', async () => {
    const legacy = testBoard()
    const worker = client(legacy, 'worker')
    expect((await worker.discovery()).workEvidence).toBeUndefined()
    const root = await create(worker)
    await denied(worker.tasks.evidence(root.id), 501, 'no_work_evidence')
    expect((await (await worker.tasks.claim(root.id)).complete()).task?.state).toBe('completed')
    for (const config of [policy, { gates: false, releaseDependencies: true, resolvers: [principal('worker')] }, { ...policy, releaseDependencies: true }]) {
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

  it('fails work-evidence conformance when an advertised explicit release returns 501', async ({ onTestFinished }) => {
    const base = local({ memory: true, workEvidence: { gates: false, releaseDependencies: true, resolvers: [principal('worker')] } })
    onTestFinished(() => base.close())
    const host = board({
      backend: {
        ...base,
        async resolveWorkEdge() {
          throw new HttpError(501, 'no_work_evidence', 'explicit release is not implemented')
        },
      },
      authenticate: oidcTokens(testAuth), url: BOARD_URL,
    })
    const report = await conformance(client(host, 'worker'))
    expect(report.checks.filter((check) => check.status === 'failed')).toMatchObject([
      { group: 'work-evidence', detail: expect.stringContaining('explicit release is not implemented') },
    ])
    expect(report.ok).toBe(false)
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
