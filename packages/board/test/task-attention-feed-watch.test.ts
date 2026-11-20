import { expect, it, vi } from 'vitest'
import type { AttentionDraft, AttentionView, BoardEventView, MatchView, MessageView } from '../src/api/routes.ts'
import { caller, deploymentToken, personToken, testBoard } from './harness.ts'

const COMMIT = 'a'.repeat(40)
const READY = 'work --label board.task=ready'

async function setup(options: Parameters<typeof testBoard>[0] = {}) {
  const team = testBoard({ attentionResponders: { work: ['vercel:user:u_responder'] }, ...options })
  const owner = caller(team.fetch, await personToken('u_owner'))
  const responder = caller(team.fetch, await personToken('u_responder'))
  async function task() {
    const made = await owner('POST', '/tasks', { channel: 'work', text: 'Review the release' })
    expect(made.status).toBe(201)
    return made.body.task as MessageView
  }
  async function ask(root: MessageView, context: string, replaces?: string) {
    const draft: AttentionDraft = {
      kind: 'awaiting_approval', question: 'Release this commit?', context,
      options: [
        { id: 'proceed', label: 'Proceed', consequence: 'Resume work', next: 'resume' },
        { id: 'stop', label: 'Stop', consequence: 'Release not approved', next: 'fail' },
      ],
      revision: root.revision, evidence: [{ message: root.id, revision: root.revision }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), commit: COMMIT,
    }
    const opened = await owner('POST', `/tasks/${root.id}/attention`, { ...draft, replaces })
    expect(opened.status).toBe(201)
    return { requestId: (opened.body.attention as AttentionView).id, draft }
  }
  async function answer(root: MessageView, requestId: string) {
    const landed = await responder('POST', `/tasks/${root.id}/attention/${requestId}/answer`, { option: 'proceed', commit: COMMIT })
    expect(landed.status).toBe(200)
    const attention = landed.body.attention as AttentionView
    if (attention.status !== 'answered') throw new Error('expected an answered request')
    return attention.receipt
  }
  async function events(query: string) {
    const response = await owner('GET', `/events${query}`)
    expect(response.status).toBe(200)
    return response.body as { events: BoardEventView[]; cursor: string }
  }
  return { team, owner, task, ask, answer, events }
}

const requests = (events: BoardEventView[]) => events
  .filter((event) => event.type === 'task.attention_requested')
  .map(({ payload: { requestId, draft } }) => ({ requestId, draft }))

it('delivers attention transitions through the ready filter to configured and registered watchers', async () => {
  const seen: BoardEventView[] = []
  const { team, owner, task, ask, answer } = await setup({
    watch: { ready: { tail: READY, run: ({ event }) => void seen.push(event) } },
  })
  const project = caller(team.fetch, await deploymentToken('worker', 'prj_worker'))
  expect((await project('POST', '/watchers', { watch: { ready: { tail: READY } } })).status).toBe(200)
  const root = await task()
  const { requestId } = await ask(root, 'Checklist passed')
  expect((await owner('POST', '/messages', { re: root.id, text: 'Still on hold' })).status).toBe(201)
  await answer(root, requestId)
  const summarize = (events: BoardEventView[]) => events.map((event) => [event.type, event.message?.id, event.message?.labels['board.task']])
  const expected = [
    ['task.created', root.id, 'ready'],
    ['task.attention_requested', root.id, 'blocked'], // Matched before leaving ready.
    ['task.attention_answered', root.id, 'ready'], // Matched after returning to ready.
  ]
  const pulled: BoardEventView[] = []
  await vi.waitFor(async () => {
    const response = await project('GET', '/watchers/matches')
    expect(response.status).toBe(200)
    for (const match of response.body.matches as MatchView[]) {
      expect((await project('POST', `/watchers/matches/${match.id}/ack`, { lease: match.lease })).status).toBe(200)
      pulled.push(match.event)
    }
    expect(summarize(seen)).toEqual(expected)
    expect(summarize(pulled)).toEqual(expected)
  })
})

it('shows only the current hold in the newest events without changing historical replay', async () => {
  const { owner, task, ask, answer, events } = await setup()
  const root = await task()
  const { cursor } = await events('')
  const first = await ask(root, 'First candidate')
  expect(requests((await events('?last=25')).events)).toEqual([first])
  const second = await ask(root, 'Revised candidate', first.requestId)
  expect(requests((await events('?last=25')).events)).toEqual([second])
  const receipt = await answer(root, second.requestId)
  const latest = (await events('?last=25')).events
  expect(requests(latest)).toEqual([])
  expect(latest.filter((event) => event.type === 'task.attention_answered')).toMatchObject([
    { payload: { requestId: second.requestId, receipt }, message: { task: { state: 'ready' } } },
  ])
  // The task still remembers the answered request, but a later plain hold must not disclose its draft.
  const plain = await owner('POST', `/tasks/${root.id}/block`, { kind: second.draft.kind, reason: second.draft.question })
  expect(plain.status).toBe(200)
  expect(requests((await events('?last=25')).events)).toEqual([])
  expect(requests((await events(`?after=${encodeURIComponent(cursor)}`)).events)).toEqual([first, second])
})

it('omits a draft from the newest events when its held root is deleted', async () => {
  const { owner, task, ask, events } = await setup()
  const root = await task()
  const opened = await ask(root, 'Checklist passed')
  expect((await owner('POST', `/messages/${root.id}/edit`, { text: 'Review the revised release' })).status).toBe(200)
  // A stale request still holds the task until replaced or closed.
  expect(requests((await events('?last=25')).events)).toEqual([opened])
  expect((await owner('POST', `/messages/${root.id}/delete`, {})).status).toBe(200)
  const latest = (await events('?last=25')).events
  expect(requests(latest)).toEqual([])
  expect(latest.find((event) => event.type === 'message.deleted')?.message).toMatchObject({ id: root.id, deleted: true })
})
