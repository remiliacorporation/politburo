import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AttentionDraft, MessageView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import type { EvidencePolicy } from '../src/contract/evidence.ts'
import type { BoardEvent } from '../src/contract/events.ts'
import { memory } from '../src/store/memory.ts'
import { sqlite } from '../src/store/sqlite.ts'
import { board, BOARD_URL, personToken, testBoard } from './harness.ts'

const principal = (name: string) => `vercel:user:u_${name}`
const commit = 'a'.repeat(40)
const artifactRef = 'builds/42'
const expiry = (ms: number) => new Date(Date.now() + ms).toISOString()
const policy: EvidencePolicy = {
  gates: false,
  releaseDependencies: true,
  attesters: { tests: [principal('ci')] },
  operators: [principal('operator')],
  resolvers: [principal('operator')],
}
const client = (host: ReturnType<typeof testBoard>, user: string) => board({
  backend: http(BOARD_URL, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== new URL(BOARD_URL).pathname) request.headers.set('authorization', `Bearer ${await personToken(`u_${user}`)}`)
      return host.fetch(request)
    },
  }),
}).as(null)

function setup(store: ReturnType<typeof memory> | ReturnType<typeof sqlite>, workEvidence: EvidencePolicy | undefined) {
  const host = testBoard({ workEvidence, store, attentionResponders: { work: [principal('operator')] } })
  const worker = client(host, 'worker')
  const operator = client(host, 'operator')
  const ci = client(host, 'ci')
  const create = async (needs: string[] = []) => (await worker.tasks.create('work', { text: 'Ship the patch', needs })).task
  const read = async (id: string) => (await worker.thread(id)).message
  const record = (round: number, expiresAt?: string) => ({ commit, round, gate: 'tests' as const, verdict: 'pass' as const, artifactRef, ...(expiresAt ? { expiresAt } : {}) })
  const prerequisite = async (expiresAt?: string) => {
    const need = await create()
    const held = await worker.tasks.claim(need.id)
    await held.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(need.id, record(held.epoch, expiresAt))
    await held.complete()
    const [evidence] = (await worker.tasks.evidence(need.id)).evidence
    return { needId: need.id, evidenceId: evidence!.id }
  }
  const resolve = async (id: string, edge: Awaited<ReturnType<typeof prerequisite>>) =>
    operator.tasks.resolve(id, { ...edge, ifVersion: (await read(id)).version })
  const released = async () => {
    const expiresAt = expiry(1_000)
    const edge = await prerequisite(expiresAt)
    const dependent = await create([edge.needId])
    await resolve(dependent.id, edge)
    return { dependent, edge, expiresAt }
  }
  const expireOn = (type: BoardEvent['type'], at: string) => {
    const append = store.log.append.bind(store.log)
    let moved = false
    // Move the clock after decide and before the store's conditional append.
    store.log.append = (session, events, options) => {
      if (!moved && events.some((event) => event.type === type)) {
        moved = true
        vi.setSystemTime(Date.parse(at) + 1)
      }
      return append(session, events, options)
    }
  }
  return { worker, operator, ci, create, read, record, prerequisite, resolve, released, expireOn }
}

function atomic(title: string, test: (fixture: ReturnType<typeof setup>) => Promise<void>, workEvidence: EvidencePolicy | null = policy) {
  it.each(['memory', 'SQLite'])(`${title} (%s)`, async (adapter) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let dir: string | undefined
    try {
      if (adapter === 'SQLite') dir = await mkdtemp(join(tmpdir(), 'board-evidence-atomic-'))
      const store = dir === undefined ? memory() : sqlite({ path: join(dir, 'board.db') })
      try {
        await test(setup(store, workEvidence ?? undefined))
      } finally {
        await store.close()
      }
    } finally {
      vi.useRealTimers()
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })
}

const denied = (promise: Promise<unknown>, code: string, status = 409) => expect(promise).rejects.toMatchObject({ status, code })
const draft = (root: MessageView, expiresAt = expiry(60_000)): AttentionDraft => ({
  kind: 'awaiting_approval', question: 'Release this commit?', context: 'The checklist passed.',
  options: [
    { id: 'proceed', label: 'Proceed', consequence: 'Workers may resume', next: 'resume' },
    { id: 'stop', label: 'Stop', consequence: 'Release not approved', next: 'fail' },
  ],
  evidence: [{ message: root.id, revision: root.revision }], expiresAt, revision: root.revision, commit,
})

atomic('claim by id refuses a release that expires at append', async ({ worker, released, expireOn, read }) => {
  const { dependent, expiresAt } = await released()
  expireOn('task.claimed', expiresAt)
  await denied(worker.tasks.claim(dependent.id), 'task_waiting')
  expect((await read(dependent.id)).task).toMatchObject({ state: 'ready', claim: null })
})

atomic('claim next returns no task when the winner’s release expires at append', async ({ worker, released, create, expireOn, read }) => {
  const { dependent, expiresAt } = await released()
  const fallback = await create()
  expireOn('task.claimed', expiresAt)
  expect(await worker.tasks.claim({ channel: 'work' })).toBeNull()
  expect((await read(dependent.id)).task).toMatchObject({ state: 'ready', claim: null })
  expect((await read(fallback.id)).task).toMatchObject({ state: 'ready', claim: null })
})

atomic('renew refuses a lease that lapses at append', async ({ worker, create, expireOn, read }) => {
  const { id } = await create()
  const held = await worker.tasks.claim(id, { lease: 30 })
  expireOn('task.renewed', held.until)
  await denied(held.renew(60), 'claim_lost')
  expect((await read(id)).task?.claim?.until).toBe(held.until)
})

atomic('submit refuses a lease that lapses at append', async ({ worker, create, expireOn }) => {
  const { id } = await create()
  const held = await worker.tasks.claim(id, { lease: 30 })
  expireOn('task.work_submitted', held.until)
  await denied(held.submit(commit, artifactRef), 'claim_lost')
  expect((await worker.tasks.evidence(id)).submission).toBeNull()
})

atomic('complete refuses a dependency release that expires at append without completion gates', async ({ worker, released, expireOn, read }) => {
  const { dependent, expiresAt } = await released()
  const held = await worker.tasks.claim(dependent.id)
  expireOn('task.completed', expiresAt)
  await denied(held.complete(), 'task_waiting')
  expect((await read(dependent.id)).task?.state).toBe('claimed')
})

atomic('complete refuses a lease that lapses at append on a legacy board', async ({ worker, create, expireOn, read }) => {
  const { id } = await create()
  const held = await worker.tasks.claim(id, { lease: 30 })
  expireOn('task.completed', held.until)
  await denied(held.complete(), 'claim_lost')
  expect((await read(id)).task?.state).toBe('claimed')
}, null)

atomic('resolve refuses named evidence that expires at append', async ({ worker, create, prerequisite, resolve, expireOn }) => {
  const expiresAt = expiry(1_000)
  const edge = await prerequisite(expiresAt)
  const dependent = await create([edge.needId])
  expireOn('task.work_resolved', expiresAt)
  await denied(resolve(dependent.id, edge), 'invalid_evidence')
  expect((await worker.tasks.evidence(dependent.id)).releases).toEqual([])
})

atomic('resolve records a release without readying the task when another edge expires at append', async ({ worker, create, prerequisite, resolve, expireOn, read }) => {
  const expiresAt = expiry(1_000)
  const first = await prerequisite(expiresAt)
  const second = await prerequisite()
  const dependent = await create([first.needId, second.needId])
  await resolve(dependent.id, first)
  expireOn('task.work_resolved', expiresAt)
  await resolve(dependent.id, second)
  expect((await worker.tasks.evidence(dependent.id)).releases).toEqual([first, second])
  expect((await read(dependent.id)).task?.state).toBe('waiting')
})

atomic('unblock routes to waiting when a release expires at append', async ({ worker, released, expireOn }) => {
  const { dependent, expiresAt } = await released()
  await worker.tasks.block(dependent.id, 'needs a person')
  expireOn('task.unblocked', expiresAt)
  expect((await worker.tasks.unblock(dependent.id)).task?.state).toBe('waiting')
})

atomic('unpark routes to waiting when a release expires at append', async ({ operator, released, expireOn }) => {
  const { dependent, expiresAt } = await released()
  await operator.tasks.park(dependent.id, 'hold for maintenance')
  expireOn('task.unparked', expiresAt)
  expect((await operator.tasks.unpark(dependent.id, 'resume work')).task?.state).toBe('waiting')
})

atomic('reopen routes to waiting when a release expires at append', async ({ worker, released, expireOn }) => {
  const { dependent, expiresAt } = await released()
  const held = await worker.tasks.claim(dependent.id)
  await held.fail('retry later')
  expireOn('task.reopened', expiresAt)
  expect((await worker.tasks.reopen(dependent.id)).task?.state).toBe('waiting')
})

atomic('handoff refuses a lease that lapses at append', async ({ worker, create, expireOn, read }) => {
  const { id } = await create()
  const held = await worker.tasks.claim(id, { lease: 30 })
  expireOn('task.handoff', held.until)
  await denied(held.handoff({ commit, packetPath: 'handoffs/check.md', sha256: 'c'.repeat(64) }), 'claim_lost')
  expect((await read(id)).task?.handoff).toBeUndefined()
})

atomic('needs does not ready a task when a retained edge expires at append', async ({ worker, released, create, expireOn }) => {
  const { dependent, edge, expiresAt } = await released()
  const other = await create()
  await worker.tasks.needs(dependent.id, [edge.needId, other.id])
  expireOn('task.needs_changed', expiresAt)
  expect((await worker.tasks.needs(dependent.id, [edge.needId])).task).toMatchObject({ state: 'waiting', needs: [edge.needId] })
})

atomic('answerAttention routes to waiting when a release expires at append', async ({ worker, operator, released, expireOn }) => {
  const { dependent, expiresAt } = await released()
  const { attention } = await worker.tasks.ask(dependent.id, draft(dependent))
  expireOn('task.attention_answered', expiresAt)
  const answer = await operator.tasks.answer(dependent.id, attention.id, { option: 'proceed', commit })
  expect(answer.attention).toMatchObject({ status: 'answered', receipt: { routedTo: 'waiting' } })
  expect(answer.task.task?.state).toBe('waiting')
})

atomic('answerAttention refuses an expired request at append', async ({ worker, operator, create, expireOn, read }) => {
  const root = await create()
  const expiresAt = expiry(1_000)
  const { attention } = await worker.tasks.ask(root.id, draft(root, expiresAt))
  expireOn('task.attention_answered', expiresAt)
  await denied(operator.tasks.answer(root.id, attention.id, { option: 'proceed', commit }), 'attention_stale')
  expect((await read(root.id)).task?.state).toBe('blocked')
})

atomic('requestAttention refuses a lease that lapses at append', async ({ worker, create, expireOn, read }) => {
  const root = await create()
  const { epoch, token, until } = await worker.tasks.claim(root.id, { lease: 30 })
  expireOn('task.attention_requested', until)
  await denied(worker.tasks.ask(root.id, { ...draft(root), claim: { epoch, token } }), 'claim_lost')
  expect((await read(root.id)).task?.state).toBe('claimed')
})

atomic('requestAttention refuses a draft that expires at append', async ({ worker, create, expireOn, read }) => {
  const root = await create()
  const expiresAt = expiry(1_000)
  expireOn('task.attention_requested', expiresAt)
  await denied(worker.tasks.ask(root.id, draft(root, expiresAt)), 'invalid_request', 400)
  expect((await read(root.id)).task?.state).toBe('ready')
})

atomic('recordEvidence refuses a candidate whose lease lapses at append', async ({ worker, ci, create, record, expireOn }) => {
  const { id } = await create()
  const held = await worker.tasks.claim(id, { lease: 30 })
  await held.submit(commit, artifactRef)
  expireOn('task.work_evidence', held.until)
  await denied(ci.tasks.recordEvidence(id, record(held.epoch)), 'stale_candidate')
})

atomic('overrideEvidence refuses an override that expires at append', async ({ worker, operator, create, expireOn }) => {
  const { id } = await create()
  const held = await worker.tasks.claim(id)
  await held.submit(commit, artifactRef)
  const expiresAt = expiry(1_000)
  expireOn('task.work_override', expiresAt)
  await denied(operator.tasks.overrideEvidence(id, { commit, round: held.epoch, gate: 'tests', reason: 'CI offline', expiresAt }), 'invalid_request', 400)
  expect((await worker.tasks.evidence(id)).overrides).toEqual([])
})

for (const [path, event, write] of [
  ['release', 'task.released', (held) => held.release()],
  ['fail', 'task.failed', (held) => held.fail('try later')],
  ['block with proof', 'task.blocked', (held) => held.block('needs a person')],
  ['priority with proof', 'task.priority_changed', (held) => held.priority('low')],
] satisfies [string, BoardEvent['type'], (held: ReturnType<ReturnType<typeof client>['tasks']['held']>) => Promise<unknown>][]) {
  atomic(`${path} refuses a lease that lapses at append`, async ({ worker, create, expireOn, read }) => {
    const { id } = await create()
    const held = await worker.tasks.claim(id, { lease: 30 })
    expireOn(event, held.until)
    await denied(write(held), 'claim_lost')
    expect((await read(id)).task).toMatchObject({ state: 'claimed', priority: 'normal' })
  })
}
