import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as board from './board.ts'
import { buttonSoundsEnabled, setButtonSounds } from './button-feedback.ts'
import { Access } from './grants.tsx'
import { Link, SECTIONS, type Section, type Where } from './nav.tsx'
import { Schemas } from './schemas.tsx'
import { nameOf, type State, type Viewer } from './store.ts'
import { Header, nativeMenu, Unlisted } from './ui.tsx'

// The board's configuration: who gets in, what blocks can hold, and what watches. One view, a tab per section.

const ActionsSlot = createContext<HTMLElement | null>(null)

/** A section's own actions, at the end of the tabs' row. */
export function Actions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot)
  return slot ? createPortal(children, slot) : null
}

export function Settings(props: { state: State; viewer: Viewer; lead: ReactNode; where: Where; section: Section; open: string | null }) {
  const { state, viewer, section } = props
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [sounds, setSounds] = useState(buttonSoundsEnabled)
  const sections = SECTIONS.filter((name) => name !== 'watchers' || viewer.manages || section === 'watchers')
  return (
    <>
      <Header title="settings" lead={props.lead} flat>
        <label className="button-sounds">
          <input type="checkbox" checked={sounds} onChange={(event) => {
            setButtonSounds(event.target.checked)
            setSounds(event.target.checked)
          }} />
          button sounds
        </label>
      </Header>
      <nav className="tabs">
        {sections.map((name) => (
          <Link key={name} to={`/settings/${name}`} className="tab" current={name === section}>
            {name}
          </Link>
        ))}
        <span className="tab-actions" ref={setSlot} />
      </nav>
      <ActionsSlot.Provider value={slot}>
        <div className="page">
          {section === 'access' && <Access state={state} viewer={viewer} where={props.where} />}
          {section === 'schemas' && <Schemas state={state} viewer={viewer} selected={props.open} />}
          {section === 'watchers' && <Watchers state={state} />}
        </div>
      </ActionsSlot.Provider>
    </>
  )
}

// --- watchers ----------------------------------------------------------------------------------

/** What boards elsewhere registered here, and what each tails. Read-only: a board registers its own. */
function Watchers({ state }: { state: State }) {
  useEffect(() => {
    void board.loadWatchers()
  }, [])
  const listed = state.watchers
  return (
    <>
      <Unlisted listed={listed} />
      {listed.is === 'here' && listed.items.length === 0 && <p className="empty">no watchers registered</p>}
      {listed.is === 'here' &&
        listed.items.map((registration) => (
          <section key={registration.owner} className="registration" {...nativeMenu}>
            <h3>
              <b>{nameOf(state, registration.owner)}</b>
              {registration.path ? ` · woken at ${registration.path}${registration.branch ? ` (${registration.branch})` : ''}` : registration.url ? ` · woken at ${registration.url}` : ' · pulls on its own'}
            </h3>
            {Object.entries(registration.watch).map(([id, watcher]) => (
              <div key={id} className="watch-row">
                <span className="watch-id">{id}</span>
                <code>{watcher.tail}</code>
              </div>
            ))}
            {registration.sync.map((entry) => (
              <div key={entry.key} className="watch-row">
                <span className="watch-id">{entry.key}</span>
                <span className="faint">syncs {entry.platform}</span>
              </div>
            ))}
          </section>
        ))}
    </>
  )
}
