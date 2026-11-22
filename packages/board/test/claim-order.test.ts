import { expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { claimable, claimFirst, claimOrder } from '../src/inspect/app/claim-order.ts'
import type { TaskRoot, Viewer } from '../src/inspect/app/store.ts'
import { compileAccess } from '../src/server/access.ts'
import { BOARD_URL, personToken, testBoard } from './harness.ts'

// The page's claim order against the board's own claim-next, on a real in-process board with no
// scheduler: an elapsed lease still wears `claimed`, as it does on any board nothing has asked yet.
it('takes tasks in the order claim-next takes them, lapsed claims included', async () => {
  const board = testBoard()
  const fetcher: typeof fetch = (input, init) => board.fetch(new Request(input, init))
  const token = await personToken('u_julian', BOARD_URL)
  const owner = createBoardClient({ url: BOARD_URL, token, profile: null, fetch: fetcher })
  const worker = createBoardClient({ url: BOARD_URL, token, profile: 'worker', fetch: fetcher })
  const outsider = createBoardClient({ url: BOARD_URL, token: await personToken('u_ada', BOARD_URL), profile: null, fetch: fetcher })
  const { actor, principal, profile, can } = await worker.me()
  const channel = 'work'
  const make = async (text: string, priority: 'urgent' | 'high' | 'normal' | 'low' | 'lowest', rest: { for?: string; claim?: boolean; lease?: number } = {}) =>
    (await owner.tasks.create(channel, { text, priority, ...rest })).task
  const normal = await make('Normal', 'normal')
  const lapsedUrgent = await make('Urgent, lease will lapse', 'urgent')
  const lease = await owner.tasks.claim(lapsedUrgent.id, { lease: 30 })
  const held = await make('Held, lease running', 'urgent', { claim: true })
  const first = await make('First high', 'high')
  const second = await make('Second high', 'high')
  const mine = await make('High, for this profile', 'high', { for: actor })
  const lowest = await make('Lowest', 'lowest')
  await make('Another profile’s task', 'urgent', { for: `${principal}+other` })
  await outsider.tasks.create(channel, { text: 'Another owner’s task', priority: 'urgent' })
  const parked = await make('Parked', 'urgent')
  await owner.tasks.park(parked.id, 'Not scheduled yet')
  const now = Date.parse(lease.until) + 1

  const access = compileAccess(can)
  const viewer: Viewer = { actor, principal, profile, may: (permission, path) => access.can(permission, path), person: true, manages: false }
  const roots = (await worker.tasks.list({ channel, state: 'open' })).tasks.map(({ message }) => message) as TaskRoot[]
  const page = claimOrder(roots, viewer, now).map(({ id }) => id)
  expect(page).toEqual([lapsedUrgent.id, mine.id, first.id, second.id, normal.id, lowest.id])
  expect(claimFirst(roots, viewer, now).map(({ id }) => id).slice(0, page.length)).toEqual(page)
  expect(roots.filter((root) => !claimable(root, viewer, now)).map(({ id }) => id)).not.toContain(lapsedUrgent.id)

  // The board's claim-next, run on a clock past the lease, takes exactly that, one at a time.
  vi.setSystemTime(now)
  const taken: string[] = []
  try {
    for (;;) {
      const next = await worker.tasks.claim({ channel })
      if (!next) break
      taken.push(next.task.id)
    }
  } finally {
    vi.useRealTimers()
  }
  expect(taken).toEqual(page)
  expect(taken).not.toContain(held.id)
})
