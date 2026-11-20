import { expect, it, vi } from 'vitest'
import { localBoard } from './harness.ts'
import { BOARD_URL, localUserToken } from './tokens.ts'

it('pages a task thread from after its root, through unrelated events to its task changes', async () => {
  const team = localBoard()
  try {
    const token = await localUserToken()
    // Stand in for the browser's proxy transport, but let the real board answer the inspector's handle.
    vi.stubGlobal('document', { querySelector: () => null })
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:4747' })
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const headers = new Headers(request.headers)
      headers.set('authorization', `Bearer ${token}`)
      return team.fetch(new Request(`${BOARD_URL}${url.pathname.slice('/board'.length)}${url.search}`, { headers, method: request.method, signal: request.signal }))
    })
    const pageData = await import('../src/inspect/app/board.ts')
    const root = await team.post('work', { text: 'follow up' })
    // Enough unrelated activity in the same channel for the scan to have an empty page.
    for (let i = 0; i < 220; i++) await team.post('work', { text: `unrelated ${i}` })
    await team.tasks.create({ re: root.id })
    const reply = await team.reply(root.id, { text: 'starting now' })
    const claim = await team.tasks.claim(root.id, { lease: 60 })
    await claim.renew(120)
    await claim.complete('done')

    const seen: [string, string | undefined][] = []
    let after: string | undefined
    let advancedWithoutEvents = false
    for (let i = 0; i < 10; i++) {
      const page = await pageData.loadTaskHistory(root.id, after)
      if ('refused' in page) throw new Error(page.refused)
      for (const event of page.events) seen.push([event.type, event.message?.id])
      if (page.cursor === (after ?? root.id)) break
      if (page.events.length === 0) advancedWithoutEvents = true
      after = page.cursor
    }

    expect(seen).toEqual([
      ['task.created', root.id],
      ['message.posted', reply.id],
      ['task.claimed', root.id],
      ['task.renewed', root.id],
      ['task.completed', root.id],
    ])
    expect(advancedWithoutEvents).toBe(true)
  } finally {
    vi.unstubAllGlobals()
    await team.close()
  }
})
