import { useLayoutEffect, type RefObject } from 'react'

export function useHoldPosition(list: RefObject<HTMLElement | null>, anchorId: string | null | undefined, attribute = 'data-task-id'): void {
  const row = () => anchorId == null ? null : list.current?.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(anchorId)}"]`)
  // Read the old DOM during render; the layout effect runs after React updates it, before paint.
  // An offscreen anchor (focused, then scrolled away) must not be held: compensating
  // for it would scroll the rows the reader can still see.
  const el = row()
  const top = el && inView(el) ? el.getBoundingClientRect().top : undefined
  useLayoutEffect(() => {
    if (top === undefined) return
    const anchor = row()
    if (!anchor) return
    const delta = anchor.getBoundingClientRect().top - top
    if (!delta) return

    const scroller = scrollerOf(anchor)
    if (scroller) holdScroll(scroller, list.current, delta)
  })
}

function scrollerOf(el: Element): Element | null {
  const doc = el.ownerDocument
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = doc.defaultView?.getComputedStyle(node)
    if (/^(auto|scroll|overlay)$/.test(style?.overflowY || style?.overflow || '')) return node
  }
  return doc.scrollingElement
}

function inView(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  const scroller = scrollerOf(el)
  const viewport = el.ownerDocument.defaultView?.innerHeight ?? 0
  const top = scroller ? scroller.getBoundingClientRect().top : 0
  const height = (scroller && scroller.clientHeight) || viewport
  return rect.bottom > top && rect.top < top + height
}

function holdScroll(scroller: Element, list: HTMLElement | null, delta: number): void {
  const target = scroller.scrollTop + delta
  if (list) {
    // Drop any previous pad so scrollHeight is the real content; then add only what
    // this correction still needs. Without it, a short page clamps scrollTop to 0.
    list.style.paddingBottom = ''
    const overflow = target + scroller.clientHeight - scroller.scrollHeight
    list.style.paddingBottom = target > 0 && overflow > 0 ? `${overflow}px` : ''
  }
  scroller.scrollTop = target
}
