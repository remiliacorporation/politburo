import type { Board } from '@vercel/board'
import { openTagRegistry } from '../tags.ts'
import { parseWorkId } from '../work/ids.ts'
import { readPulls, type GithubSend, type PullFact } from './pulls.ts'

const LABEL_KEYS = ['pr.state', 'pr.checks', 'pr.head'] as const
const PR_NUMBER = /^[1-9][0-9]*$/

export type PullTask = {
  id: string
  pr: string
  state: PullFact['state']
  checks: PullFact['checks']
  head: string
  changed: string[]
}
export type UnreadPull = { id: string; pr: string; reason: 'not_a_number' | 'unreadable' }
export type PullReport = { tasks: PullTask[]; unread: UnreadPull[] }

type TaskBoard = Pick<Board, 'tasks' | 'label'>

function changedLabels(labels: Record<string, string>, fact: PullFact): Record<string, string> {
  const next = { 'pr.state': fact.state, 'pr.checks': fact.checks, 'pr.head': fact.head }
  const set: Record<string, string> = {}
  for (const key of LABEL_KEYS) if (labels[key] !== next[key]) set[key] = next[key]
  return set
}

type OpenTask = { id: string; channel: string; labels: Record<string, string> }

function reposByTag(): Map<string, string> {
  const opened = openTagRegistry()
  const repos = new Map<string, string>()
  if (opened.status !== 'ok') return repos
  for (const entry of opened.tags) {
    if (typeof entry.repo === 'string' && entry.repo.length > 0) repos.set(entry.tag, entry.repo.toLowerCase())
  }
  return repos
}

function channelTag(channel: string): string | undefined {
  const prefix = channel.split('/')[0]?.toLowerCase() ?? ''
  return /^[a-z]{3}$/.test(prefix) ? prefix : undefined
}

/** `pr.repo` when set, otherwise the work id's tag or the channel prefix when the registry maps it. */
function taskRepo(task: OpenTask, repos: ReadonlyMap<string, string>): string | null {
  const labeled = task.labels['pr.repo']?.trim()
  if (labeled) return labeled.toLowerCase()
  const fromId = parseWorkId(task.labels['work.id'] ?? '')?.tag
  const tag = fromId && repos.has(fromId) ? fromId : channelTag(task.channel)
  return tag !== undefined && repos.has(tag) ? repos.get(tag)! : null
}

async function openTasks(board: TaskBoard): Promise<OpenTask[]> {
  const found: OpenTask[] = []
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = await board.tasks.list({ state: 'open', label: ['pr.number'], limit: 500, ...(after ? { after } : {}) })
    for (const { message } of page.tasks) {
      if (seen.has(message.id)) return found
      seen.add(message.id)
      found.push({ id: message.id, channel: message.channel, labels: message.labels })
    }
    if (page.tasks.length < 500 || page.cursor === after) return found
    after = page.cursor
  }
}

/**
 * For each open task labeled `pr.number` whose repo is `repo`, set `pr.state`, `pr.checks`, and
 * `pr.head` from GitHub. A task names its repo with `pr.repo`, or else with a `work.id` tag or
 * channel prefix the registry maps. A task that names another repo is left as it is. A label
 * already holding that value is left as it is, so a second run writes nothing.
 */
export async function mirrorPullRequests({ repo, board, send }: {
  repo: string
  board: TaskBoard
  send: GithubSend
}): Promise<PullReport> {
  const repos = reposByTag()
  const wantedRepo = repo.toLowerCase()
  const tasks = (await openTasks(board)).filter((task) => {
    const owner = taskRepo(task, repos)
    return owner === null || owner === wantedRepo
  })
  const unread: UnreadPull[] = []
  const wanted: { id: string; labels: Record<string, string>; number: number }[] = []
  for (const task of tasks) {
    const pr = task.labels['pr.number'] ?? ''
    const number = Number(pr)
    if (!PR_NUMBER.test(pr) || !Number.isSafeInteger(number)) unread.push({ id: task.id, pr, reason: 'not_a_number' })
    else wanted.push({ ...task, number })
  }
  const facts = await readPulls(repo, [...new Set(wanted.map((task) => task.number))], send)
  const rows: PullTask[] = []
  for (const task of wanted) {
    const fact = facts.get(task.number)
    if (!fact) {
      unread.push({ id: task.id, pr: String(task.number), reason: 'unreadable' })
      continue
    }
    const set = changedLabels(task.labels, fact)
    const changed = LABEL_KEYS.filter((key) => Object.hasOwn(set, key))
    if (changed.length > 0) await board.label(task.id, { set })
    rows.push({ id: task.id, pr: String(task.number), state: fact.state, checks: fact.checks, head: fact.head, changed: [...changed] })
  }
  rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  unread.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  return { tasks: rows, unread }
}
