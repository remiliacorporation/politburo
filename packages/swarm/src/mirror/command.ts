import { parseArgs } from 'node:util'
import { board, type Board } from '@vercel/board'
import { readRepo } from './github.ts'
import { checkOverlap, OverlapError } from './overlap.ts'
import { githubPullSend, type GithubSend } from './pulls.ts'
import { mirrorPullRequests, type PullReport, type UnreadPull } from './prs.ts'
import { mirrorStore, registerMirrorSchema } from './store.ts'
import { syncMirror } from './sync.ts'
import { mirrorReasons, validRepo, type MirrorClock, type MirrorRead, type MirrorReader } from './types.ts'
import { workItemsFromFile, WorkItemsFileError, type WorkItems } from './work-items.ts'

type Handle = Pick<Board, 'me' | 'createSchema' | 'post' | 'posted' | 'edit' | 'threads' | 'tasks' | 'label'>
type Output = { write(text: string): unknown } | ((text: string) => unknown)
export type MirrorCommandDeps = {
  board?: Handle | (() => Handle | Promise<Handle>)
  stdout?: Output
  stderr?: Output
  reader?: MirrorReader
  github?: GithubSend
  now?: MirrorClock
  workItems?: WorkItems
}

const write = (to: Output, text: string) => typeof to === 'function' ? to(text) : to.write(text)
const escapeControls = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
// Escape in the serialized document so JSON readers still recover the original values.
const jsonDocument = (value: unknown) => `${escapeControls(JSON.stringify(value))}\n`
const jsonOption = { type: 'boolean' } as const

const validBoard = (value: string) => {
  if (value.length > 2000) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0 && !url.username && !url.password
  } catch { return false }
}

function pullText(report: PullReport): string {
  if (report.tasks.length === 0) return report.unread.length > 0 ? '' : 'no open tasks with a pr\n'
  const width = Math.max(...report.tasks.map((row) => row.id.length + 1))
  return report.tasks.map((row) =>
    `${('#' + row.id).padEnd(width)}  ${row.state.padEnd(6)}  ${row.checks.padEnd(7)}  ${row.head}`).join('\n') + '\n'
}

function pullJson(report: PullReport): string {
  return jsonDocument({
    tasks: report.tasks.map(({ id, pr, state, checks, head, changed }) => ({ id, pr, state, checks, head, changed })),
    ...(report.unread.length > 0 ? { unread: report.unread } : {}),
  })
}

function unreadLine(row: UnreadPull): string {
  return row.reason === 'not_a_number'
    ? `pr.number on #${row.id} is not a pull request number`
    : `could not read pull request ${row.pr}`
}

function boardAt(url: string): Board {
  const previous = process.env.BOARD_URL
  process.env.BOARD_URL = url
  try { return board() }
  finally {
    if (previous === undefined) delete process.env.BOARD_URL
    else process.env.BOARD_URL = previous
  }
}

function parse(args: string[]) {
  if (args[0] === 'mirror' && args[1] === 'sync') {
    const { values } = parseArgs({ args: args.slice(2), options: { repo: { type: 'string' }, json: jsonOption } })
    if (values.repo && validRepo(values.repo)) return { mode: 'sync' as const, repo: values.repo, json: values.json }
  }
  if (args[0] === 'mirror' && args[1] === 'prs') {
    const { values } = parseArgs({ args: args.slice(2), options: {
      board: { type: 'string' }, repo: { type: 'string' }, json: jsonOption,
    } })
    if (values.board && validBoard(values.board) && values.repo && validRepo(values.repo)) {
      return { mode: 'prs' as const, board: values.board, repo: values.repo, json: values.json === true }
    }
  }
  if (args[0] === 'overlap' && args[1] && !args[1].startsWith('-')) {
    const { values } = parseArgs({ args: args.slice(2), options: {
      work: { type: 'string' }, 'max-age-minutes': { type: 'string' }, json: jsonOption,
    } })
    const minutes = values['max-age-minutes'] ?? '15'
    const maxAgeMs = Number(minutes) * 60_000
    if (values.work && /^\d+(?:\.\d+)?$/u.test(minutes) && Number.isFinite(maxAgeMs)) {
      return { mode: 'overlap' as const, workId: args[1], path: values.work, maxAgeMs, json: values.json }
    }
  }
}

export async function runMirrorCommand(args: string[], deps: MirrorCommandDeps = {}): Promise<number> {
  const { stdout = process.stdout, stderr = process.stderr, now = Date.now, reader = readRepo } = deps
  const fail = (headline: string, code = 1) => { write(stderr, `error: ${headline}\n`); return code }
  let command
  try { command = parse(args) } catch { /* Do not echo parser errors or argv. */ }
  if (!command) return fail(args[0] === 'overlap'
    ? 'expected overlap <work-id> --work FILE [--max-age-minutes N] [--json]'
    : args[1] === 'prs'
      ? 'expected mirror prs --board URL --repo owner/name [--json]'
      : 'expected mirror sync --repo owner/name [--json]', 2)

  async function openStore(mode: 'sync' | 'overlap') {
    const handle = await (typeof deps.board === 'function' ? deps.board() : deps.board ?? board())
    if (mode === 'sync') await registerMirrorSchema(handle)
    return mirrorStore({ board: handle, author: (await handle.me()).actor, now })
  }

  if (command.mode === 'prs') {
    try {
      const handle = await (typeof deps.board === 'function' ? deps.board() : deps.board ?? boardAt(command.board))
      const report = await mirrorPullRequests({ repo: command.repo, board: handle, send: deps.github ?? githubPullSend() })
      write(stdout, command.json ? pullJson(report) : pullText(report))
      for (const row of report.unread) write(stderr, `error: ${escapeControls(unreadLine(row))}\n`)
      return report.unread.length > 0 ? 1 : 0
    } catch { return fail('could not mirror pull requests') }
  }

  try {
    if (command.mode === 'sync') {
      let reads: readonly MirrorRead[] = []
      const summary = await syncMirror({ repo: command.repo, now, store: await openStore('sync'),
        reader: async (scope) => { reads = await reader(scope); return reads },
      })
      const kinds = summary.map((row) => {
        if (row.stale) return { ...row, complete: false }
        if (row.complete) return row
        const read = reads.find(({ kind }) => kind === row.kind)
        const reason = mirrorReasons.find((entry) => entry === read?.reason) ?? (read ? 'unexpected_response' : 'gh_failed')
        return { ...row, reason }
      })
      write(stdout, command.json ? jsonDocument({ kinds }) : kinds.map((row) => {
        const state = row.stale ? 'stale' : 'reason' in row ? `partial (${row.reason})` : 'complete'
        return `${row.kind.padEnd(6)}  ${state}  seen ${row.seen}  created ${row.created}  changed ${row.changed}\n`
      }).join(''))
      return kinds.every(({ complete }) => complete) ? 0 : 1
    }

    // Resolve the work item before opening the board; unknown work is not a board failure.
    let store: ReturnType<typeof openStore> | undefined
    const getStore = () => store ??= openStore('overlap')
    const result = await checkOverlap({ workId: command.workId, maxAgeMs: command.maxAgeMs, now,
      workItems: deps.workItems ?? workItemsFromFile(command.path), store: {
        list: async (scope) => (await getStore()).list(scope),
        status: { read: async (scope) => (await getStore()).status.read(scope) },
      },
    })
    if (command.json) write(stdout, jsonDocument(result))
    else write(stdout, [
      `${result.workId}  ${result.status}`,
      ...result.conflicts.map(({ kind, key, origin, title }) =>
        `  ${kind.padEnd(6)}  ${kind === 'branch' ? `${key}  on origin` : `#${key}  ${origin}`}` +
        (kind === 'pr' && title ? `  ${title}` : '')),
      ...result.gaps.map((gap) => `  ${gap}`),
    ].map(escapeControls).join('\n') + '\n')
    return result.status === 'clear' ? 0 : 1
  } catch (error) {
    if (command.mode === 'sync') return fail('mirror sync failed')
    if (error instanceof OverlapError) return fail('unknown work item')
    if (error instanceof WorkItemsFileError) return fail(error.unreadable ? 'cannot read work file' : 'invalid work file')
    return fail('overlap check failed')
  }
}
