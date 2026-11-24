import type { ChannelView, MessageView } from '../../api/routes.ts'

// One board holds every repo's work. A repo is a channel prefix, its tag:
// `rdn/work/…` is RemiDarkNET's. `config/repos` names them. Pure, like the store.

/** Where the board's repo list is kept: one JSON message, the newest wins. */
export const REPO_LIST_CHANNEL = 'config/repos'

/** First segments that are never a repo. */
const RESERVED = new Set(['party', 'config'])

const TAG = /^[a-z][a-z0-9]{1,15}$/
const WORK_ID = /^([a-z][a-z0-9]*)-\d+$/

export type Repo = { tag: string; name: string | null; repo: string | null }

/** A channel's repo tag: its first segment, when it has more than one and that segment can be a tag. */
export function repoOfChannel(path: string): string | null {
  const at = path.indexOf('/')
  if (at === -1) return null
  const first = path.slice(0, at)
  return TAG.test(first) && !RESERVED.has(first) ? first : null
}

/** A task's repo: the tag of its work id (`rdn-81`), else its channel's. */
export function repoOfTask(root: Pick<MessageView, 'channel' | 'labels'>): string | null {
  const id = root.labels['work.id']?.toLowerCase()
  const match = id ? WORK_ID.exec(id) : null
  if (match && !RESERVED.has(match[1]!)) return match[1]!
  return repoOfChannel(root.channel)
}

/** The repo list a `config/repos` message holds, or null when it isn't one. */
export function parseRepoList(text: string): Repo[] | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const list = Array.isArray(value) ? value : (value as { repos?: unknown } | null)?.repos
  if (!Array.isArray(list)) return null
  const out: Repo[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const { tag, name, repo } = entry as Record<string, unknown>
    if (typeof tag !== 'string') continue
    const lower = tag.toLowerCase()
    if (!TAG.test(lower) || RESERVED.has(lower) || seen.has(lower)) continue
    seen.add(lower)
    out.push({ tag: lower, name: typeof name === 'string' && name.trim() ? name.trim() : null, repo: typeof repo === 'string' && repo.trim() ? repo.trim() : null })
  }
  return out
}

/** The newest readable repo list among the messages the page holds. */
export function listedRepos(messages: Record<string, MessageView>): Repo[] | null {
  let newest: MessageView | null = null
  for (const message of Object.values(messages)) {
    if (message.channel !== REPO_LIST_CHANNEL || message.deleted || message.re !== null) continue
    if (parseRepoList(message.text) === null) continue
    if (!newest || message.createdAt > newest.createdAt || (message.createdAt === newest.createdAt && message.id > newest.id)) newest = message
  }
  return newest ? parseRepoList(newest.text) : null
}

/** Every repo the board shows: the listed ones in their order, then any other channel prefix, by tag. */
export function reposOf(channels: Record<string, ChannelView>, listed: Repo[] | null): Repo[] {
  const repos = [...(listed ?? [])]
  const known = new Set(repos.map(({ tag }) => tag))
  const found = new Set<string>()
  for (const { path } of Object.values(channels)) {
    const tag = repoOfChannel(path)
    if (tag && !known.has(tag)) found.add(tag)
  }
  for (const tag of [...found].sort()) repos.push({ tag, name: null, repo: null })
  return repos
}

/** How a repo reads on the page: its name with its tag, or the tag alone. */
export const repoLabel = (repo: Repo) => repo.name ?? repo.tag
