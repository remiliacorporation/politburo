import type { ReactNode } from 'react'
import { Link } from './nav.tsx'
import { taskCounts, taskScope, type State } from './store.ts'
import { Header } from './ui.tsx'
import { boardWords } from './words.ts'

export function Presidium({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  const { name, at } = boardWords(state.discovery)
  const inScope = state.taskScope === taskScope()
  const counts = inScope && state.openTaskMe ? taskCounts(state, now) : null
  const problem = inScope ? state.tasksRefused : null
  return (
    <>
      <Header title="PRESIDIUM" lead={lead} live={state.live} />
      <div className="page home-view">
        <div>
          <section className="presidium-board" aria-labelledby="connected-board">
            <h2 id="connected-board"><Link to="/">{name}</Link></h2>
            {at && <p className="presidium-address">{at}</p>}
            {!state.discovery && <p>Board discovery is unavailable.</p>}
            {!counts && !problem && <p role="status">Loading tasks…</p>}
            {problem && <p role="status">task list unavailable: {problem}</p>}
            {counts && (
              <ul className="presidium-counts" role="list" aria-label="Task counts">
                {Object.entries(counts).map(([taskState, count]) => (
                  <li key={taskState}><Link to="/"><strong>{count}</strong> {taskState}</Link></li>
                ))}
              </ul>
            )}
          </section>
          <p>More boards appear here once this inspector can reach them.</p>
        </div>
      </div>
    </>
  )
}
