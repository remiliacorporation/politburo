import { actorIcon } from './icons.ts'

/** The name, with its 16 px species or item icon when the name is a mob or sprite id. */
export function ActorName({ name }: { name: string }) {
  const mark = actorIcon(name)
  if (!mark) return name
  const svg = mark.svg.replace('<svg ', `<svg role="img" aria-label="${mark.label}" focusable="false" `)
  return (
    <span className="actor-name">
      <span className="actor-icon" dangerouslySetInnerHTML={{ __html: svg }} />
      {name}
    </span>
  )
}
