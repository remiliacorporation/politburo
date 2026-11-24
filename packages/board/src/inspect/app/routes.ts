/** The sections of the board's settings, each a tab at `/settings/<section>`. */
export const SECTIONS = ['access', 'schemas', 'schedules', 'watchers', 'sync'] as const
export type Section = (typeof SECTIONS)[number]

/** The view a path names. Settings includes its section and what's open in it. */
export type Route =
  | { view: 'needs' }
  | { view: 'handoffs' }
  | { view: 'presidium' }
  | { view: 'party'; party: string }
  | { view: 'cell'; cell: string }
  | { view: 'work' }
  | { view: 'tasks' }
  | { view: 'attention' }
  | { view: 'channel'; channel: string }
  | { view: 'settings'; section: Section; open: string | null }
  | { view: 'missing' }

export function route(path: string): Route {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return { view: 'missing' }
  }
  if (decoded === '/') return { view: 'needs' }
  if (decoded === '/handoffs') return { view: 'handoffs' }
  if (decoded === '/presidium') return { view: 'presidium' }
  if (decoded.startsWith('/party/') && decoded.length > 7) return { view: 'party', party: decoded.slice(7) }
  if (decoded.startsWith('/cell/') && decoded.length > 6) return { view: 'cell', cell: decoded.slice(6) }
  if (decoded === '/work') return { view: 'work' }
  if (decoded === '/tasks') return { view: 'tasks' }
  if (decoded === '/attention') return { view: 'attention' }
  if (decoded.startsWith('/c/') && decoded.length > 3) return { view: 'channel', channel: decoded.slice(3) }
  const [, settings, section, ...rest] = decoded.split('/')
  if (settings === 'settings' && (SECTIONS as readonly string[]).includes(section ?? 'access'))
    return { view: 'settings', section: (section ?? 'access') as Section, open: rest.join('/') || null }
  return { view: 'missing' }
}
