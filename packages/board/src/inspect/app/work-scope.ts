import type { Route } from './routes.ts'
import { labelsOf, partyOf, type SwarmRecords } from './work.ts'

export type WorkRoute = Extract<Route, { view: 'work' | 'presidium' | 'party' | 'cell' }>

export function isWorkRoute(route: Route): route is WorkRoute {
  return route.view === 'work' || route.view === 'presidium' || route.view === 'party' || route.view === 'cell'
}

export function repoPartyOf(records: SwarmRecords | null, requested: string | null): string | null {
  if (requested !== null) return partyOf(records, requested) ? requested : null
  const parties = Object.keys(records?.parties ?? {})
  return parties.length === 1 ? parties[0]! : null
}

export function workScope(route: WorkRoute, params: URLSearchParams, records: SwarmRecords | null, boardName: string) {
  const partyId = route.view === 'party' ? route.party
    : route.view === 'work' ? null : repoPartyOf(records, params.get('party'))
  const party = partyOf(records, partyId)
  const labels = labelsOf(records, partyId, boardName)
  const words = route.view === 'party' ? labels.partyBoard
    : route.view === 'presidium' ? labels.repoView
    : route.view === 'cell' ? labels.mobView : { label: 'Work', subtitle: undefined }
  return { party, partyId, title: words.label, subtitle: words.subtitle }
}

/** Carry the preview across scopes, not the previous scope's filters or open row. */
export function workScopeUrl(path: string, from: URLSearchParams, party?: string | null) {
  const params = new URLSearchParams()
  if (party != null) params.set('party', party)
  if (from.get('swarm') === 'fixtures') params.set('swarm', 'fixtures')
  return params.size ? `${path}?${params}` : path
}
