import type { Route } from './routes.ts'
import { isTask, type State } from './store.ts'
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

/** Like the Cell's peek, check scope membership before display filters. */
export function cellHasThread(state: Pick<State, 'openTaskRoots' | 'messages'>, actor: string, id: string): boolean {
  const root = Object.hasOwn(state.openTaskRoots, id) ? state.openTaskRoots[id] : undefined
  if (!(isTask(root) && !root.deleted && root.task.claim?.actor === actor)) return false
  const known = Object.hasOwn(state.messages, id) ? state.messages[id] : undefined
  const newest = known !== undefined && known.version > root.version ? known : root
  return isTask(newest) && newest.task.claim?.actor === actor
}

/** Carry the preview across scopes, not the previous scope's filters or open row. */
export function workScopeUrl(path: string, from: URLSearchParams, party?: string | null) {
  const params = new URLSearchParams()
  if (party != null) params.set('party', party)
  if (from.get('swarm') === 'fixtures') params.set('swarm', 'fixtures')
  return params.size ? `${path}?${params}` : path
}
