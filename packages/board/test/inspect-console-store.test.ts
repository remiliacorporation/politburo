import { expect, it } from 'vitest'
import type { Me, MessageView } from '../src/api/routes.ts'
import { addOp, CONSOLE_LANES, consoleBlockers, consoleLane, consolePriority, consoleTasks, initialState, merge, type TaskRoot, type Viewer } from '../src/inspect/app/store.ts'
import { compileAccess } from '../src/server/access.ts'
import { caller, personToken, testBoard } from './harness.ts'

async function setup() {
  const board = testBoard()
  const token = await personToken('u_ada')
  const asAda = (headers?: Record<string, string>) => caller(board.fetch, token, headers)
  const ada = asAda()
  const bo = caller(board.fetch, await personToken('u_bo'))
  async function create(text: string, options: { channel?: string; labels?: Record<string, string>; needs?: string[]; for?: string } = {}) {
    const answer = await ada('POST', '/tasks', { channel: 'work', text, ...options })
    expect(answer.status).toBe(201)
    return answer.body.task as TaskRoot
  }
  async function viewer(headers?: Record<string, string>): Promise<Viewer> {
    const answer = await asAda(headers)('GET', '/me')
    expect(answer.status).toBe(200)
    const me: Me = answer.body
    const access = compileAccess(me.can)
    return { ...me, may: (permission, channel) => access.can(permission, channel), manages: access.at('manage', '*') }
  }
  async function read(id: string): Promise<TaskRoot> {
    const answer = await ada('GET', `/messages/${id}`)
    expect(answer.status).toBe(200)
    return answer.body.message
  }
  async function change(root: TaskRoot, move: string, body?: unknown): Promise<TaskRoot> {
    const answer = await ada('POST', `/tasks/${root.id}/${move}`, body)
    expect(answer.status).toBe(200)
    return answer.body.task
  }
  async function settle(root: TaskRoot, move: 'complete' | 'fail', body: { result?: string; reason?: string }) {
    const answer = await ada('POST', `/tasks/${root.id}/claim`, {})
    expect(answer.status).toBe(200)
    return change(root, move, { ...answer.body.claim, ...body })
  }
  return { ada, asAda, bo, create, viewer, read, change, settle }
}

it('projects board states to the ordered console lanes, without letting labels invent QA or override state', async () => {
  const { ada, bo, create, viewer, read, change, settle } = await setup()
  const ready = await create('write the fix', { labels: { lane: 'QA review', state: 'completed', paused: 'true', work: 'elsewhere' } })
  const waiting = await create('deploy', { needs: [ready.id] })
  const failed = await settle(await create('run tests'), 'fail', { reason: 'runner stopped' })
  const completed = await settle(await create('measure latency'), 'complete', { result: 'under budget' })
  const canceled = await change(await create('duplicate'), 'cancel', { reason: 'already covered' })
  const hold = await change(await create('ask operations'), 'block', { kind: 'awaiting_approval', reason: 'Approve the rollout?' })
  const untypedHold = await change(await create('check the copy'), 'block', { reason: 'Confirm wording' })
  const report = await bo('POST', '/messages', { channel: 'work', text: 'the index is slow' })
  const id = report.body.message.id
  expect((await ada('POST', '/tasks', { re: id })).status).toBe(201)
  expect((await bo('POST', `/messages/${id}/edit`, { text: 'the index times out' })).status).toBe(200)
  const edited = await read(id)
  // Also exercise a disagreeing state label, which a conforming board does not produce.
  const mislabeled = { ...ready, labels: { ...ready.labels, 'board.task': 'completed' } }
  const roots = [waiting, mislabeled, edited, failed, hold, untypedHold, completed, canceled]
  const now = Date.now()
  expect(CONSOLE_LANES).toEqual(['Backlog', 'Ready', 'Needs triage', 'Agent repair', 'Started', 'QA review', 'Human attention', 'Closed'])
  expect(roots.map((root) => consoleLane(root, now))).toEqual(['Backlog', 'Ready', 'Needs triage', 'Agent repair', 'Human attention', 'Human attention', 'Closed', 'Closed'])
  const state = merge(initialState, roots)
  expect(consoleTasks(state, { lane: 'QA review', text: '' }, now)).toEqual([])
  const me = await viewer()
  expect(consoleBlockers(state, ready, me, now)).toEqual([])
  expect(consoleBlockers(state, edited, me, now)).toEqual(['Blocked (edited): its text was edited by someone who does not own the task'])
  expect(consoleBlockers(state, untypedHold, me, now)).toEqual(['Blocked: Confirm wording'])
  expect([failed, completed, canceled].map((root) => consoleBlockers(state, root, me, now))).toEqual([
    ['Failed: runner stopped (requires reopen)'], ['Completed'], ['Canceled: already covered'],
  ])
  const reopened = await change(failed, 'reopen', {})
  expect(consoleLane(reopened, now)).toBe('Ready')
  expect(consoleBlockers(state, reopened, me, now)).toEqual([])
})

it('only displays exact priority annotations and combines local filters without changing task order or paging', async () => {
  const { ada, create, viewer, read } = await setup()
  const older = await create('Overview\nPrevious copy', { channel: 'work/release', labels: { priority: '5' } })
  const newer = await create('Overview\nRelease checklist', { channel: 'work/release', labels: { priority: '1' } })
  const outside = await create('Release checklist', { channel: 'other', labels: { priority: '5' } })
  const hold = await create('Release checklist', { channel: 'work/release', labels: { priority: '5' }, needs: [older.id] })
  const wrongText = await create('Unrelated', { channel: 'work/release', labels: { priority: '5' } })
  const unreported = await create('Release checklist', { channel: 'work/release', labels: { priority: '05' } })
  const deleted = await create('Release checklist', { channel: 'work/release', labels: { priority: '5' } })
  expect((await ada('POST', `/messages/${deleted.id}/delete`)).status).toBe(200)
  const post = await ada('POST', '/messages', { channel: 'work/release', text: 'Release checklist', labels: { priority: '5' } })
  const reply = await ada('POST', '/messages', { re: older.id, text: 'Reply-only text' })
  expect(post.status).toBe(201)
  expect(reply.status).toBe(201)
  expect((await ada('POST', `/messages/${older.id}/edit`, { text: 'Overview\nRelease checklist' })).status).toBe(200)
  const latest = await read(older.id)
  const loaded = merge(initialState, [latest, newer, outside, hold, wrongText, unreported, await read(deleted.id), post.body.message as MessageView, reply.body.message as MessageView])
  const state = merge(loaded, [older])
  const now = Date.now()
  const ids = (filter: Parameters<typeof consoleTasks>[1], through?: TaskRoot) => consoleTasks(state, filter, now, through).map((root) => root.id)
  expect(ids({ text: ' \t' })).toEqual([older.id, newer.id, outside.id, hold.id, wrongText.id, unreported.id])
  expect(ids({ channel: 'work/', lane: 'Ready', priority: '5', text: '  cHeCkLiSt  ' })).toEqual([older.id])
  expect(ids({ text: 'WORK/RELEASE' })).toEqual([older.id, newer.id, hold.id, wrongText.id, unreported.id])
  expect(ids({ text: ` ${outside.id.toUpperCase()} ` })).toEqual([outside.id])
  expect(ids({ text: 'Reply-only text' })).toEqual([])
  expect(ids({ text: '', priority: 'unreported' })).toEqual([unreported.id])
  expect(ids({ text: 'checklist' }, older)).toEqual([older.id])
  expect(consoleTasks(addOp(state, older.id, 'delete-older', { kind: 'delete' }), { text: '' }, now).map((root) => root.id)).not.toContain(older.id)
  for (const value of ['1', '2', '3', '4', '5', '0', '6', '02', ' 2', '2 ']) {
    expect(consolePriority({ ...older, labels: { priority: value } }), value).toBe(/^[1-5]$/.test(value) ? value : 'unreported')
  }
  expect(consolePriority({ ...older, labels: { Priority: '2' } })).toBe('unreported')
  expect(consoleBlockers(state, latest, await viewer(), now)).toEqual([])
})

it('distinguishes observed unmet needs from unknown ones and respects the dependent root across channels', async () => {
  const { create, viewer, read, change, settle } = await setup()
  const open = await create('prepare staging', { channel: 'ops' })
  const unseen = await create('get sign-off', { channel: 'review' })
  const failed = await settle(await create('verify staging', { channel: 'ops' }), 'fail', { reason: 'fixture unavailable' })
  const done = await settle(await create('write plan', { channel: 'planning' }), 'complete', {})
  const waiting = await create('roll out', { needs: [open.id, unseen.id, failed.id, done.id] })
  const blocked = await change(waiting, 'block', { kind: 'awaiting_approval', reason: 'Approve the rollout?' })
  const me = await viewer()
  const now = Date.now()
  const partial = merge(initialState, [open, failed, done])
  const unmet = [`Prerequisite #${open.id} last seen ready, not completed`, `Prerequisite #${failed.id} last seen failed, not completed`]
  const unknown = (id: string) => `Prerequisite #${id}: state not confirmed`
  expect(consoleBlockers(initialState, waiting, me, now)).toEqual([open, unseen, failed, done].map((need) => unknown(need.id)))
  const partialBlockers = [unmet[0], unknown(unseen.id), unmet[1]]
  expect(consoleBlockers(partial, waiting, me, now)).toEqual(partialBlockers)
  const duplicate = { ...blocked, task: { ...blocked.task, needs: [...blocked.task.needs, open.id] } }
  expect(consoleBlockers(partial, duplicate, me, now)).toEqual([...partialBlockers, 'Blocked (awaiting_approval): Approve the rollout?'])
  const stillWaiting = await change(blocked, 'unblock', {})
  const reopened = await change(failed, 'reopen', {})
  const newer = merge(partial, [await settle(open, 'complete', {}), await settle(unseen, 'complete', {}), await settle(reopened, 'complete', {})])
  expect(consoleBlockers(newer, stillWaiting, me, now)).toEqual(['Board still reports waiting'])
  // The dependent's ready view can arrive before a prerequisite's completed view in another channel.
  expect(consoleBlockers(partial, await read(waiting.id), me, now)).toEqual([])
})

it('reports simultaneous claim, assignment, and profile-scope facts, but only a live lease', async () => {
  const { asAda, create, viewer } = await setup()
  const headers = { 'x-board-profile': 'fixer' }
  const profile = await viewer(headers)
  const limited = await viewer({ 'x-board-profile': 'reviewer', 'x-board-can': '*=read;elsewhere=read,label' })
  const assigned = await create('patch the index', { for: profile.actor })
  expect(consoleBlockers(initialState, assigned, profile, Date.now())).toEqual([])
  const answer = await asAda(headers)('POST', `/tasks/${assigned.id}/claim`, { lease: 30 })
  expect(answer.status).toBe(200)
  const claimed: TaskRoot = answer.body.task
  const until = Date.parse(claimed.task.claim!.until)
  const claim = `Claimed by fixer via u_ada until ${claimed.task.claim!.until}`
  const scope = 'Current profile lacks label scope in work'
  const assignment = 'Assigned to fixer via u_ada'
  expect(consoleLane(claimed, until - 1)).toBe('Started')
  expect(consoleLane(claimed, until)).toBe('Ready')
  expect(consoleBlockers(initialState, claimed, limited, until - 1)).toEqual([claim, assignment, scope])
  expect(consoleBlockers(initialState, claimed, limited, until)).toEqual([assignment, scope])
  expect(consoleBlockers(initialState, claimed, profile, until)).toEqual([])
  expect(consoleBlockers(initialState, assigned, { ...profile, principal: 'other' }, until)).toEqual([assignment])
  const unconfirmed = { ...claimed, task: { ...claimed.task, claim: { ...claimed.task.claim!, until: 'unknown' } } }
  expect(consoleLane(unconfirmed, until)).toBe('Started')
  expect(consoleBlockers(initialState, unconfirmed, limited, until)).toEqual([assignment, scope])
})
