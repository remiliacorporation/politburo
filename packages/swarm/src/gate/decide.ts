import { parseWorkId } from '../work/ids.ts'

/** One plb task, as the board lists it. */
export type GateTask = {
  state: string
  labels: Record<string, string>
  result: string | null
}

export type CheckRun = { status: string; conclusion: string | null; headSha: string }

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/

export function namesPullRequest(value: string | null | undefined, pr: number): boolean {
  if (value == null) return false
  const text = value.trim()
  const n = String(pr)
  if (text === n) return true
  if (new RegExp(`(?:^|[^A-Za-z0-9_])#${n}(?![0-9])`).test(text)) return true
  return new RegExp(`(?:^|[^A-Za-z0-9_])pulls?/${n}(?![0-9])`, 'i').test(text)
}

function validRepo(value: string | undefined): string | null {
  const text = value?.trim() ?? ''
  if (!REPO.test(text) || text.split('/').some((part) => part === '.' || part === '..')) return null
  return text
}

function repoFromResult(value: string | null | undefined, pr: number): string | null {
  if (!value) return null
  const match = new RegExp(`github\\.com/(?:repos/)?([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/pulls?/${pr}(?![0-9])`, 'i').exec(value)
  if (!match) return null
  return validRepo(`${match[1]}/${match[2]}`)
}

function namesTask(task: GateTask, pr: number): boolean {
  return namesPullRequest(task.labels['pr.number'], pr)
    || namesPullRequest(task.labels.result, pr)
    || namesPullRequest(task.result, pr)
}

function repoOf(task: GateTask, pr: number): string | null {
  const labeled = validRepo(task.labels['work.repo'])
  const linked = repoFromResult(task.result, pr) ?? repoFromResult(task.labels.result, pr)
  if (labeled && linked && labeled.toLowerCase() !== linked.toLowerCase()) return null
  return labeled ?? linked
}

/** Board-side reasons, in the order a merge is refused. `repo` means GitHub still has to agree. */
export function selectTask(tasks: readonly GateTask[], pr: number):
  | { ok: false; reason: string }
  | { ok: true; task: GateTask; repo: string } {
  const matches = tasks.filter((task) => parseWorkId(task.labels['work.id'] ?? '')?.tag === 'plb' && namesTask(task, pr))
  if (matches.length === 0) return { ok: false, reason: 'task missing' }
  if (matches.length > 1) return { ok: false, reason: 'more than one task' }
  const task = matches[0]!
  if (task.state !== 'completed') return { ok: false, reason: 'not completed' }
  if (Object.hasOwn(task.labels, 'parked')) return { ok: false, reason: 'parked' }
  if (Object.hasOwn(task.labels, 'needs-review')) return { ok: false, reason: 'needs-review' }
  const repo = repoOf(task, pr)
  if (!repo) return { ok: false, reason: 'no repo' }
  return { ok: true, task, repo }
}

/** The verdict reason when this head has no `review.verdict=pass`. */
export function verdictReason(task: GateTask, head: string): string | null {
  if (task.labels['review.verdict'] === 'pass' && task.labels['review.head'] === head) return null
  return `no review.verdict=pass for ${head}`
}

/** Every listed check is success on this head. */
export function checksReason(head: string, checks: readonly CheckRun[], complete: boolean): string {
  const allSuccess = complete && checks.length > 0 && checks.every((check) =>
    check.status === 'completed' && check.conclusion === 'success' && check.headSha === head)
  return allSuccess ? 'pass' : 'checks not all success'
}
