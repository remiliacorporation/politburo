import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttentionView, Me, TaskBinding, TaskView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import * as store from '../src/inspect/app/store.ts'
import { answerDisabled, claimOrder, completedOf, mobsOf, phaseOf, queueOf, swarmKey } from '../src/inspect/app/swarm.ts'
import { memory } from '../src/store/memory.ts'
import { bearer, board, BOARD_URL, personToken, testBoard } from './harness.ts'

const CHANNEL = 'swarm/web/work'
const ADA = 'vercel:user:u_ada'
const WORKER = `${ADA}+worker`
const COMMIT = 'a'.repeat(40)
const packet = { packetPath: 'handoffs/check.md', commit: COMMIT, sha256: 'b'.repeat(64) }
const binding: TaskBinding = {
  owner: { actor: WORKER, principal: ADA }, controller: { actor: ADA, principal: ADA },
  provider: 'fixture', model: 'fixture', session: 'session-1', branch: 'work/check', worktree: '/fixture/check', baseCommit: COMMIT,
}
const now = Date.parse('2026-10-01T12:00:00Z')
const at = (offset: number) => new Date(now + offset).toISOString()
const person: Me = {
  actor: ADA, principal: ADA, kind: 'person', handle: 'ada', name: 'Ada', avatar: null, profile: null, expiresAt: null, can: { [CHANNEL]: ['read', 'post'] },
}
const profile: Me = { ...person, actor: WORKER, kind: 'agent', profile: 'worker' }
const author = { actor: ADA, principal: ADA, profile: null }
const options = [
  { id: 'proceed', label: 'Proceed', consequence: 'Work can resume', next: 'resume' },
  { id: 'stop', label: 'Stop', consequence: 'Leave this work unfinished', next: 'fail' },
] as const

function task(id: number, fields: Partial<TaskView> = {}): store.TaskRoot {
  return {
    id: String(id), revision: id, version: id, channel: CHANNEL, text: `task ${id}`, thread: `t${id}`, re: null, replyTo: null,
    createdAt: at(id), editedAt: null, deleted: false, by: author, author: null, labels: {}, reactions: {}, noSync: true,
    origin: null, from: null, blocks: [], undelivered: {}, attachments: [], links: [],
    task: { state: 'ready', priority: 'normal', owner: ADA, by: ADA, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null, ...fields },
  }
}
const ids = (roots: store.TaskRoot[]) => roots.map(({ id }) => id)
const makeState = (me: Me, ...roots: store.TaskRoot[]) => store.merge({
  ...store.initialState, me,
  swarm: { ...store.initialState.swarm, lists: { open: { key: swarmKey(me.actor, {}), rows: { is: 'here', items: ids(roots) } } } },
}, roots)
const mobIds = (state: store.State, when = Date.now()) => mobsOf(state, {}, when).flatMap(({ work }) => work.map(({ root }) => root.id))
const held = task(1, { state: 'blocked', attentionId: 'decision-1', blocked: { kind: 'awaiting_approval', reason: 'Continue?' } })
const draft = (root: Pick<store.TaskRoot, 'id' | 'revision'>, expiresAt: string) => ({
  kind: 'awaiting_approval' as const, question: 'Continue?', context: 'The checks passed.',
  options: [...options], evidence: [{ message: root.id, revision: root.revision }], revision: root.revision, expiresAt, commit: COMMIT,
})
const pending: AttentionView = { ...draft(held, at(5000)), id: 'decision-1', by: author, status: 'pending' }

function decisionOf(state: store.State, root: store.TaskRoot): AttentionView {
  const read = store.attentionOf(state, root)
  if (read?.is !== 'here' || !read.attention) throw new Error('the page has no readable decision')
  return read.attention
}

function rootOf(state: store.State, id: string): store.TaskRoot {
  const root = state.messages[id]
  if (!store.isTask(root)) throw new Error(`the page has no task #${id}`)
  return root
}

describe('the swarm selectors', () => {
  it('orders and offers exact assignments only to the matching actor and owner', () => {
    const otherOwner = task(4, { priority: 'high', for: WORKER, owner: 'vercel:user:u_bo' })
    const assigned = task(12, { priority: 'high', for: WORKER })
    const roots = [
      task(19, { priority: 'high' }), task(13, { priority: 'lowest' }), task(8, { priority: 'low' }), task(20, { priority: 'urgent' }),
      assigned, task(14, { priority: 'high', for: WORKER }), otherOwner,
      task(10, { priority: 'high', for: `${ADA}+other` }), task(3, { priority: 'high' }), task(11),
    ]
    expect(ids(claimOrder(roots, profile))).toEqual(['20', '12', '14', '3', '4', '10', '19', '11', '8', '13'])
    expect(ids(claimOrder(roots, person))).toEqual(['20', '3', '4', '10', '12', '14', '19', '11', '8', '13'])
    const state = makeState(profile, ...roots)
    const viewer: store.Viewer = { ...profile, may: (permission) => permission === 'label', manages: false }
    expect(store.moves(state, assigned, viewer, now).claim).toBe(true)
    expect(store.moves(state, otherOwner, viewer, now).claim).toBe(false)
    // A skewed clock does not change claim-next's root order on a local board.
    expect(ids(claimOrder([task(22), { ...task(21), createdAt: at(30) }], null))).toEqual(['21', '22'])
  })

  it('derives phases only from task state and a live lease', () => {
    const claim = { actor: WORKER, until: at(1000), binding }
    expect(phaseOf(task(1).task, now)).toBe('dispatched')
    expect(phaseOf(task(2, { state: 'waiting' }).task, now)).toBe('dispatched')
    expect(phaseOf(task(3, { state: 'claimed', claim }).task, now)).toBe('running')
    expect(phaseOf(task(3, { state: 'claimed', claim }).task, now + 1000)).toBe('dispatched')
    expect(phaseOf(held.task, now)).toBe('held')
    expect(phaseOf(task(4, { state: 'completed' }).task, now)).toBe('reported')
    expect(phaseOf(task(5, { state: 'failed' }).task, now)).toBeNull()
    expect(phaseOf(task(6, { state: 'canceled' }).task, now)).toBeNull()
  })

  it('groups live claims only when both binding fields match, keeping unbound claims apart', () => {
    const live = (id: number, bound?: TaskBinding, until = at(1000)) => task(id, { state: 'claimed', claim: { actor: WORKER, until, ...(bound ? { binding: bound } : {}) } })
    const state = makeState(profile, live(1, binding), live(2, binding), live(3, { ...binding, branch: 'other' }), live(4, { ...binding, session: 'session-2' }), live(5), live(6), live(7, binding, at(0)), task(8))
    expect(mobsOf(state, {}, now).map(({ session, branch, work }) => [session, branch, ids(work.map(({ root }) => root))])).toEqual([
      [null, null, ['6']], [null, null, ['5']], ['session-2', 'work/check', ['4']], ['session-1', 'other', ['3']], ['session-1', 'work/check', ['2', '1']],
    ])
  })

  it('only offers a current pending decision to a person acting as themselves with read and post', () => {
    const disabled = (me: Me, root = held, decision = pending, when = now) => answerDisabled(makeState(me, root), root, decision, when)
    expect(disabled(person)).toBeNull()
    expect(disabled(person, { ...held, task: { ...held.task, owner: 'vercel:user:u_bo' } })).toBeNull()
    expect(disabled(profile)).toBe('answer as a person without a profile')
    expect(disabled({ ...person, kind: 'deployment' })).toBe('answer as a person without a profile')
    expect(disabled({ ...person, can: { [CHANNEL]: ['read'], elsewhere: ['post'] } })).toBe('answering needs read and post in this channel')
    expect(disabled({ ...person, can: { [CHANNEL]: ['post'] } })).toBe('answering needs read and post in this channel')
    expect(disabled(person, held, { ...pending, id: 'replaced' })).toBe('this decision no longer holds the task')
    expect(disabled(person, held, pending, Date.parse(pending.expiresAt))).toBe('this decision is stale')
    expect(disabled(person, { ...held, revision: held.revision + 1 })).toBe('this decision is stale')
    const evidence = task(2)
    const changed = { ...pending, evidence: [{ message: evidence.id, revision: evidence.revision - 1 }] }
    expect(answerDisabled(makeState(person, held, evidence), held, changed, now)).toBe('this decision is stale')
    expect(answerDisabled(makeState(person, held, evidence), held, {
      ...pending, evidence: [{ message: evidence.id, revision: evidence.revision + 1 }],
    }, now)).toBeNull()
  })

  it('keeps the task card and its assign and cancel controls when a structured hold arrives', () => {
    const ready = task(1)
    const before = makeState(person, ready)
    const viewer: store.Viewer = { ...person, may: (permission) => permission === 'post', manages: false }
    expect(store.threadPane(before, ready.id, null).task).toEqual(ready)
    const root = { ...held, version: ready.version + 1 }
    const after = store.merge(before, [root])
    const card = store.threadPane(after, ready.id, null).task
    expect(card).toEqual(root)
    expect(store.moves(after, card!, viewer, now)).toMatchObject({ assign: true, cancel: true, unblock: false })
  })

  it('does not let a slow pending read replace a newer answer or show unblock on a structured hold', () => {
    let state = makeState(person, held)
    const viewer: store.Viewer = { ...person, may: () => true, manages: true }
    expect(store.moves(state, held, viewer, now).unblock).toBe(false)
    const answered: AttentionView = { ...pending, status: 'answered', receipt: { option: 'proceed', by: author, at: at(100), routedTo: 'ready' } }
    const ready = { ...held, task: { ...held.task, state: 'ready' as const, blocked: null }, version: held.version + 2 }
    state = store.mergeAttention(store.merge(state, [ready]), ready, person.actor, { is: 'here', attention: answered })
    state = store.mergeAttention(state, held, person.actor, { is: 'here', attention: pending })
    expect(decisionOf(state, ready).status).toBe('answered')
    const plainHold = { ...held, version: ready.version + 1, task: { ...held.task, blocked: { kind: 'needs_input', reason: 'New information needed' } } }
    state = store.mergeAttention(store.merge(state, [plainHold]), plainHold, person.actor, { is: 'here', attention: answered })
    expect(store.moves(state, plainHold, viewer, now).unblock).toBe(true)
    expect(ids(queueOf(state, {}, now).held)).toEqual([plainHold.id])
  })
})

// Only the page's browser transport is substituted. Every read and write is made by the
// inspector's actual handle, over HTTP requests to a real board in this process.
const inProcess = (authority: ReturnType<typeof testBoard>): typeof fetch => (input, init) => authority.fetch(new Request(input, init))
const handle = async (authority: ReturnType<typeof testBoard>) => board({ backend: http(BOARD_URL, {
  fetch: bearer(inProcess(authority), await personToken('u_ada')),
}) })
async function openTab(authority: ReturnType<typeof testBoard>, user = 'u_ada', transport = inProcess(authority)) {
  vi.resetModules()
  const signed = bearer(transport, await personToken(user))
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', { origin: 'http://inspector.test' })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const url = new URL(input)
    return signed(`${BOARD_URL}${url.pathname.slice('/board'.length)}${url.search}`, init)
  })
  const tab = await import('../src/inspect/app/board.ts')
  expect(await tab.setProfile(null)).toBe(true)
  return tab
}

afterEach(() => vi.unstubAllGlobals())

describe('swarm with an in-process board', () => {
  it('loads the queue and mob bindings, matches claim-next, and records a decision through the handle', async () => {
    const authority = testBoard({ attentionResponders: { [CHANNEL]: [ADA] } })
    const team = await handle(authority)
    const worker = team.as('worker')
    const make = async (text: string, priority: TaskView['priority'] = 'normal', fields = {}) => (await team.tasks.create(CHANNEL, { text, priority, ...fields })).task
    const low = await make('Packaging', 'low')
    const high = await make('Fix the docs', 'high')
    const assigned = await make('Write tests', 'high', { for: WORKER })
    const urgent = await make('Restore checks', 'urgent')
    const claimed = await make('Build the site')
    const claim = await worker.tasks.claim(claimed.id, { binding })
    await claim.handoff(packet)
    const waitingForPerson = await make('Roll out the site')
    const { attention } = await team.tasks.ask(waitingForPerson.id, draft(waitingForPerson, new Date(Date.now() + 120_000).toISOString()))
    const plain = await make('Prepare the release')
    await team.tasks.block(plain.id, 'Need the release date', { kind: 'needs_input' })
    const parked = await make('Deploy', 'urgent')
    await team.tasks.park(parked.id, 'Wait for a deployment window')
    const completed = await make('Check the config')
    await (await team.tasks.claim(completed.id)).complete('Checks passed')
    const dependent = await make('Use the config', 'normal', { needs: [completed.id] })

    const answering = Promise.withResolvers<void>()
    const allowAnswer = Promise.withResolvers<void>()
    let answers = 0
    const send = inProcess(authority)
    const tab = await openTab(authority, 'u_ada', async (input, init) => {
      if (String(input).endsWith('/answer') && ++answers === 1) {
        answering.resolve()
        await allowAnswer.promise
      }
      return send(input, init)
    })
    await tab.setProfile({ name: 'worker' })
    await tab.loadSwarmTasks('open', {})
    const queue = queueOf(tab.getState(), {}, Date.now())
    expect(ids(queue.ready)).toEqual([urgent.id, assigned.id, high.id, dependent.id, low.id])
    expect(ids(queue.claimed)).toEqual([claimed.id])
    expect(queue.held.map(({ id, task }) => [id, task.blocked?.reason])).toEqual([[plain.id, 'Need the release date']])
    expect(queue.parked.map(({ id, task }) => [id, task.parked?.reason])).toEqual([[parked.id, 'Wait for a deployment window']])
    expect(ids(queue.decisions)).toEqual([waitingForPerson.id])
    const claims = []
    for (const _ of queue.ready) claims.push(await worker.tasks.claim({ channel: CHANNEL }))
    expect(claims.map((taken) => taken?.task.id)).toEqual(ids(queue.ready))
    for (const taken of claims) await taken!.release()

    const mobs = mobsOf(tab.getState(), {}, Date.now())
    expect(mobs).toHaveLength(1)
    expect(mobs[0]).toMatchObject({ session: binding.session, branch: binding.branch, work: [
      { root: { id: claimed.id, task: { handoff: packet } }, claim: { actor: WORKER, until: claim.until }, phase: 'running' },
    ] })
    await tab.loadSwarmTasks('completed', { channel: CHANNEL })
    expect(rootOf(tab.getState(), completed.id).task.result).toBe('Checks passed')
    expect(phaseOf(rootOf(tab.getState(), completed.id).task, Date.now())).toBe('reported')

    const decision = queue.decisions[0]!
    await tab.loadSwarmAttention(decision)
    expect(decisionOf(tab.getState(), decision)).toMatchObject({ id: attention.id, question: 'Continue?', options, status: 'pending' })
    expect(answerDisabled(tab.getState(), decision, attention, Date.now())).toBe('answer as a person without a profile')
    await tab.setProfile(null)
    await tab.loadSwarmTasks('open', {})
    await tab.loadSwarmAttention(decision)
    expect(answerDisabled(tab.getState(), decision, attention, Date.now())).toBeNull()
    const viewed = decisionOf(tab.getState(), decision)
    const sent = tab.answerSwarmAttention(decision, viewed, 'proceed')
    try {
      await answering.promise
      expect(answerDisabled(tab.getState(), decision, viewed, Date.now())).toBe('sending answer…')
      await tab.answerSwarmAttention(decision, viewed, 'stop')
      expect(answers).toBe(1)
    } finally {
      allowAnswer.resolve()
    }
    await sent
    const state = tab.getState()
    const answered = rootOf(state, decision.id)
    expect(decisionOf(state, answered)).toMatchObject({ status: 'answered', receipt: { option: 'proceed', by: author, routedTo: 'ready' } })
    expect((await team.tasks.attention(decision.id)).attention).toEqual(decisionOf(state, answered))
    expect(ids(queueOf(state, {}, Date.now()).decisions)).toEqual([])
    expect(ids(queueOf(state, {}, Date.now()).ready)).toContain(decision.id)

    // A fresh scope is read through the board rather than relying on the stream to have its prerequisite.
    const scoped = await openTab(authority)
    const scope = { channel: CHANNEL, needs: completed.id }
    await scoped.loadSwarmTasks('open', scope)
    expect(ids(queueOf(scoped.getState(), scope, Date.now()).ready)).toEqual([dependent.id])
    expect(ids(queueOf(scoped.getState(), {}, Date.now()).ready)).toEqual([])
  })

  it('displays the 25 latest reports newest first and shows old work that completes live', async () => {
    const authority = testBoard()
    // A controlled clock keeps the older roots at the same activity time until one gets a reply.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { task: running } = await authority.tasks.create(CHANNEL, 'Started before all the other work')
      const claim = await authority.tasks.claim(running.id)
      const roots = await authority.tasks.createMany(CHANNEL, Array.from({ length: 27 }, (_, i) => ({ text: `Check ${i + 1}` })))
      for (const root of roots) await (await authority.tasks.claim(root.id)).complete()
      vi.setSystemTime(Date.now() + 1000)
      await authority.reply(roots[0]!.id, 'Final report')
      const tab = await openTab(authority)
      const stop = tab.watchSwarm('mobs', {})
      try {
        const displayed = () => ids(completedOf(tab.getState(), {}, Date.now()))
        const history = [roots[0]!.id, ...roots.slice(3).reverse().map(({ id }) => id)]
        await vi.waitFor(() => {
          expect(displayed()).toEqual(history)
          expect(mobIds(tab.getState())).toEqual([running.id])
        })
        const { cursor } = await authority.poll({ all: true, last: 1 })
        await claim.complete('Finished while Mobs was open')
        const { task: added } = await authority.tasks.create(CHANNEL, 'Added while Mobs was open')
        await tab.applyLiveEvents((await authority.poll({ all: true, after: cursor })).events)
        expect(ids(queueOf(tab.getState(), {}, Date.now()).ready)).toEqual([added.id])
        expect(mobIds(tab.getState())).toEqual([])
        expect(displayed()).toEqual([running.id, ...history.slice(0, -1)])
      } finally {
        stop()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the board’s backfill refusal alongside a cached or late live thread', async () => {
    const authority = testBoard()
    const { task: cached } = await authority.tasks.create(CHANNEL, 'Already on the page')
    const late = await authority.post(CHANNEL, 'Not loaded yet')
    const send = inProcess(authority)
    const words = 'this board does not support reading thread history'
    const tab = await openTab(authority, 'u_ada', (input, init) => String(input).includes('/messages/')
      ? Promise.resolve(Response.json({ error: { code: 'not_supported', message: words } }, { status: 501 }))
      : send(input, init))
    await tab.loadSwarmTasks('open', {})
    const refused = await tab.loadThread(cached.id)
    expect(store.threadPane(tab.getState(), cached.id, refused)).toMatchObject({ thread: { root: cached }, why: words })
    const lateRefusal = await tab.loadThread(late.id)
    expect(store.threadPane(tab.getState(), late.id, lateRefusal)).toMatchObject({ thread: null, why: words })
    await tab.applyLiveEvents((await authority.poll({ all: true, after: cached.id })).events)
    expect(store.threadPane(tab.getState(), late.id, lateRefusal)).toMatchObject({ thread: { root: late }, why: words })
  })

  it('drops revoked queue rows, bindings, and reports from an already open view', async () => {
    const authority = testBoard()
    const team = await handle(authority)
    const privateChannel = 'swarm/private'
    await authority.createGrant({ principals: [{ kind: 'everyone' }], can: { [privateChannel]: [] } })
    const { grant } = await authority.createGrant({ principals: [{ kind: 'user', userId: 'u_ada' }], can: { [privateChannel]: 'all' } })
    const { task: ready } = await team.tasks.create(CHANNEL, 'Visible')
    const { task: hiddenReady } = await team.tasks.create(privateChannel, 'Private plan')
    const { task: hiddenClaimed } = await team.tasks.create(privateChannel, 'Private work')
    const { task: hiddenReport } = await team.tasks.create(privateChannel, 'Private report')
    await (await team.tasks.claim(hiddenReport.id)).complete()
    const claim = await team.as('worker').tasks.claim(hiddenClaimed.id, { binding })
    const tab = await openTab(authority)
    const queued = () => ids(queueOf(tab.getState(), {}, Date.now()).ready)
    const reports = () => ids(completedOf(tab.getState(), {}, Date.now()))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const stop = tab.watchSwarm('mobs', {})
    try {
      await vi.waitFor(() => {
        expect(queued()).toEqual([ready.id, hiddenReady.id])
        expect(mobIds(tab.getState())).toEqual([hiddenClaimed.id])
        expect(reports()).toEqual([hiddenReport.id])
      })
      const { cursor } = await team.poll({ all: true, last: 1 })
      await claim.complete('Private result')
      const events = (await team.poll({ all: true, after: cursor })).events
      await authority.revokeGrant(grant.id)
      await vi.advanceTimersByTimeAsync(5000)
      await vi.waitFor(() => {
        expect(queued()).toEqual([ready.id])
        expect(mobIds(tab.getState())).toEqual([])
        expect(reports()).toEqual([])
      })
      // A completion already queued before the revoke must not reintroduce it either.
      await tab.applyLiveEvents(events)
      expect(reports()).toEqual([])
      const refused = await tab.loadThread(hiddenReady.id)
      expect(refused?.status).toBe(404)
      expect(store.threadPane(tab.getState(), hiddenReady.id, refused).thread).toBeNull()
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('reclassifies a fenced claim as ready on resume and does not hide its next claim', async () => {
    const authority = testBoard()
    const team = await handle(authority)
    const { task } = await team.tasks.create(CHANNEL, 'A lease that will be fenced')
    const worker = team.as('worker')
    const claim = await worker.tasks.claim(task.id, { binding })
    const tab = await openTab(authority)
    const stop = tab.watchSwarm('mobs', { channel: CHANNEL })
    const queue = () => queueOf(tab.getState(), { channel: CHANNEL }, Date.now())
    const mobs = () => mobsOf(tab.getState(), { channel: CHANNEL }, Date.now())
    try {
      await vi.waitFor(() => expect(ids(queue().claimed)).toEqual([task.id]))
      expect(mobs()).toHaveLength(1)
      const { cursor } = await team.poll({ all: true, last: 1 })
      await team.pause('Fence old leases')
      await team.resume('Allow new work')
      const resumed = await team.poll({ all: true, after: cursor })
      await tab.applyLiveEvents(resumed.events)
      expect(Date.parse(claim.until)).toBeGreaterThan(Date.now())
      expect(ids(queue().ready)).toEqual([task.id])
      expect(mobs()).toEqual([])
      await tab.loadSwarmTasks('open', { channel: CHANNEL })
      expect(ids(queue().ready)).toEqual([task.id])
      expect(ids(queue().claimed)).toEqual([])
      expect(mobs()).toEqual([])
      const fresh = await worker.tasks.claim({ channel: CHANNEL, binding })
      expect(fresh?.task.id).toBe(task.id)
      await tab.applyLiveEvents((await team.poll({ all: true, after: resumed.cursor })).events)
      expect(ids(queue().ready)).toEqual([])
      expect(ids(queue().claimed)).toEqual([task.id])
      expect(mobs()).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('stops showing a fenced lease to a scoped reader who never receives work control', async () => {
    const authority = testBoard()
    const team = await handle(authority)
    const { task } = await team.tasks.create(CHANNEL, 'A lease visible to a scoped reader')
    const claim = await team.as('worker').tasks.claim(task.id, { binding })
    const send = inProcess(authority)
    const scoped: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-board-can', `${CHANNEL}=read`)
      return send(input, { ...init, headers })
    }
    const reader = board({ backend: http(BOARD_URL, { fetch: bearer(scoped, await personToken('u_ada')) }) })
    const tab = await openTab(authority, 'u_ada', scoped)
    const scope = { channel: CHANNEL }
    const queue = () => queueOf(tab.getState(), scope, Date.now())
    const mobs = () => mobsOf(tab.getState(), scope, Date.now())
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const stop = tab.watchSwarm('mobs', scope)
    try {
      await vi.waitFor(() => expect(ids(queue().claimed)).toEqual([task.id]))
      expect(mobs()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(5000)
      const { cursor } = await reader.poll({ all: true, last: 1 })
      await team.pause('Fence the lease')
      await team.resume('Allow new work')
      const { events } = await reader.poll({ all: true, after: cursor })
      expect(events).toEqual([])
      await tab.applyLiveEvents(events)
      await vi.advanceTimersByTimeAsync(5000)
      await vi.waitFor(() => expect(ids(queue().ready)).toEqual([task.id]))
      expect(Date.parse(claim.until)).toBeGreaterThan(Date.now())
      expect(ids(queue().claimed)).toEqual([])
      expect(mobs()).toEqual([])
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('shows the queue after reselecting the active named profile during its first read', async () => {
    const authority = testBoard()
    const { task } = await authority.tasks.create(CHANNEL, 'Load under the worker profile')
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const send = inProcess(authority)
    const tab = await openTab(authority, 'u_ada', async (input, init) => {
      const response = await send(input, init)
      if (new URL(String(input)).pathname === '/api/board/tasks') {
        reached.resolve()
        await release.promise
      }
      return response
    })
    expect(await tab.setProfile({ name: 'worker' })).toBe(true)
    const opening = tab.loadSwarmTasks('open', {})
    try {
      await reached.promise
      expect(await tab.setProfile({ name: 'worker' })).toBe(true)
    } finally {
      release.resolve()
    }
    await opening
    expect(ids(queueOf(tab.getState(), {}, Date.now()).ready)).toEqual([task.id])
  })

  it('retries an unchanged decision when returning to the profile whose read finished away', async () => {
    const authority = testBoard({ attentionResponders: { [CHANNEL]: [ADA] } })
    const team = await handle(authority)
    const { task } = await team.tasks.create(CHANNEL, 'Review the request')
    const { attention } = await team.tasks.ask(task.id, draft(task, new Date(Date.now() + 120_000).toISOString()))
    const reached = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const send = inProcess(authority)
    const tab = await openTab(authority, 'u_ada', async (input, init) => {
      const response = await send(input, init)
      if (String(input).endsWith(`/tasks/${task.id}/attention`)) {
        reached.resolve()
        await released.promise
      }
      return response
    })
    await tab.loadSwarmTasks('open', {})
    const root = rootOf(tab.getState(), task.id)
    const first = tab.loadSwarmAttention(root)
    try {
      await reached.promise
      expect(store.attentionOf(tab.getState(), root)).toMatchObject({ is: 'loading' })
      expect(await tab.setProfile({ name: 'worker' })).toBe(true)
    } finally {
      released.resolve()
    }
    await first
    expect(store.attentionOf(tab.getState(), root)).toBeUndefined()
    expect(await tab.setProfile(null)).toBe(true)
    await tab.loadSwarmAttention(root)
    expect(decisionOf(tab.getState(), root)).toEqual(attention)
  })

  it('keeps the board’s refusal for a person missing from the channel’s responder list', async () => {
    const authority = testBoard({ attentionResponders: { [CHANNEL]: [ADA] } })
    const team = await handle(authority)
    const { task } = await team.tasks.create(CHANNEL, 'Review the rollout')
    await team.tasks.ask(task.id, draft(task, new Date(Date.now() + 120_000).toISOString()))
    const tab = await openTab(authority, 'u_bo')
    await tab.loadSwarmTasks('open', {})
    const root = rootOf(tab.getState(), task.id)
    await tab.loadSwarmAttention(root)
    const decision = decisionOf(tab.getState(), root)
    await tab.answerSwarmAttention(root, decision, 'proceed')
    expect(answerDisabled(tab.getState(), root, decision, Date.now())).toBe('only a configured responder acting as themselves with read and post access can answer task attention')
    expect((await team.tasks.attention(task.id)).attention?.status).toBe('pending')
  })

  it('offers Unblock for a later plain hold when the answered decision cannot be read', async () => {
    const data = memory()
    const configured = testBoard({ store: data, attentionResponders: { [CHANNEL]: [ADA] } })
    const team = await handle(configured)
    const { task } = await team.tasks.create(CHANNEL, 'Review the rollout')
    const { attention } = await team.tasks.ask(task.id, draft(task, new Date(Date.now() + 120_000).toISOString()))
    await team.tasks.answer(task.id, attention.id, { option: 'proceed', commit: COMMIT })
    // A plain hold can use even the same kind and words as the previous decision.
    await team.tasks.block(task.id, attention.question, { kind: attention.kind })
    const tab = await openTab(testBoard({ store: data }))
    await tab.loadSwarmTasks('open', {})
    const root = rootOf(tab.getState(), task.id)
    await tab.loadSwarmAttention(root)
    const state = tab.getState()
    expect(store.attentionOf(state, root)).toMatchObject({ is: 'failed', code: 'no_task_attention' })
    expect(store.moves(state, root, tab.viewerOf(state.me!), Date.now()).unblock).toBe(true)
    expect(await tab.unblockTask(root.id)).toBe(true)
    expect(ids(queueOf(tab.getState(), {}, Date.now()).ready)).toEqual([task.id])
  })

  it('gets the question from the task when the board no longer supports attention reads', async () => {
    const data = memory()
    const configured = testBoard({ store: data, attentionResponders: { [CHANNEL]: [ADA] } })
    const team = await handle(configured)
    const { task } = await team.tasks.create(CHANNEL, 'Review the rollout')
    await team.tasks.ask(task.id, draft(task, new Date(Date.now() + 120_000).toISOString()))
    const tab = await openTab(testBoard({ store: data }))
    await tab.loadSwarmTasks('open', {})
    const [root] = queueOf(tab.getState(), {}, Date.now()).decisions
    expect(root?.task.blocked?.reason).toBe('Continue?')
    await tab.loadSwarmAttention(root!)
    expect(store.attentionOf(tab.getState(), root!)).toMatchObject({ is: 'failed', code: 'no_task_attention', why: 'this board does not keep task attention requests' })
  })
})
