import { CircleHelp, ClipboardList, House, ListTodo, LayoutGrid, PanelLeftClose, Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ChannelView } from '../../api/routes.ts'
import { attentionTasks, hasUnshownRefusal } from './attention-store.ts'
import { toast } from './chrome.ts'
import { HomeEmblem } from './home-emblem.tsx'
import { Avatar } from './message.tsx'
import { Link, type Route } from './nav.tsx'
import { openTasks, type State } from './store.ts'
import { ContextMenuArea, MenuItem } from './ui.tsx'
import { boardWords, shownName } from './words.ts'

// --- sidebar -------------------------------------------------------------------------

function useSeen(state: State, current: Route): Record<string, number> {
  const storage = `board.seen:${state.discovery?.url ?? location.host}`
  const [seen, setSeen] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storage) ?? 'null') ?? {}
    } catch {
      return {}
    }
  })
  const save = (next: Record<string, number>) => {
    setSeen(next)
    try {
      localStorage.setItem(storage, JSON.stringify(next))
    } catch {}
  }
  // The first visit marks everything read; after that, dots mean news.
  useEffect(() => {
    const channels = Object.values(state.channels)
    if (Object.keys(seen).length === 0 && channels.length > 0)
      save(Object.fromEntries(channels.map((channel) => [channel.path, channel.lastIndex ?? 0])))
  }, [state.channels])
  useEffect(() => {
    if (current.view !== 'channel') return
    const channel = state.channels[current.channel]
    if (channel?.lastIndex !== undefined && (seen[channel.path] ?? 0) < channel.lastIndex) save({ ...seen, [channel.path]: channel.lastIndex })
  }, [current, state.channels])
  return seen
}

export function Sidebar({ state, current, onHome, onCollapse }: { state: State; current: Route; onHome: () => void; onCollapse: () => void }) {
  const seen = useSeen(state, current)
  const groups = useMemo(() => {
    const out = new Map<string, ChannelView[]>()
    for (const channel of Object.values(state.channels).sort((a, b) => a.path.localeCompare(b.path))) {
      const at = channel.path.lastIndexOf('/')
      const group = at === -1 ? 'channels' : channel.path.slice(0, at)
      out.set(group, [...(out.get(group) ?? []), channel])
    }
    return [...out]
  }, [state.channels])
  const open = openTasks(state)
  const attention = useMemo(() => attentionTasks(state).length, [state.messages])
  const where = boardWords(state.discovery)
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(`copied ${text}`))
  return (
    <>
      <div className="brand">
        <HomeEmblem onNavigate={onHome} />
        <Link to="/" className="wordmark" title={where.at ? `${where.name} · ${where.at}` : where.name} onNavigate={onHome}>
          POLITBURO
        </Link>
        <button type="button" className="tool" title="Hide sidebar" aria-label="Hide sidebar" onClick={onCollapse}>
          <PanelLeftClose size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="view-body">
      <div className="sidebar-scroll">
        <Link to="/" className="item" current={current.view === 'needs'}>
          <ListTodo size={14} aria-hidden="true" />
          <span>Needs action</span>
        </Link>
        <Link to="/presidium" className="item" current={current.view === 'presidium'}>
          <LayoutGrid size={14} aria-hidden="true" />
          <span>Presidium</span>
        </Link>
        <Link to="/handoffs" className="item" current={current.view === 'handoffs'}>
          <House size={14} aria-hidden="true" />
          <span>Handoffs</span>
        </Link>
        <Link to="/tasks" className="item" current={current.view === 'tasks'}>
          <ClipboardList size={14} aria-hidden="true" />
          <span className="name">tasks</span>
          {open !== null && open > 0 && <span className="count">{open}</span>}
        </Link>
        <Link to="/attention" className="item" current={current.view === 'attention'}>
          <CircleHelp size={14} aria-hidden="true" />
          <span className="name">attention</span>
          {attention > 0 && <span className="count">{attention}</span>}
          {hasUnshownRefusal(state) && <span className="faint">refused</span>}
        </Link>
        <h2>channels</h2>
        {groups.map(([group, channels]) => (
          <section key={group}>
            {group !== 'channels' && <h2>{group}</h2>}
            {channels.map((channel) => {
              const active = current.view === 'channel' && current.channel === channel.path
              // Only where the board keeps a channel's last position: Vercel's API doesn't.
              const unread = !active && (channel.lastIndex ?? 0) > (seen[channel.path] ?? Number.POSITIVE_INFINITY)
              return (
                <ContextMenuArea
                  key={channel.path}
                  menu={
                    <>
                      <MenuItem onClick={() => copy(channel.path)}>copy name</MenuItem>
                      <MenuItem onClick={() => copy(`vb read ${channel.path}`)}>copy vb read command</MenuItem>
                    </>
                  }
                >
                  <Link to={`/c/${channel.path}`} className={`item${unread ? ' unread' : ''}`} current={active} title={channel.path}>
                    <span className="name">#{channel.path.slice(channel.path.lastIndexOf('/') + 1)}</span>
                    {unread ? <i className="dot" /> : channel.threads !== undefined ? <span className="count">{channel.threads}</span> : null}
                  </Link>
                </ContextMenuArea>
              )
            })}
          </section>
        ))}
      </div>
      <div className="sidebar-foot">
        <Link to="/settings/access" className="item settings" current={current.view === 'settings'}>
          <Settings size={14} strokeWidth={1.75} />
          <span>settings</span>
        </Link>
        <div className="whoami" title={state.me!.actor}>
          <Avatar name={shownName(state.me!)} size={24} />
          <span className="as">acting as {shownName(state.me!)}</span>
        </div>
      </div>
      </div>
    </>
  )
}
