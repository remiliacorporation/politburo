import { expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { needsAction } from '../src/inspect/app/needs.ts'
import { initialState, merge, type Viewer } from '../src/inspect/app/store.ts'
import { compileAccess } from '../src/server/access.ts'
import { BOARD_URL, personToken, testBoard } from './harness.ts'

it('shows all claim-next candidates in shared claim order across ready and overdue work', async () => {
  const board = testBoard() // No scheduler: elapsed leases can still wear `claimed`.
  const fetcher: typeof fetch = (input, init) => board.fetch(new Request(input, init))
  const token = await personToken('u_julian', BOARD_URL)
  const owner = createBoardClient({ url: BOARD_URL, token, profile: null, fetch: fetcher })
  const worker = createBoardClient({ url: BOARD_URL, token, profile: 'worker', fetch: fetcher })
  const outsider = createBoardClient({ url: BOARD_URL, token: await personToken('u_ada', BOARD_URL), profile: null, fetch: fetcher })
  const { actor, principal, profile, can } = await worker.me()
  const channel = 'work'
  try {
    const { task: lapsed } = await owner.tasks.create(channel, { text: 'Lapsed', priority: 'urgent' })
    const lease = await owner.tasks.claim(lapsed.id, { lease: 30 })
    const { task: active } = await owner.tasks.create(channel, { text: 'Held, lease still running', priority: 'urgent', claim: true })
    const { task: oldest } = await owner.tasks.create(channel, { text: 'First root', priority: 'high' })
    const { task: newer } = await owner.tasks.create(channel, { text: 'Second root', priority: 'high' })
    const { task: assigned } = await owner.tasks.create(channel, { text: 'Assigned high', priority: 'high', for: actor })
    const { task: lowest } = await owner.tasks.create(channel, { text: 'Lowest', priority: 'lowest' })
    await owner.tasks.create(channel, { text: 'Another profile’s task', priority: 'urgent', for: `${principal}+other` })
    await outsider.tasks.create(channel, { text: 'Another owner’s task', priority: 'urgent' })
    const { task: parked } = await owner.tasks.create(channel, { text: 'Parked', priority: 'urgent' })
    await owner.tasks.park(parked.id, 'Not scheduled yet')
    vi.setSystemTime(Date.parse(lease.until) + 1)

    const access = compileAccess(can)
    const viewer: Viewer = { actor, principal, profile, may: (permission, path) => access.can(permission, path), person: true, manages: false }
    const { tasks } = await worker.tasks.list({ channel, state: 'open' })
    const roots = tasks.map(({ message }) => message)
    const state = merge({ ...initialState, discovery: await worker.discovery(), status: await worker.status(), openTaskRoots: Object.fromEntries(roots.map((root) => [root.id, root])) }, roots)
    expect((await worker.thread(active.id)).message.task?.claim?.until).toBe(active.task?.claim?.until)
    const { stalled, ready } = needsAction(state, viewer, Date.now())
    expect(stalled).toEqual([])
    const taken: (string | undefined)[] = []
    for (const _ of [lapsed, assigned, oldest, newer, lowest]) taken.push((await worker.tasks.claim({ channel }))?.task.id)
    expect(taken).toEqual([lapsed.id, assigned.id, oldest.id, newer.id, lowest.id])
    expect(ready.map(({ id }) => id)).toEqual(taken)
    expect(await worker.tasks.claim({ channel })).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
