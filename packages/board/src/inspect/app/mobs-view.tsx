import { useEffect, type ReactNode } from 'react'
import { iconFor } from './icons.ts'
import * as board from './board.ts'
import { Link, useLocation } from './nav.tsx'
import { mobRoster, PARTY_CONFIG_CHANNEL, poolsFromMessages, refusedPools, type MobCard } from './mobs.ts'
import type { State } from './store.ts'
import { Header } from './ui.tsx'
import { workScopeUrl } from './work-scope.ts'

function iconSrc(name: string, size: 16 | 64): string {
  return `data:image/svg+xml,${encodeURIComponent(iconFor(name, size))}`
}

function Card({ mob, params }: { mob: MobCard; params: URLSearchParams }) {
  return (
    <article className="mob-card">
      <img className="pixel" alt="" width={64} height={64} src={iconSrc(mob.species, 64)} />
      <div className="mob-facts">
        <p className="mob-name">
          <Link className="text-link" to={workScopeUrl(`/cell/${encodeURIComponent(mob.actorId)}`, params)}>{mob.id}</Link>
          <span className={`mob-state ${mob.status}`}>{mob.status}</span>
        </p>
        <p>species {mob.species} · class {mob.className}</p>
        <p>party {mob.party ?? 'no party'} · repo {mob.repo ?? 'no repo'}</p>
        {mob.holds.length === 0 ? <p>holds nothing · no claim · no PR</p> : mob.holds.map((hold) => (
          <p key={hold.taskId}>holds {hold.title} · {hold.countdown} · {hold.pr}{hold.stalled ? ` · ${hold.reason}` : ''}</p>
        ))}
        {mob.sprites.length === 0 ? <p>no sprites</p> : (
          <ul className="mob-sprites">
            {mob.sprites.map((sprite) => (
              <li key={sprite.id}>
                <img alt="" width={16} height={16} src={iconSrc(sprite.item, 16)} />
                <span className="mob-sprite-id">{sprite.id}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

/** The mob map. It only reads: actors, open claims, and the party config message. */
export function Mobs({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  const { params } = useLocation()
  useEffect(() => { void board.loadConfigChannel(PARTY_CONFIG_CHANNEL) }, [])
  const waiting = !state.tasksCounted || !state.actorsLoaded
  const groups = mobRoster(state, now, board.swarmRecords(), state.partyConfigRefused ? refusedPools : poolsFromMessages(state.messages))
  return (
    <>
      <Header title="mobs" lead={lead} live={state.live} />
      <div className="page mob-map">
        {state.actorsRefused && <p className="empty" role="status">{state.actorsRefused}</p>}
        {state.partyConfigRefused && <p className="empty" role="status">{state.partyConfigRefused}</p>}
        {state.tasksRefused && <p className="empty" role="status">{state.tasksRefused}</p>}
        {waiting ? <p className="empty" role="status">loading…</p> : groups.length === 0 ? <p className="empty">no mobs</p> : groups.map((group) => (
          <section key={group.party}>
            <h2>{group.party}</h2>
            {group.repos.map((repo) => (
              <section key={repo.repo}>
                <h3>{repo.repo}</h3>
                <div className="mob-grid">
                  {repo.mobs.map((mob) => <Card key={mob.id} mob={mob} params={params} />)}
                </div>
              </section>
            ))}
          </section>
        ))}
      </div>
    </>
  )
}
