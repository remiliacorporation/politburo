import { expect, it } from 'vitest'
import { claimOrder } from '../src/inspect/app/claim-order.ts'
import { initialState, merge, type State, type TaskRoot, type Viewer } from '../src/inspect/app/store.ts'
import { filterWork } from '../src/inspect/app/work-filter.ts'
import { groupOf, homeOf, projectWork, type Observation, type SwarmRecords } from '../src/inspect/app/work.ts'

const now = Date.parse('2026-10-01T12:00:00Z')
const at = (offset: number) => new Date(now + offset).toISOString()
const principal = 'local:user:reader'
const actor = `${principal}+worker`
const viewer: Viewer = { principal, actor, profile: 'worker', may: () => true, person: true, manages: false }

function task(n: number, overrides: Partial<TaskRoot['task']> = {}): TaskRoot {
  return {
    id: String(n), channel: 'work', text: `Task ${n}`, thread: `t${n}`, re: null, replyTo: null,
    version: n, revision: n, createdAt: at(-60_000 + n), editedAt: null, deleted: false,
    by: { actor: principal, principal, profile: null }, author: null, origin: null, from: null,
    labels: { 'work.id': `wp-${n}`, 'board.task': overrides.state ?? 'ready' }, reactions: {},
    links: [], blocks: [], attachments: [], undelivered: {}, noSync: false,
    task: {
      state: 'ready', priority: 'normal', owner: principal, by: principal, for: null,
      needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null, ...overrides,
    },
  }
}

function snapshot(roots: TaskRoot[], cached = roots): State {
  return merge({ ...initialState, openTaskRoots: Object.fromEntries(roots.map((root) => [root.id, root])) }, cached)
}

const records = (observations: SwarmRecords['observations']): SwarmRecords => ({ source: 'fixtures', parties: {}, observations })
const openPassing: Observation['pr'] = { number: 42, state: 'open', checks: 'pass' }
const claimed = (n: number, offset: number) => task(n, { state: 'claimed', claim: { actor, until: at(offset) } })

it('matches every search term in the same open row, never a cached-only task', () => {
  const build = { ...claimed(1, 30_000), text: 'Compile assets', labels: { 'work.id': 'wp-1', party: 'blue' } }
  const notes = { ...task(2), text: 'Publish notes' }
  const cached = { ...build, id: '3', text: 'Archived build', labels: { ...build.labels, 'work.id': 'wp-3' } }
  const { rows } = projectWork(snapshot([build, notes], [build, notes, cached]), {
    ...records({ 'wp-1': { trackers: [{ kind: 'lin', id: 'ENG-812' }] } }),
    parties: { blue: { name: 'Blue Team', colour: '#00f' } },
  }, viewer, now)
  const matches = (text: string) => filterWork(rows, { text }).map(({ workId }) => workId)
  expect(matches('  WP-1  compile Blue\tworker ENG-812  ')).toEqual(['wp-1'])
  expect(matches('compile publish')).toEqual([])
  expect(matches('archived wp-3')).toEqual([])
})

it('shows each task once in triage order, without empty groups', () => {
  const state = snapshot([task(1), task(2), task(3), claimed(4, 30_000), task(5), task(6, { state: 'waiting', needs: ['5'] })])
  const { groups } = projectWork(state, records({
    // A human decision wins even when the PR would otherwise be ready for review.
    'wp-1': { humanRequest: true, pr: openPassing },
    'wp-2': { evidenceStale: true },
    'wp-3': { pr: openPassing },
  }), viewer, now)
  expect(groups.map(({ title, rows }) => [title, rows.map(({ workId }) => workId)])).toEqual([
    ['Needs you', ['wp-1']],
    ['Repair or reconcile', ['wp-2']],
    ['Ready to review', ['wp-3']],
    ['Running', ['wp-4']],
    ['Ready to pull', ['wp-5']],
    ['Waiting or parked', ['wp-6']],
  ])
})

it('keeps drafts and unchecked PRs out of review and sends failed CI to repair', () => {
  const root = task(1)
  const group = (pr: Observation['pr']) => groupOf(root, { pr }, viewer, now)
  for (const pr of [
    { ...openPassing, state: 'draft' },
    { ...openPassing, checks: 'pending' },
    { ...openPassing, checks: 'none' },
  ] as const) {
    expect(group(pr), `${pr.state} PR with ${pr.checks} checks`).not.toBe('review')
  }
  expect(group(openPassing)).toBe('review')
  expect(group({ ...openPassing, checks: 'fail' })).toBe('repair')
})

it('sends expired claims to repair and does not infer liveness from an unexpired claim', () => {
  const state = snapshot([claimed(1, -1), claimed(2, 30_000), claimed(3, 30_000)])
  const { rows } = projectWork(state, records({ 'wp-3': { leaseLive: true } }), viewer, now)
  expect(rows.find(({ workId }) => workId === 'wp-1')?.group).toBe('repair')
  expect(rows.find(({ workId }) => workId === 'wp-2')).toMatchObject({ group: 'running', reason: expect.stringMatching(/liveness not confirmed/i) })
  const live = rows.find(({ workId }) => workId === 'wp-3')
  expect(live?.group).toBe('running')
  expect(live?.reason).toMatch(/active/i)
})

it('counts a claim due in 20 minutes but not 40 as expiring, and a lapsed claim as stale rather than running', () => {
  const minute = 60_000
  const home = (roots: TaskRoot[]) => homeOf(projectWork(snapshot(roots), null, viewer, now).rows, null, now)
  const sooner = claimed(1, 20 * minute)
  const later = claimed(2, 40 * minute)
  const lapsed = claimed(3, -minute)
  expect(home([sooner]).counts.expiring).toBe(1)
  expect(home([later]).counts.expiring).toBe(0)
  expect(home([sooner, later, lapsed]).health.total.stale).toBe(1)
  expect(home([lapsed]).counts.running).toBe(0)
})

it('counts a lapsed claim in Needs you once in Health and never as Running', () => {
  const fixtures = records({ 'wp-1': { contract: 'invalid' } })
  const { groups, rows } = projectWork(snapshot([claimed(1, -60_000)]), fixtures, viewer, now)
  expect(groups.map(({ title }) => title)).toEqual(['Needs you'])
  const home = homeOf(rows, fixtures, now)
  expect(home.needs.map(({ title }) => title)).toEqual(['Task 1'])
  expect(home.health.total.stale).toBe(1)
  expect(home.counts.running).toBe(0)
  expect(home.running).toEqual([])
})

it('never shows a cached task outside the readable open list or a deleted task', () => {
  const visible = task(1)
  const absent = task(2)
  const deleted = { ...task(3), deleted: true }
  const state = snapshot([visible, deleted], [visible, absent, deleted])
  const { rows } = projectWork(state, records({ 'wp-2': { pr: openPassing }, 'wp-3': { pr: openPassing } }), viewer, now)
  expect(rows.map(({ workId }) => workId)).toEqual(['wp-1'])
})

it('lists Ready to pull in claim-next order without promoting work the viewer cannot claim', () => {
  const roots = [task(1, { priority: 'high' }), task(2, { priority: 'high', for: actor }),
    task(3, { priority: 'urgent' }), task(4, { priority: 'urgent', for: `${principal}+other` }), task(5)]
  const { groups } = projectWork(snapshot(roots), null, viewer, now)
  const pull = groups.find(({ title }) => title === 'Ready to pull')
  expect(pull?.rows.map(({ root }) => root.id)).toEqual(claimOrder(roots, viewer, now).map(({ id }) => id))
  expect(groups.find(({ title }) => title === 'Waiting or parked')?.rows.map(({ workId }) => workId)).toEqual(['wp-4'])
})

it('shows unknown spend and no PR without evidence, and flags recorded contract gaps only for work items', () => {
  const ordinary = task(4)
  delete ordinary.labels['work.id']
  const { rows } = projectWork(snapshot([task(1), task(2), task(3), ordinary]), records({
    'wp-2': { contract: 'missing' }, 'wp-3': { contract: 'invalid' },
  }), viewer, now)
  const row = (id: string) => rows.find(({ workId }) => workId === id)
  expect(row('wp-1')).toMatchObject({ spendText: 'unknown', prText: 'no PR', group: 'pull' })
  expect(row('wp-2')?.group).toBe('needs')
  expect(row('wp-3')?.group).toBe('needs')
  expect(row('#4')?.group).toBe('pull')
})
