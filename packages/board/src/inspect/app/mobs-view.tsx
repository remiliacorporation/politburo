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
      <Link className="text-link" to={workScopeUrl(`/cell/${encodeURIComponent(mob.actorId)}`, params)}>{mob.id}</Link>
      <p>species {mob.species}</p>
      <p>class {mob.className}</p>
      <p>party {mob.party ?? 'no party'}</p>
      <p>repo {mob.repo ?? 'no repo'}</p>
      <div>
        {mob.holds.length === 0 ? (
          <>
            <p>holds nothing</p>
            <p>no claim</p>
            <p>no PR</p>
          </>
        ) : mob.holds.map((hold) => (
          <div key={hold.taskId}>
            <p>holds {hold.title}</p>
            <p>{hold.countdown}</p>
            <p>{hold.pr}</p>
            {hold.stalled && <p>{hold.reason}</p>}
          </div>
        ))}
      </div>
      <p>{mob.status}</p>
      {mob.sprites.length === 0 ? <p>no sprites</p> : (
        <ul className="mob-sprites">
          {mob.sprites.map((sprite) => (
            <li key={sprite.id}>
              <img alt="" width={16} height={16} src={iconSrc(sprite.item, 16)} />
              <span>{sprite.id}</span>
            </li>
          ))}
        </ul>
      )}
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
      <div className="view-body mob-map">
        {state.actorsRefused && <p className="empty" role="status">{state.actorsRefused}</p>}
        {state.partyConfigRefused && <p className="empty" role="status">{state.partyConfigRefused}</p>}
        {state.tasksRefused && <p className="empty" role="status">{state.tasksRefused}</p>}
        {waiting ? <p className="empty" role="status">loading…</p> : groups.length === 0 ? <p className="empty">no mobs</p> : groups.map((group) => (
          <section key={group.party}>
            <h2>{group.party}</h2>
            {group.repos.map((repo) => (
              <section key={repo.repo}>
                <h3>{repo.repo}</h3>
                {repo.mobs.map((mob) => <Card key={mob.id} mob={mob} params={params} />)}
              </section>
            ))}
          </section>
        ))}
      </div>
    </>
  )
}
