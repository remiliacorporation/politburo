import { afterEach, expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import type { AttentionDraft, MessageView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { claimed, initialState, isTask, merge, moves, type Viewer } from '../src/inspect/app/store.ts'
import { compileAccess } from '../src/server/access.ts'
import { bearer, board, BOARD_URL, personToken, testAuth, testLocal } from './harness.ts'

const SCOPER = 'vercel:user:u_scoper'
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const close of closes.splice(0).reverse()) await close()
})

async function setup(staged = true) {
  const backend = local({
    memory: true,
    ...(staged ? { workLifecycle: { scopers: [SCOPER] }, attentionResponders: { work: [SCOPER] } } : {}),
  })
  closes.push(() => backend.close())
  const server = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ ...testAuth, local: testLocal }) })
  const connect = async (person: string) => bearer((input, init) => server.fetch(new Request(input, init)), await personToken(person))
  const [scope, work] = await Promise.all([connect('u_scoper'), connect('u_worker')])
  const handle = (fetch: typeof scope) => board({ backend: http(BOARD_URL, { fetch }) }).as(null)
  return { scope, scoper: handle(scope), worker: handle(work) }
}

async function viewer(handle: Awaited<ReturnType<typeof setup>>['worker']): Promise<Viewer> {
  const { actor, principal, profile, can } = await handle.me()
  const access = compileAccess(can)
  return { actor, principal, profile, may: (permission, channel) => access.can(permission, channel), manages: access.at('manage', '*'), person: true }
}

function controls(root: MessageView, who: Viewer, state = initialState, now = Date.now()) {
  if (!isTask(root)) throw new Error('expected a task')
  return Object.entries(moves(state, root, who, now)).flatMap(([move, yes]) => yes ? [move] : [])
}

function draft(root: MessageView): AttentionDraft {
  return {
    kind: 'needs_input', question: 'Which route should we use?', context: 'Either route needs scope.',
    options: [
      { id: 'a', label: 'Route A', consequence: 'Use route A', next: 'resume' },
      { id: 'b', label: 'Route B', consequence: 'Use route B', next: 'resume' },
    ],
    revision: root.revision, evidence: [{ message: root.id, revision: root.revision }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), commit: 'a'.repeat(40),
  }
}

it('offers only stage-appropriate moves and keeps legacy controls', async () => {
  const { scoper, worker } = await setup()
  const who = await viewer(worker)
  expect(who.may('manage', 'work')).toBe(true)
  expect(await worker.discovery()).toMatchObject({ workLifecycle: 1 })

  const { worker: legacy } = await setup(false)
  const ready = (await legacy.tasks.create('work', 'Legacy work')).task
  expect(controls(ready, who)).toEqual(['claim', 'park', 'priority', 'hold', 'assign', 'cancel'])
  const failed = await (await legacy.tasks.claim(ready.id)).fail('Try again later')
  expect(controls(failed, who)).toEqual(['reopen', 'cancel'])

  const proposed = (await worker.tasks.create('work', 'Staged work')).task
  const { id } = proposed
  const scoped = await scoper.tasks.scope(id, 'Scope is ready')
  const claim = await worker.tasks.claim(id)
  const tab = claimed(initialState, claim.task, { epoch: claim.epoch })
  expect.soft(controls(claim.task, who, tab)).toEqual(['held', 'settle', 'park'])
  expect.soft(controls(claim.task, await viewer(worker.as('different-profile')), tab)).toEqual(['priority'])
  const handoff = await claim.complete()
  const review = await scoper.tasks.stage(id, 'review', 'Review started')
  const qa = await scoper.tasks.stage(id, 'qa', 'Test the patch')
  const repair = await scoper.tasks.stage(id, 'repair', 'Address feedback')
  await (await worker.tasks.claim(id)).complete()
  await scoper.tasks.stage(id, 'review', 'Review the repair')
  const approved = await scoper.tasks.stage(id, 'approved', 'Review passed')
  const done = await scoper.tasks.stage(id, 'done', 'Shipped')
  const rejected = await scoper.tasks.stage((await worker.tasks.create('work', 'Not ready')).task.id, 'rejected', 'Out of scope')
  const canceled = await scoper.tasks.cancel((await worker.tasks.create('work', 'Not needed')).task.id, 'No longer needed')

  expect(Object.fromEntries([proposed, scoped, handoff, review, qa, repair, approved, done, rejected, canceled].map((root) =>
    [root.task?.work?.stage, controls(root, who)],
  ))).toEqual({
    proposed: ['park', 'priority', 'hold'], scoped: ['claim', 'park', 'priority', 'hold'], handoff: ['park', 'priority'], review: ['park', 'priority'], qa: ['park', 'priority'],
    repair: ['claim', 'park', 'priority', 'hold'], approved: ['park', 'priority'], done: [], rejected: [], canceled: [],
  })
})

it('offers completion on a held staged task only with known completed prerequisites', async () => {
  const { scoper, worker } = await setup()
  const who = await viewer(worker)
  const { task: prerequisite } = await worker.tasks.create('work', 'Write the guide')
  const { task: dependent } = await worker.tasks.create('work', { text: 'Publish the guide', needs: [prerequisite.id] })
  await scoper.tasks.scope(prerequisite.id, 'Scope the guide')
  await (await worker.tasks.claim(prerequisite.id)).complete()
  await scoper.tasks.stage(prerequisite.id, 'review', 'Start review')
  await scoper.tasks.stage(prerequisite.id, 'approved', 'Review passed')
  const done = await scoper.tasks.stage(prerequisite.id, 'done', 'Guide written')
  await scoper.tasks.scope(dependent.id, 'Scope publication')
  const claim = await worker.tasks.claim(dependent.id)
  const tab = claimed(initialState, claim.task, { epoch: claim.epoch })
  expect.soft(controls(claim.task, who, tab), 'unloaded prerequisite').not.toContain('settle')

  const loaded = merge(tab, [done])
  expect.soft(controls(claim.task, who, loaded), 'completed prerequisite').toContain('settle')
  const reopened = await scoper.tasks.reopen(prerequisite.id, 'The guide needs updates')
  const afterReopen = controls(claim.task, who, merge(loaded, [reopened]))
  expect.soft(afterReopen, 'reopened prerequisite').not.toContain('settle')
  expect(afterReopen).toContain('held') // Release and renew remain available.

  const { worker: legacy } = await setup(false)
  const { task: legacyNeed } = await legacy.tasks.create('work', 'Write the announcement')
  await (await legacy.tasks.claim(legacyNeed.id)).complete()
  const { task: legacyDependent } = await legacy.tasks.create('work', { text: 'Post the announcement', needs: [legacyNeed.id] })
  const legacyClaim = await legacy.tasks.claim(legacyDependent.id)
  const legacyTab = claimed(initialState, legacyClaim.task, { epoch: legacyClaim.epoch })
  expect(controls(legacyClaim.task, who, legacyTab), 'legacy work with an unloaded prerequisite').toContain('settle')
})

it('offers unblock for a staged plain hold but not for parked or structured holds', async () => {
  const { scoper, worker } = await setup()
  const who = await viewer(scoper)
  const { task: root } = await worker.tasks.create('work', 'Waiting for an answer')
  const { id } = root
  const plain = await scoper.tasks.block(id, 'Need a decision')
  expect(controls(plain, who)).toContain('unblock')
  await scoper.tasks.unblock(id)
  const parked = await scoper.tasks.park(id, 'Wait for maintenance')
  expect(controls(parked, who)).not.toContain('unblock')
  await scoper.tasks.unpark(id, 'Maintenance finished')
  const { task: structured } = await worker.tasks.ask(id, draft(root))
  expect(controls(structured, who)).not.toContain('unblock')
})

it('hides unblock only while the attention request is pending', async () => {
  const { scoper, worker } = await setup()
  const who = await viewer(scoper)
  const { task: root } = await worker.tasks.create('work', 'Choose a route')
  const { id } = root
  const { task: held, attention } = await worker.tasks.ask(id, draft(root))
  const expiry = Date.parse(attention.expiresAt)
  // A board may still send the deadline in its task view.
  const withDeadline = { ...held, task: held.task && { ...held.task, attentionExpiresAt: attention.expiresAt } }
  expect.soft(controls(withDeadline, who, initialState, expiry - 1), 'pending request').not.toContain('unblock')
  expect.soft(controls(withDeadline, who, initialState, expiry + 1), 'expired but still pending').not.toContain('unblock')

  await scoper.tasks.answer(id, attention.id, { option: 'a', commit: attention.commit })
  const afterAnswer = await worker.tasks.block(id, 'Wait for a release window')
  expect.soft(controls(afterAnswer, who), 'plain hold after an answer').toContain('unblock')
  await worker.tasks.unblock(id)

  await worker.tasks.ask(id, draft(root))
  await scoper.tasks.stage(id, 'rejected', 'The work is no longer needed')
  await scoper.tasks.reopen(id, 'The work is back on the plan')
  const afterCancel = await worker.tasks.block(id, 'Wait for new requirements')
  expect(controls(afterCancel, who), 'plain hold after cancellation').toContain('unblock')
})

it('hides unblock on an older board that only reports the attention ID', async () => {
  const { scoper, worker } = await setup()
  const who = await viewer(scoper)
  const { task: root } = await worker.tasks.create('work', 'Choose a route')
  const { task: held } = await worker.tasks.ask(root.id, draft(root))
  if (!held.task) throw new Error('expected a task')
  delete held.task.attentionStatus
  expect(controls(held, who)).not.toContain('unblock')
})

it('sends no bare reopen for rejected staged work, even as a scoper', async () => {
  const { scope, scoper, worker } = await setup()
  const { task: root } = await worker.tasks.create('work', 'Not in scope')
  const { id } = root
  const rejected = await scoper.tasks.stage(id, 'rejected', 'Out of scope')
  const reopens: unknown[] = []
  // Only the browser and its proxy are substituted. The inspector calls the actual board.
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:4747' })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url)
    const forwarded = new Request(`${BOARD_URL}${url.pathname.slice('/board'.length)}${url.search}`, init)
    if (forwarded.method === 'POST' && url.pathname === `/board/tasks/${id}/reopen`) reopens.push(await forwarded.clone().json())
    return scope(forwarded)
  })
  const page = await import('../src/inspect/app/board.ts')
  await page.loadThread(id)
  expect(page.getState().messages[id]?.version).toBe(rejected.version)
  await page.reopenTask(id)
  expect(reopens).toEqual([])
})
