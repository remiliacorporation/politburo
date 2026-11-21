import { useEffect, useState, type ReactNode } from 'react'
import * as board from './board.ts'
import { Link } from './nav.tsx'
import { taskCounts, type State, type TaskFilter } from './store.ts'
import { Header } from './ui.tsx'
import { boardWords } from './words.ts'

const filter: TaskFilter = { state: 'all', label: [] }

export function Presidium({ state, now, lead }: { state: State; now: number; lead: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    async function load() {
      let after: string | undefined
      while (active) {
        const page = await board.loadTasks(filter, after)
        if (!active) return
        if ('refused' in page) {
          setProblem(`task list unavailable: ${page.refused}`)
          break
        }
        if (!page.more) break
        if (!page.cursor || page.cursor === after) {
          setProblem('partial counts: the board did not advance the task list')
          break
        }
        after = page.cursor
      }
      setLoading(false)
    }
    void load()
    return () => { active = false }
  }, [])
  const { name, at } = boardWords(state.discovery)
  const counts = loading ? null : taskCounts(state, now)
  return (
    <>
      <Header title="PRESIDIUM" lead={lead} live={state.live} />
      <div className="page home-view">
        <div>
          <section className="presidium-board" aria-labelledby="connected-board">
            <h2 id="connected-board"><Link to="/">{name}</Link></h2>
            {at && <p className="presidium-address">{at}</p>}
            {!state.discovery && <p>Board discovery is unavailable.</p>}
            {!counts && <p role="status">Loading tasks…</p>}
            {problem && <p role="status">{problem}. Showing only tasks already known here.</p>}
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
