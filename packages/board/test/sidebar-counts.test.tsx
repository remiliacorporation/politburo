// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { route } from '../src/inspect/app/routes.ts'
import { Sidebar } from '../src/inspect/app/sidebar.tsx'
import { initialState, type TaskRoot } from '../src/inspect/app/store.ts'

let view: Root | undefined

afterEach(() => {
  view?.unmount()
  view = undefined
  vi.useRealTimers()
  document.body.replaceChildren()
})

it('moves a repo count when a lease ends', async () => {
  vi.useFakeTimers()
  const until = new Date(Date.now() + 2_000).toISOString()
  const task: TaskRoot = {
    id: '1', channel: 'rdn/backlog', text: 'Audit', thread: 't1', re: null, replyTo: null,
    version: 1, revision: 1, createdAt: new Date().toISOString(), editedAt: null, deleted: false,
    by: { actor: 'local:user:reader', principal: 'local:user:reader', profile: null },
    author: null, origin: null, from: null, labels: { 'board.task': 'claimed' }, reactions: {},
    links: [], blocks: [], attachments: [], undelivered: {}, noSync: false,
    task: {
      state: 'claimed', priority: 'normal', owner: 'local:user:reader', by: 'local:user:reader', for: null,
      needs: [], epoch: 1, claim: { actor: 'local:user:reader+worker', until }, blocked: null, result: null, reason: null,
    },
  }
  const state = {
    ...initialState,
    channels: { 'rdn/backlog': { path: 'rdn/backlog' } },
    openTaskRoots: { '1': task },
    me: {
      actor: 'local:user:reader', principal: 'local:user:reader', kind: 'person' as const, handle: 'reader', name: 'Reader',
      avatar: null, profile: null, expiresAt: null, can: {},
    },
  }
  document.body.innerHTML = '<div id="root"></div>'
  view = createRoot(document.getElementById('root')!)
  const count = () => document.querySelector('a[href="/r/rdn"] .count')?.textContent
  await act(async () => { view!.render(<Sidebar state={state} current={route('/')} onHome={() => undefined} onCollapse={() => undefined} />) })
  expect(count()).toBe('0 · 1 · 0')
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  expect(count()).toBe('0 · 0 · 0')
})
