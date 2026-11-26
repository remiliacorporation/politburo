import { useEffect, useState } from 'react'
import { actorIcon, paintedIcon } from './icons.ts'

/** The name, with its 16 px species or item icon when the name is a mob or sprite id. */
export function ActorName({ name }: { name: string }) {
  const mark = actorIcon(name)
  const [svg, setSvg] = useState(mark?.svg ?? '')
  useEffect(() => {
    if (!mark) return
    let live = true
    setSvg(mark.svg)
    void paintedIcon(mark.label, 16).then((next) => {
      if (live) setSvg(next)
    })
    return () => {
      live = false
    }
  }, [name, mark?.label, mark?.svg])
  if (!mark) return name
  const drawn = svg.replace('<svg ', `<svg role="img" aria-label="${mark.label}" focusable="false" `)
  return (
    <span className="actor-name">
      <span className="actor-icon" dangerouslySetInnerHTML={{ __html: drawn }} />
      {name}
    </span>
  )
}
