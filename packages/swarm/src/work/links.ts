export type LinkKind = 'issue' | 'branch' | 'pull_request' | 'evidence'

export type Link = {
  kind: LinkKind
  source: string
  scope: string
  ref: string
  basis: 'explicit' | 'stable_ref'
}

// Use only an explicit association or a stable source reference. Never link by title.
export function addLink(links: readonly Link[], link: Link): Link[] {
  const { kind, source, scope, ref, basis } = link
  if (basis !== 'explicit' && basis !== 'stable_ref') {
    throw new TypeError('A link needs an explicit association or a stable reference.')
  }
  if ([kind, source, scope, ref, basis].some(field => typeof field !== 'string' || !field.trim() || field.length > 512)) {
    throw new TypeError('Link fields must be nonblank and at most 512 characters.')
  }
  if (links.some(existing => existing.kind === kind && existing.source === source &&
    existing.scope === scope && existing.ref === ref)) {
    return [...links]
  }
  return [...links, link]
}
