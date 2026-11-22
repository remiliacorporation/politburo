import { useLayoutEffect, type RefObject } from 'react'

export function useHoldPosition(list: RefObject<HTMLElement | null>, anchorId: string | null | undefined, attribute = 'data-task-id'): void {
  const row = () => anchorId == null ? null : list.current?.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(anchorId)}"]`)
  // Read the old DOM during render; the layout effect runs after React updates it, before paint.
  const top = row()?.getBoundingClientRect().top
  useLayoutEffect(() => {
    if (top === undefined) return
    const anchor = row()
    if (!anchor) return
    const delta = anchor.getBoundingClientRect().top - top
    if (!delta) return

    const doc = anchor.ownerDocument
    for (let el = anchor.parentElement; el; el = el.parentElement) {
      const style = doc.defaultView?.getComputedStyle(el)
      if (/^(auto|scroll|overlay)$/.test(style?.overflowY || style?.overflow || '')) {
        el.scrollTop += delta
        return
      }
    }
    if (doc.scrollingElement) doc.scrollingElement.scrollTop += delta
  })
}
