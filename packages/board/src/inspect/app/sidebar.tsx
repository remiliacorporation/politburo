import { ChevronDown, ChevronRight, CircleHelp, ClipboardList, House, ListTodo, LayoutGrid, PanelLeftClose, Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ChannelView } from '../../api/routes.ts'
import { attentionTasks, hasUnshownRefusal } from './attention-store.ts'
import * as board from './board.ts'
import { toast } from './chrome.ts'
import { HomeEmblem } from './home-emblem.tsx'
import { Avatar } from './message.tsx'
import { Link, useLocation, useNow, type Route } from './nav.tsx'
import { openTasks, type State } from './store.ts'
import { ContextMenuArea, MenuItem } from './ui.tsx'
import { boardWords, shownName } from './words.ts'
import { listedRepos, REPO_LIST_CHANNEL, repoLabel, repoOfChannel, reposOf } from './repos.ts'
import { repoPartyOf, workScopeUrl } from './work-scope.ts'
import { labelsOf, projectWork } from './work.ts'

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

/** Folded repo tags for this board. A missing or unreadable record means every repo is open. */
function readFolded(storage: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storage) ?? 'null')
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function useFoldedRepos(state: State): { has: (tag: string) => boolean; toggle: (tag: string) => void } {
  const storage = `board.repos.folded:${state.discovery?.url ?? location.host}`
  const [folded, setFolded] = useState<string[]>(() => readFolded(storage))
  useEffect(() => { setFolded(readFolded(storage)) }, [storage])
  const toggle = (tag: string) => {
    setFolded((current) => {
      const next = current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]
      try { localStorage.setItem(storage, JSON.stringify(next)) } catch {}
      return next
    })
  }
  return { has: (tag) => folded.includes(tag), toggle }
}

export function Sidebar({ state, current, onHome, onCollapse }: { state: State; current: Route; onHome: () => void; onCollapse: () => void }) {
  const seen = useSeen(state, current)
  const folded = useFoldedRepos(state)
  const listed = useMemo(() => listedRepos(state.messages), [state.messages])
  const repos = useMemo(() => reposOf(state.channels, listed), [state.channels, listed])
  const hasRepoList = Object.hasOwn(state.channels, REPO_LIST_CHANNEL)
  useEffect(() => { if (hasRepoList) void board.loadChannel(REPO_LIST_CHANNEL) }, [hasRepoList])
  const { byRepo, other } = useMemo(() => {
    const byRepo = new Map<string, ChannelView[]>()
    const other = new Map<string, ChannelView[]>()
    for (const channel of Object.values(state.channels).sort((a, b) => a.path.localeCompare(b.path))) {
      const tag = repoOfChannel(channel.path)
      if (tag !== null) {
        byRepo.set(tag, [...(byRepo.get(tag) ?? []), channel])
        continue
      }
      const at = channel.path.lastIndexOf('/')
      const group = at === -1 ? 'channels' : channel.path.slice(0, at)
      other.set(group, [...(other.get(group) ?? []), channel])
    }
    return { byRepo, other: [...other] }
  }, [state.channels])
  const open = openTasks(state)
  const attention = useMemo(() => attentionTasks(state).length, [state.messages])
  const where = boardWords(state.discovery)
  const { params } = useLocation()
  const records = board.swarmRecords()
  const viewer = useMemo(() => state.openTaskMe && board.viewerOf(state.openTaskMe), [state.openTaskMe])
  const now = useNow(state.openTaskRoots)
  // Counts per repo, from the same rules as the work board. A tag the board does not list is not a row.
  const counts = useMemo(() => {
    const out = new Map<string | null, { needs: number; running: number; pull: number }>()
    for (const row of projectWork(state, records, viewer, now).rows) {
      const entry = out.get(row.repo) ?? { needs: 0, running: 0, pull: 0 }
      if (row.group === 'needs') entry.needs++
      else if (row.group === 'running') entry.running++
      else if (row.group === 'pull') entry.pull++
      out.set(row.repo, entry)
    }
    return out
  }, [state.openTaskRoots, state.attention, state.messages, state.channels, viewer, records, now])
  const shown = new Set<string | null>(repos.map(({ tag }) => tag))
  shown.add(null)
  const needsAll = [...counts].reduce((sum, [tag, { needs }]) => sum + (shown.has(tag) ? needs : 0), 0)
  const repoParty = repoPartyOf(records, current.view === 'party' ? current.party : params.get('party'))
  const repoView = labelsOf(records, repoParty, where.name).repoView
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(`copied ${text}`))
  const channelItem = (channel: ChannelView, shown: string, nested = false) => {
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
        <Link to={`/c/${channel.path}`} className={`item${nested ? ' nested' : ''}${unread ? ' unread' : ''}`} current={active} title={channel.path}>
          <span className="name">#{shown}</span>
          {unread ? <i className="dot" /> : channel.threads !== undefined ? <span className="count">{channel.threads}</span> : null}
        </Link>
      </ContextMenuArea>
    )
  }
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
          {needsAll > 0 && <span className="count" title="need you, every repo">{needsAll}</span>}
        </Link>
        <Link to="/work" className="item" current={current.view === 'work'} title="the queue, every repo">
          <LayoutGrid size={14} aria-hidden="true" />
          <span className="name">Work</span>
        </Link>
        {repos.length > 0 && <h2>repos</h2>}
        {repos.map((repo) => {
          const count = counts.get(repo.tag) ?? { needs: 0, running: 0, pull: 0 }
          const channels = byRepo.get(repo.tag) ?? []
          const shut = folded.has(repo.tag)
          const name = repoLabel(repo)
          return (
            <section key={repo.tag} aria-label={`repo ${repo.tag}`}>
              <div className="repo-line">
                {channels.length > 0 && (
                  <button type="button" className="tool fold" aria-expanded={!shut} aria-label={`${shut ? 'Show' : 'Hide'} ${name} channels`}
                    onClick={() => folded.toggle(repo.tag)}>
                    {shut ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  </button>
                )}
                <Link to={`/r/${repo.tag}`} className="item repo" current={current.view === 'repo' && current.repo === repo.tag}
                  title={`${repo.repo ?? repo.tag}: ${count.needs} need you · ${count.running} running · ${count.pull} ready to pull`}>
                  <span className="name">{name}</span>
                  {repo.name && <small className="faint">{repo.tag}</small>}
                  <span className="count">{count.needs} · {count.running} · {count.pull}</span>
                </Link>
              </div>
              {!shut && channels.map((channel) => channelItem(channel, channel.path.slice(repo.tag.length + 1), true))}
            </section>
          )
        })}
        <h2>parties</h2>
        <Link to="/mobs" className="item" current={current.view === 'mobs'}>
          <span>mobs</span>
        </Link>
        <Link to={workScopeUrl('/presidium', params, repoParty)} className="item" current={current.view === 'presidium'} title={repoView.subtitle}>
          <LayoutGrid size={14} aria-hidden="true" />
          <span>{repoView.label}</span>
        </Link>
        {Object.entries(records?.parties ?? {}).map(([id, party]) => {
          const { label, subtitle } = labelsOf(records, id).partyBoard
          return <Link key={id} to={workScopeUrl(`/party/${encodeURIComponent(id)}`, params)} className="item"
            current={current.view === 'party' && current.party === id} title={subtitle}>
            <span>{label}</span><small className="faint name">{party.name}</small>
          </Link>
        })}
        <h2>views</h2>
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
        {other.length > 0 && <h2>channels</h2>}
        {other.map(([group, channels]) => (
          <section key={group}>
            {group !== 'channels' && <h2>{group}</h2>}
            {channels.map((channel) => channelItem(channel, channel.path.slice(channel.path.lastIndexOf('/') + 1)))}
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
