type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

const JUMPS = { n: 'needs', r: 'review', u: 'running', w: 'pull', q: 'queue' } as const

export function keyAction(event: Key, pending: string | null, typing: boolean) {
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return null
  const { key } = event
  if (pending === 'g' && Object.hasOwn(JUMPS, key)) return { type: 'jump', to: JUMPS[key as keyof typeof JUMPS] } as const
  switch (key) {
    case 'j': case 'ArrowDown': return { type: 'move', by: 1 } as const
    case 'k': case 'ArrowUp': return { type: 'move', by: -1 } as const
    case 'Enter': return { type: 'thread' } as const
    case ' ': return { type: 'peek' } as const
    case 'Escape': return { type: 'escape' } as const
    case '/': return { type: 'filter' } as const
    case 'g': return { type: 'prefix', key } as const
    case '[': case ']': return { type: 'collapse', closed: key === '[' } as const
    case 'o': return { type: 'link', link: 'source' } as const
    case 'p': return { type: 'link', link: 'pr' } as const
    case 'e': return { type: 'link', link: 'evidence' } as const
    case '?': return { type: 'help' } as const
    default: return null
  }
}
