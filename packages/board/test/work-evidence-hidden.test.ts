import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import type { EvidencePolicy } from '../src/contract/evidence.ts'
import { memory } from '../src/store/memory.ts'
import { sqlite } from '../src/store/sqlite.ts'
import { board, BOARD_URL, personToken, testBoard } from './harness.ts'

const principal = (name: string) => `vercel:user:u_${name}`
const commit = 'a'.repeat(40)
const artifactRef = 'builds/42'
const policy: EvidencePolicy = {
  gates: false,
  releaseDependencies: true,
  attesters: { tests: [principal('ci')] },
  resolvers: [principal('operator')],
}
const client = (host: ReturnType<typeof testBoard>, user: string, narrow = false) => board({
  backend: http(BOARD_URL, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== new URL(BOARD_URL).pathname) request.headers.set('authorization', `Bearer ${await personToken(`u_${user}`)}`)
      if (narrow) request.headers.set('x-board-can', 'work=manage')
      return host.fetch(request)
    },
  }),
}).as(null)

type Operation = 'resolve' | 'unblock' | 'unpark' | 'reopen' | 'answerAttention' | 'claim'

function hidden(operation: Operation, test: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  it.each(['memory', 'SQLite'])(`${operation} does not reveal whether a hidden release has expired (%s)`, async (adapter) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let dir: string | undefined
    try {
      if (adapter === 'SQLite') dir = await mkdtemp(join(tmpdir(), 'board-evidence-hidden-'))
      const store = dir === undefined ? memory() : sqlite({ path: join(dir, 'board.db') })
      try {
        await test(await setup(store, operation))
      } finally {
        await store.close()
      }
    } finally {
      vi.useRealTimers()
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })
}

async function setup(store: ReturnType<typeof memory> | ReturnType<typeof sqlite>, operation: Operation) {
  const host = testBoard({ workEvidence: policy, store, attentionResponders: { work: [principal('operator')] } })
  const worker = client(host, 'worker')
  const operator = client(host, 'operator')
  const narrowed = client(host, 'operator', true)
  const ci = client(host, 'ci')
  const expiresAt = new Date(Date.now() + 1_000).toISOString()
  const create = async (channel: string, needs: string[] = []) => (await worker.tasks.create(channel, { text: 'Ship the patch', needs })).task
  const finish = async (channel: string, expiry?: string) => {
    const root = await create(channel)
    const held = await worker.tasks.claim(root.id)
    await held.submit(commit, artifactRef)
    await ci.tasks.recordEvidence(root.id, { commit, round: held.epoch, gate: 'tests', verdict: 'pass', artifactRef, ...(expiry ? { expiresAt: expiry } : {}) })
    await held.complete()
    const [evidence] = (await worker.tasks.evidence(root.id)).evidence
    return { needId: root.id, evidenceId: evidence!.id }
  }
  const visible = await finish('work')
  const privateEdge = await finish('private', expiresAt)
  const read = async (id: string) => (await narrowed.thread(id)).message
  const resolveVisible = async (id: string, who: ReturnType<typeof client> = narrowed) =>
    who.tasks.resolve(id, { ...visible, ifVersion: (await read(id)).version })
  const prepare = async () => {
    const root = await create('work', [visible.needId, privateEdge.needId])
    await operator.tasks.resolve(root.id, { ...privateEdge, ifVersion: root.version })
    if (operation !== 'resolve') await resolveVisible(root.id, operator)
    let requestId: string | undefined
    switch (operation) {
      case 'unblock': await worker.tasks.block(root.id, 'needs a person'); break
      case 'unpark': await operator.tasks.park(root.id, 'hold for maintenance'); break
      case 'reopen': await (await worker.tasks.claim(root.id)).fail('try again'); break
      case 'answerAttention': {
        const { attention } = await worker.tasks.ask(root.id, {
          kind: 'awaiting_approval', question: 'Release this commit?', context: 'The checklist passed.',
          options: [
            { id: 'proceed', label: 'Proceed', consequence: 'Workers may resume', next: 'resume' },
            { id: 'stop', label: 'Stop', consequence: 'Release not approved', next: 'fail' },
          ],
          evidence: [{ message: root.id, revision: root.revision }],
          expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: root.revision, commit,
        })
        requestId = attention.id
        break
      }
    }
    return { id: root.id, requestId }
  }
  const passing = await prepare()
  const expired = await prepare()
  return { narrowed, read, resolveVisible, passing, expired, expire: () => vi.setSystemTime(Date.parse(expiresAt) + 1) }
}

type Fixture = Awaited<ReturnType<typeof setup>>
for (const [operation, write] of [
  ['resolve', ({ resolveVisible }, { id }) => resolveVisible(id)],
  ['unblock', ({ narrowed }, { id }) => narrowed.tasks.unblock(id)],
  ['unpark', ({ narrowed }, { id }) => narrowed.tasks.unpark(id, 'resume work')],
  ['reopen', ({ narrowed }, { id }) => narrowed.tasks.reopen(id)],
  ['answerAttention', async ({ narrowed }, { id, requestId }) => (await narrowed.tasks.answer(id, requestId!, { option: 'proceed', commit })).task],
] satisfies [Operation, (fixture: Fixture, root: Fixture['passing']) => Promise<MessageView>][]) {
  hidden(operation, async (fixture) => {
    const passing = await write(fixture, fixture.passing)
    fixture.expire()
    const expired = await write(fixture, fixture.expired)
    expect([passing.task?.state, expired.task?.state]).toEqual(['ready', 'ready'])
  })
}

hidden('claim', async ({ narrowed, passing, expired, expire, read }) => {
  await expect(narrowed.tasks.claim(passing.id)).rejects.toMatchObject({ status: 409, code: 'task_waiting' })
  expire()
  await expect(narrowed.tasks.claim(expired.id)).rejects.toMatchObject({ status: 409, code: 'task_waiting' })
  for (const { id } of [passing, expired]) expect((await read(id)).task).toMatchObject({ state: 'ready', claim: null })
})
