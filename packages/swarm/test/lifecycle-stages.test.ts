import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { block, board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { BOARD_URL, caller, localUserToken, testLocal } from '../../board/test/tokens.ts'
import { createStageService, type Dispatcher, type Evidence, type Gate, type Role, type Stage } from '../src/lifecycle/index.ts'

const A = 'a'.repeat(40), B = 'b'.repeat(40)
const checks = { intake_missing: true, scope_missing: true, outcomes_invalid: true, dependency_unavailable: true,
  scope_stale: true, waiting_on: true, admission_refused: true, claim_missing: true, binding_missing: true,
  claim_lost: true, handoff_missing: true, outcome_missing: true, head_changed: true, fix_limit: true, attempt_end_missing: true }
async function fixture(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const { principal } = await team.me()
  const state = { commit: A, handoffId: 'handoff-a', now: 100 }
  const landed: Parameters<Dispatcher['landed']>[0][] = []
  // Stand-in for party roles, artifact verification and settlement, not for the board.
  const dispatcher: Dispatcher = {
    inspect: async (_, { actor }) => ({ role: actor as Role, checks, commit: state.commit, claimCutoff: 1000,
      handoffId: state.handoffId, enabled: ['publication'], prerequisite: false }),
    attest: async () => 'verified-ci', jockey: async () => 'verified-jockey', landed: async move => { landed.push(move) },
  }
  const serviceFor = (handle = team) => createStageService({ board: handle, principal, dispatcher, now: () => state.now })
  const service = serviceFor()
  await service.registerSchemas()
  async function root() {
    const { task: { id } } = await team.tasks.create('work/stages', { text: 'fixture', noSync: true })
    const thread = () => team.thread(id, { limit: 100 })
    const labels = async () => (await thread()).message.labels
    const move = (to: Stage, actor: Role, reason?: string) => service.move(id, to, { actor, ...(reason && { reason }) })
    const draft = (gate: Gate, round = 1, commit = state.commit) => ({ partyId: 'party', gate, round, commit, expiresAt: 200 })
    const attest = (gate: Gate, verdict: 'pass' | 'fail' = 'pass', binding = draft(gate)) =>
      service.admitEvidence(id, { ...binding, verdict, artifactRef: { attachmentId: 'artifact', sha256: 'f'.repeat(64) } })
    async function enterReview(round = 1) {
      assert.deepEqual(await move('implementing', 'dispatcher'), { ok: true, round })
      await attest('submission', 'pass', draft('submission', round))
      assert.deepEqual(await move('review', 'dispatcher'), { ok: true, round })
    }
    async function scope() {
      for (const [to, role] of [['proposed', 'dispatcher'], ['scoped', 'scoper']] as const) assert.deepEqual(await move(to, role), { ok: true, round: 1 })
    }
    async function readyForApproval() {
      await scope(); await enterReview(); await attest('tests'); await attest('review'); await attest('publication')
    }
    return { id, thread, labels, move, draft, attest, enterReview, scope, readyForApproval }
  }
  return { team, principal, state, service, serviceFor, root, dispatcher, landed }
}

// Design §3, independent of the implementation's move table.
const exits = {
  new: ['proposed'], proposed: ['scoped', 'rejected', 'canceled'], scoped: ['implementing', 'proposed', 'rejected', 'canceled'],
  implementing: ['review', 'repair', 'proposed', 'rejected', 'canceled'], review: ['approved', 'repair', 'proposed', 'rejected', 'canceled'],
  approved: ['done', 'repair', 'proposed', 'rejected', 'canceled'], repair: ['implementing', 'proposed', 'rejected', 'canceled'],
  rejected: ['proposed', 'canceled'], done: [], canceled: [],
} satisfies Record<Stage | 'new', Stage[]>
const roles: Role[] = ['dispatcher', 'scoper', 'reviewer', 'qa', 'service', 'jockey']
const forward = { new: 'proposed', proposed: 'scoped', scoped: 'implementing', implementing: 'review', review: 'approved',
  approved: 'done', repair: 'implementing', rejected: 'proposed', done: 'proposed', canceled: 'proposed' } as const
function mulberry32(seed: number) {
  return () => {
    let n = seed = (seed + 0x6d2b79f5) | 0
    n = Math.imul(n ^ n >>> 15, n | 1)
    n ^= n + Math.imul(n ^ n >>> 7, n | 61)
    return ((n ^ n >>> 14) >>> 0) / 2 ** 32
  }
}

test('illegal or ungated moves do not land and refused moves do not change labels', async t => {
  const { root, service, state } = await fixture(t)
  const seeds = process.env.SWARM_SEED === undefined
    ? Array.from({ length: Number(process.env.SWARM_SEEDS ?? 100) }, (_, i) => i) : [Number(process.env.SWARM_SEED)]
  for (const seed of new Set([...seeds, 13, 66, 215, 257])) {
    const rng = mulberry32(seed), trace: unknown[] = []
    const pick = <T,>(values: readonly T[]) => values[Math.floor(rng() * values.length)]!
    try {
      const r = await root(), evidence: Evidence[] = []
      state.commit = A
      let stage: Stage | 'new' = 'new', round = 0, head: string | null = null
      for (let i = 0; i < 24; i++) {
        const to: Stage = rng() < .7 ? forward[stage] : pick(Object.keys(forward).slice(1) as Stage[])
        const actor = rng() < .7 ? (['implementing', 'review'].includes(to) || stage === 'new' ? 'dispatcher' : 'scoper') : pick(roles)
        const reason = pick([undefined, 'retry after finding', ' '])
        if (rng() < .15) state.commit = state.commit === A ? B : A
        const step = { stage, round, to, actor, reason, commit: state.commit, evidence: null as Evidence | null }
        trace.push(step)
        if (round && rng() < .8) {
          const gate: Gate = stage === 'implementing' ? 'submission' : pick(['tests', 'review', 'publication'])
          const binding = r.draft(gate, round, rng() < .15 ? (state.commit === A ? B : A) : state.commit)
          const latest: Evidence | undefined = evidence.findLast(e => e.round === round && e.gate === gate && e.commit === binding.commit)
          const record = gate !== 'submission' && latest?.kind === 'attestation' && rng() < .25
            ? await service.override(r.id, { ...binding, who: 'jockey', reason: 'fixture waiver' })
            : await r.attest(gate, rng() < .8 ? 'pass' : 'fail', binding)
          evidence.push(step.evidence = record)
        }
        const before = JSON.stringify(await r.labels())
        const result = await r.move(to, actor, reason)
        trace.push(result)
        const { message, replies } = await r.thread()
        if (!result.ok) { assert.equal(JSON.stringify(message.labels), before); continue }
        const next = message.labels['work.move']
        const receipt = replies.find(reply => reply.id === next)?.blocks.find(b => b.schema === 'swarm-move')?.data
        assert.ok(next && next !== head && receipt)
        const landed = receipt.to as Stage
        assert.equal(landed, to)
        assert.ok((exits[stage] as Stage[]).includes(landed), `${stage} -> ${landed}`)
        assert.equal(receipt.previous, head)
        assert.equal(receipt.from, stage === 'new' ? null : stage)
        assert.equal(receipt.commit, state.commit)
        if (landed === 'approved' || landed === 'done') for (const gate of ['tests', 'review']) {
          const latest: Evidence | undefined = evidence.findLast(e => e.taskId === r.id && e.round === round && e.commit === receipt.commit && e.gate === gate)
          assert.ok(latest && latest.expiresAt > state.now && (latest.kind === 'override' || latest.verdict === 'pass'), gate)
        }
        round += Number(stage === 'new' || landed === 'repair' || landed === 'proposed')
        assert.equal(receipt.round, round)
        assert.equal(message.labels['work.round'], String(round))
        assert.equal(message.labels['work.stage'], landed)
        stage = landed; head = next
      }
    } catch (error) { t.diagnostic(`SWARM_SEED=${seed} trace=${JSON.stringify(trace)}`); throw error }
  }
})

test('two racing stage writers cannot both land from the same state', { timeout: 5000 }, async t => {
  const { team, root, serviceFor } = await fixture(t), r = await root()
  const concurrent = Promise.withResolvers<void>(); let arrivals = 0
  // Delay both public label requests in transit, then let the real board decide both.
  const handle = { ...team, async label(...args: Parameters<typeof team.label>) {
    if (++arrivals === 2) concurrent.resolve()
    await concurrent.promise
    return team.label(...args)
  } }
  const results = await Promise.all([serviceFor(handle), serviceFor(handle)].map(s => s.move(r.id, 'proposed', { actor: 'dispatcher' })))
  assert.deepEqual(results.filter(result => result.ok), [{ ok: true, round: 1 }])
  assert.deepEqual(results.filter(result => !result.ok), [{ ok: false, reason: 'stage_conflict' }])
  const winner = (await r.labels())['work.move']
  assert.equal((await r.move('scoped', 'scoper')).ok, true)
  const { message, replies } = await r.thread()
  const receipt = (id: unknown) => replies.find(reply => reply.id === id)?.blocks[0]?.data
  assert.equal(receipt(message.labels['work.move'])?.to, 'scoped')
  assert.equal(receipt(message.labels['work.move'])?.previous, winner)
  assert.equal(receipt(winner)?.to, 'proposed'); assert.equal(receipt(winner)?.previous, null)
})

test('a review pass posted by another principal does not open the gate', async t => {
  const { team, root, principal } = await fixture(t), r = await root()
  await r.scope(); await r.enterReview(); await r.attest('tests')
  const record = await r.attest('review', 'fail')
  const outsider = caller(team.fetch, await localUserToken('outsider'))
  const text = block('swarm-evidence@1', { ...record, id: crypto.randomUUID(), verdict: 'pass' })
  const { status, body } = await outsider('POST', '/messages', { re: r.id, text, noSync: true })
  assert.ok(status >= 200 && status < 300, `outsider reply: ${status}`)
  const forged = (await r.thread()).replies.find(reply => reply.id === body.message.id)
  assert.ok(forged && forged.by.principal !== principal)
  assert.equal(forged.blocks[0]?.data.verdict, 'pass')
  assert.deepEqual(await r.move('approved', 'scoper'), { ok: false, reason: 'gate_closed', gate: 'review', status: 'fail' })
})

test('an override cannot replace submission or outlive its candidate or a later verdict', async t => {
  const { team, root, service, state } = await fixture(t), r = await root()
  await r.scope(); assert.equal((await r.move('implementing', 'dispatcher')).ok, true)
  const input = { ...r.draft('review'), who: 'jockey', reason: 'confirmed manually' }
  for (const patch of [{ who: '' }, { reason: ' ' }, { gate: 'submission' as const }]) {
    await assert.rejects(service.override(r.id, { ...input, ...patch }), /invalid evidence/)
  }
  // Even a service-authored submission waiver already on the board cannot substitute for a pass.
  const { artifactRef: _, verdict: __, ...submission } = await r.attest('submission', 'fail') as Extract<Evidence, { kind: 'attestation' }>
  await team.reply(r.id, { noSync: true, text: block('swarm-evidence@1', { ...submission, id: crypto.randomUUID(), kind: 'override', reason: input.reason }) })
  assert.deepEqual(await r.move('review', 'dispatcher'), { ok: false, reason: 'submission_missing' })
  await r.attest('submission'); assert.equal((await r.move('review', 'dispatcher')).ok, true)
  await r.attest('tests'); await r.attest('review', 'fail')
  const waive = () => service.override(r.id, input)
  const waiver = await waive()
  const receipt = (await r.thread()).replies.flatMap(reply => reply.blocks).find(b => b.data.id === waiver.id)
  assert.equal(receipt?.data.author, 'verified-jockey'); assert.equal(receipt?.data.reason, input.reason)
  assert.equal((await r.move('approved', 'scoper')).ok, true)
  await r.attest('review', 'fail')
  assert.deepEqual(await r.move('done', 'scoper'), { ok: false, reason: 'gate_closed', gate: 'review', status: 'fail' })
  await waive()
  state.commit = B
  await r.attest('submission'); await r.attest('tests')
  assert.deepEqual(await r.move('done', 'scoper'), { ok: false, reason: 'head_changed' })
  assert.deepEqual(await r.move('repair', 'reviewer', 'new finding'), { ok: false, reason: 'head_changed' })
  state.commit = A
  assert.deepEqual(await r.move('repair', 'reviewer', 'new finding'), { ok: true, round: 2 })
  await r.enterReview(2); await r.attest('tests', 'pass', r.draft('tests', 2))
  assert.deepEqual(await r.move('approved', 'scoper'), { ok: false, reason: 'gate_closed', gate: 'review', status: 'missing' })
})

test('a newer fail, stale commit, expired pass or missing publication blocks a forward move', async t => {
  const { root, state } = await fixture(t), r = await root()
  await r.scope(); await r.enterReview(); await r.attest('tests'); await r.attest('review'); await r.attest('review', 'fail')
  const blocked = (gate: Gate, status: string) => ({ ok: false, reason: 'gate_closed', gate, status })
  assert.deepEqual(await r.move('approved', 'scoper'), blocked('review', 'fail'))
  await r.attest('review')
  state.commit = B
  await r.attest('submission'); await r.attest('tests')
  assert.deepEqual(await r.move('approved', 'scoper'), { ok: false, reason: 'head_changed' })
  state.commit = A
  await r.attest('review', 'pass', { ...r.draft('review'), expiresAt: 300 })
  assert.equal((await r.move('approved', 'scoper')).ok, true)
  assert.deepEqual(await r.move('done', 'scoper'), { ...blocked('publication', 'missing'), reason: 'release_gate_closed' })
  await r.attest('publication', 'pass', { ...r.draft('publication'), expiresAt: 300 })
  state.now = 200
  await r.attest('submission', 'pass', { ...r.draft('submission'), expiresAt: 300 })
  assert.deepEqual(await r.move('done', 'scoper'), blocked('tests', 'expired'))
  assert.equal((await r.labels())['work.stage'], 'approved')
  await r.attest('tests', 'pass', { ...r.draft('tests'), expiresAt: 300 })
  assert.equal((await r.move('done', 'scoper')).ok, true)
  assert.equal((await r.labels())['work.stage'], 'done')
})

test('passes for a replacement commit cannot complete an approved candidate', async t => {
  const { root, state } = await fixture(t), r = await root()
  await r.readyForApproval()
  assert.equal((await r.move('approved', 'scoper')).ok, true)
  state.commit = B; state.handoffId = 'handoff-b'
  for (const gate of ['submission', 'tests', 'review', 'publication'] as const) await r.attest(gate)
  const before = await r.labels()
  assert.deepEqual(await r.move('done', 'scoper'), { ok: false, reason: 'head_changed' })
  assert.deepEqual(await r.labels(), before)
})

test('missing enabled or prerequisite facts cannot land approval or completion', async t => {
  const { root, dispatcher } = await fixture(t), r = await root()
  await r.readyForApproval()
  const inspect = dispatcher.inspect
  for (const to of ['approved', 'done'] as const) {
    for (const missing of ['enabled', 'prerequisite'] as const) {
      // @ts-expect-error Deliberately exercise an invalid adapter at runtime.
      dispatcher.inspect = async (...args) => {
        const { enabled, prerequisite, ...rest } = (await inspect(...args))!
        return missing === 'enabled' ? { ...rest, prerequisite } : { ...rest, enabled }
      }
      assert.deepEqual(await r.move(to, 'scoper'), { ok: false, reason: 'gate_closed' })
    }
    dispatcher.inspect = inspect
    if (to === 'approved') assert.equal((await r.move(to, 'scoper')).ok, true)
  }
})

test('a newer fail from another service invalidates the final move CAS', { timeout: 5000 }, async t => {
  const { root, serviceFor, dispatcher } = await fixture(t), r = await root()
  await r.readyForApproval()
  const inspect = dispatcher.inspect
  const atFinal = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let checks = 0
  dispatcher.inspect = async (...args) => {
    const facts = await inspect(...args)
    if (++checks === 2) { atFinal.resolve(); await release.promise }
    return facts
  }
  const moving = r.move('approved', 'scoper')
  await atFinal.promise
  const before = await r.labels()
  try {
    await serviceFor().admitEvidence(r.id, { ...r.draft('review'), verdict: 'fail',
      artifactRef: { attachmentId: 'artifact', sha256: 'f'.repeat(64) } })
  } finally { release.resolve() }
  assert.deepEqual(await moving, { ok: false, reason: 'stage_conflict' })
  assert.deepEqual(await r.labels(), { ...before, 'work.ev': String(Number(before['work.ev']) + 1) })
})

test('an edited or deleted landed receipt cannot authorize the next move', async t => {
  const { team, root } = await fixture(t)
  for (const tamper of [async (id: string, text: string) => team.edit(id, `${text}\nEdited`), (id: string) => team.delete(id)]) {
    const r = await root()
    assert.equal((await r.move('proposed', 'dispatcher')).ok, true)
    const before = await r.labels()
    const receipt = (await r.thread()).replies.find(reply => reply.id === before['work.move'])!
    await tamper(receipt.id, receipt.text)
    assert.deepEqual(await r.move('scoped', 'scoper'), { ok: false, reason: 'stage_conflict' })
    assert.deepEqual(await r.labels(), before)
  }
})

test('cancel, rejection and reopen cannot skip or duplicate dispatcher settlement', async t => {
  const { root, landed, dispatcher } = await fixture(t), r = await root()
  assert.equal((await r.move('proposed', 'dispatcher')).ok, true)
  for (const [from, to] of [['proposed', 'rejected'], ['rejected', 'proposed'], ['proposed', 'canceled']] as const) {
    landed.length = 0
    assert.equal((await r.move(to, 'scoper', 'operator decision')).ok, true)
    assert.deepEqual(landed.map(move => [move.taskId, move.from, move.to]), [[r.id, from, to]])
  }
  const other = await root()
  await other.scope()
  dispatcher.landed = async () => { throw new Error('settlement unavailable') }
  await assert.rejects(other.move('canceled', 'scoper', 'operator decision'), { message: 'landed_failed' })
  assert.equal((await other.labels())['work.stage'], 'canceled')
})

test('pause and park block forward moves without blocking the canceled stage', async t => {
  const { team, root } = await fixture(t)
  const parked = await root(), paused = await root()
  for (const r of [parked, paused]) assert.equal((await r.move('proposed', 'dispatcher')).ok, true)
  const request = caller(team.fetch, await localUserToken('operator'))
  assert.equal((await request('POST', `/tasks/${parked.id}/park`, { reason: 'operator hold' })).status, 200)
  for (const [r, reason] of [[parked, 'task_parked'], [paused, 'board_paused']] as const) {
    if (r === paused) assert.equal((await request('POST', '/control/pause', { reason: 'operator hold' })).status, 200)
    assert.deepEqual(await r.move('scoped', 'scoper'), { ok: false, reason })
    assert.equal((await r.move('canceled', 'jockey', 'operator canceled')).ok, true)
    assert.equal((await r.labels())['work.stage'], 'canceled')
  }
})
