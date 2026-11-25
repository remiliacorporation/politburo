// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Header } from '../src/inspect/app/ui.tsx'

describe('the feed badge', () => {
  it('says which way the feed is connected', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    flushSync(() => { root.render(<Header title="Board" live="polling" />) })
    const polling = host.querySelector('.live')
    expect(polling?.textContent).toBe('polling')
    expect(polling?.getAttribute('title')).toBe('the stream is buffered, so this follows by long-poll')
    flushSync(() => { root.render(<Header title="Board" live="live" />) })
    expect(host.querySelector('.live')?.textContent).toBe('live')
    expect(host.querySelector('.live')?.getAttribute('title')).toBe('receiving board events')
    root.unmount()
  })
})
