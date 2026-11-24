import type { MessageView } from '../api/routes.ts'
import { BoardError, type ClaimedTask, type TaskInBatch } from '../client/client.ts'
import { createTasksInChunks, TasksInChunksError } from '../client/chunks.ts'
import { environmentProfile } from '../client/node.ts'
import { AttentionAnswerBody, AttentionAskFile } from '../contract/attention.ts'
import { TaskPriority } from '../contract/schemas.ts'
import { TaskBinding, TaskPacket } from '../contract/task-authority.ts'
import type { Board } from '../server/index.ts'
import { fileClaims, memoryClaims, tokenClaims, type ClaimProof, type Claims } from './claims.ts'
import { closest, commandLine, type Failure, type Recovery } from './failure.ts'
import { claimLine, formatAttention, formatTasks } from './format.ts'
import { cli, client, connection, current, doing, Failed, failureOf, flags, io, isMessageRef, labelPairs, messageId, messageRef, onSameBoard, onThisBoard, out, profileFlag, ref, rerun, rerunWithout, result, seconds, setSentLength, stateCommand, stopOn, taskId, typed, usage } from './main.ts'

/** The handle a task command used, for a read that explains its failure. */
let taskBoard: Board | undefined

export function resetTaskBoard() {
  taskBoard = undefined
}

/** What `tasks` does to a task, by the word after it: any other word is a channel to list. */
export const TASK_VERBS = new Set(['create', 'claim', 'run', 'renew', 'release', 'complete', 'fail', 'block', 'ask', 'attention', 'answer', 'unblock', 'park', 'unpark', 'handoff', 'scope', 'stage', 'reopen', 'assign', 'needs', 'priority', 'show', 'cancel'])

export function priorityOf(value: unknown, from: string): TaskPriority {
  const parsed = TaskPriority.safeParse(value)
  if (parsed.success) return parsed.data
  throw usage(`${from} takes ${TaskPriority.options.join(', ')}.`, { reason: 'invalid_priority' })
}

/**
 * `tasks create <channel> --file <path>`: the tasks a JSON file holds, as `tasks.createMany`
 * takes them, made in as many writes as the board needs. It prints each as the list shows one.
 * The whole plan goes under one key, `--idempotency-key`'s or this run's own, so one that stops
 * midway says what was made and is finished by the same command.
 */
export async function createPlan(target: string, text: string | undefined, path: string): Promise<number> {
  if (isMessageRef(target)) throw usage(`--file holds a plan, which starts threads in a channel, and ${ref(target)} is a thread.`)
  if (text !== undefined) throw usage("Text is one task's: with --file, each task in the file has its own.")
  // What the file holds comes first: one task's text in it means these options are that task's, on stdin.
  const parsed = await planSource(path)
  const own = (['label', 'needs', 'for', 'claim', 'lease', 'binding', 'no-sync', 'priority'] as const).find((name) => flags[name] !== undefined && flags[name] !== false)
  if (own !== undefined) throw usage(`--${own} is one task's: with --file, each task in the file has its own.`)
  const board = client()
  const tasks = await planFrom(parsed, path, board)
  // Each root is a message: the longest says what a backend's refusal of one's text means, as for a task made alone.
  setSentLength(Math.max(0, ...tasks.map((task) => (typeof task.text === 'string' ? task.text.length : 0))))
  const key = flags['idempotency-key'] ?? crypto.randomUUID()
  let made: MessageView[]
  try {
    made = await createTasksInChunks(board, target, tasks, { id: key })
  } catch (error) {
    if (!(error instanceof TasksInChunksError)) throw error
    const there = error.created.filter((task) => task !== undefined)
    const failed = failureOf(error)
    // The key made another plan: other tasks, or these and no more. What it found of this one was there before, and
    // the same command again would end the same way.
    if (error.code === 'duplicate_id')
      throw new Failed({
        ...failed,
        message: `${failed.message} That key made another plan.`,
        next: [{ instruction: 'Leave what the key made as it was, or make new tasks under another key' }],
      })
    // Nothing made is the failure alone. Some made: which, and the command that makes the rest, under the same key.
    if (there.length === 0) throw new Failed(failed)
    throw new Failed({
      ...failed,
      details: [...(failed.details ?? []), `made ${there.length} of ${tasks.length}: ${ref(there[0]!.id)} to ${ref(there.at(-1)!.id)}`],
      next: [{ instruction: 'Make the rest, under the same key: what was made stays as it is', argv: rerunWithout(['--idempotency-key'], '--idempotency-key', key) }],
      data: { ...failed.data, created: there.map((task) => task.id), total: tasks.length },
    })
  }
  if (flags.json) result({ tasks: made })
  else out(formatTasks(made.map((message) => ({ message, replies: 0, last: null }))))
  return 0
}

/** What a task of a plan's `--file` takes, as `tasks.createMany` does. */
const PLAN_KEYS = ['key', 'text', 'labels', 'needs', 'for', 'noSync', 'attachments', 'priority']

/** The help page that says what a plan holds. */
const planHelp = (): Recovery => ({ instruction: 'See what a plan takes', argv: [...cli(), 'tasks', 'create', '--help'] })

/** One of a plan task's `needs`: a task that's there, by its ID as text, as a number, or as `{ "id": … }`, or `{ "key": … }` for one of the plan's own. */
function isNeed(need: unknown): boolean {
  if (typeof need === 'string') return need.replace(/^#/, '').length > 0
  if (typeof need === 'number') return Number.isSafeInteger(need) && need >= 0
  if (typeof need !== 'object' || need === null) return false
  const keys = Object.keys(need)
  if (keys.length !== 1) return false
  const value = (need as Record<string, unknown>)[keys[0]!]
  if (keys[0] === 'id') return typeof value === 'string' && isNeed(value)
  return keys[0] === 'key' && typeof value === 'string'
}

/** A need as the board takes it: an ID as it is, or `{ "key": … }`, which a bare string is when it's a key of the plan's own. */
function boardNeed(need: unknown, keys: ReadonlySet<string>): unknown {
  if (typeof need === 'string' && keys.has(need)) return { key: need }
  return idNeed(need)
}

function idNeed(need: unknown): unknown {
  if (typeof need === 'string') return need.replace(/^#/, '')
  if (typeof need === 'number') return String(need)
  if (typeof need === 'object' && need !== null && 'id' in need) return idNeed(need.id)
  return need
}

/**
 * Refuses a plan that says something a task doesn't take, before anything is sent. The board
 * drops a key it doesn't know, so a `need` for `needs` would make a task that waits for nothing,
 * without a word: here the file can say which task, and the key that was meant.
 */
function checkPlan(plan: Record<string, unknown>[], where: string): void {
  for (const [at, task] of plan.entries()) {
    const unknown = Object.keys(task).find((name) => !PLAN_KEYS.includes(name))
    if (unknown !== undefined) {
      const meant = PLAN_KEYS.find((known) => known.toLowerCase() === unknown.toLowerCase()) ?? closest(unknown, PLAN_KEYS)
      throw new Failed({
        class: 'usage',
        reason: 'invalid_arguments',
        message: `Unknown key ${JSON.stringify(unknown)} on task ${at + 1} of ${where}.${meant ? ` Did you mean ${JSON.stringify(meant)}?` : ''}`,
        ...(meant ? {} : { details: [`a task takes ${PLAN_KEYS.join(', ')}`] }),
        next: [planHelp()],
      })
    }
    if ('priority' in task) priorityOf(task.priority, `Priority on task ${at + 1} of ${where}`)
    if (!('needs' in task)) continue
    const needs = '[{"key": "fix"}, "812"]'
    if (!Array.isArray(task.needs)) throw usage(`Task ${at + 1} of ${where} has needs that aren't a list, such as ${needs}.`, { next: [planHelp()] })
    const odd = task.needs.find((need) => !isNeed(need))
    if (odd !== undefined) {
      const said = JSON.stringify(odd)
      throw usage(`Task ${at + 1} of ${where} needs ${said.length > 60 ? `${said.slice(0, 59)}…` : said}. A need is a key of the plan's own, like "fix" or {"key": "fix"}, or a task's ID as vb prints it or as {"id": "…"}.`, { next: [planHelp()] })
    }
  }
}

/**
 * What a plan's `--file` holds, as JSON: the file, or stdin for `-`. Prose is the likeliest slip,
 * --file carried over from post, where it's the text: it says the same command with the file on
 * stdin, `-` as the text, and the options it was given.
 */
async function planSource(path: string): Promise<unknown> {
  const where = path === '-' ? 'stdin' : path
  let source: string
  if (path === '-') source = await io.stdin()
  else {
    const data = await io.readFile(path)
    if (!data) throw usage(`Can't read ${path}. There's no such file.`, { reason: 'file_not_found', next: [] })
    source = new TextDecoder().decode(data)
  }
  try {
    return JSON.parse(source)
  } catch {
    const piped = `${commandLine(rerunWithout(['--file'], '-'))}${path === '-' ? '' : ` < ${commandLine([path])}`}`
    throw usage(`${where} isn't JSON: --file on tasks create is a plan of tasks.`, { next: [{ instruction: `One task's text goes on stdin, as -: ${piped}` }, planHelp()] })
  }
}

/** The tasks a plan's `--file` holds: a JSON array. An ID may be written `#812`, and `for` as a profile's name. */
async function planFrom(parsed: unknown, path: string, board: Board): Promise<TaskInBatch[]> {
  const where = path === '-' ? 'stdin' : path
  const shape = 'A plan is a JSON array of tasks: [{"key": "fix", "text": "…"}, {"text": "…", "needs": [{"key": "fix"}]}].'
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((task) => typeof task !== 'object' || task === null || Array.isArray(task))) throw usage(`${where} holds no tasks. ${shape}`, { next: [planHelp()] })
  const plan = parsed as (Record<string, unknown> & { needs?: unknown; for?: unknown })[]
  checkPlan(plan, where)
  // A profile's name is the caller's own profile, as --for takes one: an actor's ID goes as it is.
  const named = plan.some((task) => typeof task.for === 'string' && !task.for.includes(':'))
  const principal = named ? (await board.me()).principal : ''
  const keys = new Set(plan.flatMap((task) => (typeof task.key === 'string' ? [task.key] : [])))
  return plan.map((task) => ({
    ...task,
    ...(Array.isArray(task.needs) ? { needs: task.needs.map((need) => boardNeed(need, keys)) } : {}),
    ...(typeof task.for === 'string' && !task.for.includes(':') ? { for: profileActor(principal, task.for) } : {}),
  })) as TaskInBatch[]
}

/** A draft or replacement, never a claim. Don't repeat any part of an invalid JSON body. */
export async function attentionFrom(path: string) {
  const where = path === '-' ? 'stdin' : path
  const text = await (path === '-' ? io.stdin() : io.readFile(path)).catch(() => null)
  if (text === null) throw usage(`Can't read ${where}.`, { reason: 'file_not_found' })
  const next = [{ instruction: 'See what the draft takes', argv: [...cli(), 'tasks', 'ask', '--help'] }]
  let draft: unknown
  try {
    draft = JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text))
  } catch {
    throw usage(`${where} isn't JSON.`, { next })
  }
  const checked = AttentionAskFile.safeParse(draft)
  if (!checked.success) throw usage(`${where} must hold an attention draft, with optional replaces and no claim.`, { next })
  return checked.data
}

/** Assignment metadata is JSON, never a filename. Report a bad flag without echoing its input. */
export function bindingFlag() {
  if (flags.binding === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(flags.binding)
  } catch {
    throw usage('--binding takes a JSON object.', { reason: 'invalid_binding' })
  }
  const binding = TaskBinding.safeParse(value)
  if (!binding.success) throw usage('--binding takes a complete assignment.', {
    reason: 'invalid_binding',
    next: [{ instruction: 'Provide controller, owner, provider, model, session, branch, worktree, and a full baseCommit' }],
  })
  return binding.data
}

/**
 * The profile this run writes as, as an actor's ID has it: `--as`'s, or the environment's
 * (`BOARD_PROFILE`), or null as yourself. `vb()`'s board is a handle that already is someone, so
 * only `--as` names one there.
 */
function writesAs(): string | null {
  const profile = profileFlag() ?? (io.board ? null : environmentProfile())
  const name = typeof profile === 'string' ? profile : (profile?.name ?? null)
  return name === null ? null : name.toLowerCase()
}

/** `--as` as this run typed it, for a way out that claims: the claim it takes is then the one the next command, typed the same way, finds. */
export const asTyped = () => (flags.as ? ['--as', flags.as] : [])

/**
 * This run's board, and the claims it holds there as whoever it writes as. A claim's token is the
 * CLI's to keep: in a file under its config directory, by the board's URL, the task, and the
 * profile this run writes as; or for `vb()`, whose board is a handle, in the store its caller
 * passes, or else in memory for as long as the handle lasts.
 */
export function tasksOn(): { board: Board; claims: Claims } {
  const profile = writesAs()
  if (io.board) {
    const board = (taskBoard = client())
    const claims = io.claimToken !== undefined ? tokenClaims(board, io.claimToken) : io.claims?.(profile) ?? memoryClaims(io.claimsOf ?? io.board, profile)
    return { board, claims }
  }
  const { board, url } = connection()
  taskBoard = board
  return { board, claims: fileClaims(async () => url ?? (await board.discovery()).url, profile) }
}

/** The actor `profile` names under `principal`: a task is assigned to one of its owner's profiles. */
export const profileActor = (principal: string, profile: string) => `${principal}+${profile.toLowerCase()}`

/** A write to a task that answers its root: with `--json`, the task and what happened to it. */
export function printTask(task: MessageView, outcome: string, more: object = {}) {
  if (flags.json) result({ task, outcome, ...more })
  else out(`${outcome} ${messageRef(task.id)}`)
}

/** A claim: the task, how long it's yours, and what it is. With `--json`, the task and the claim, without its token, which the CLI keeps. */
export function printClaim(task: MessageView, claim: { epoch: number; until: string }, more: object = {}) {
  if (flags.json) result({ task, claim: { epoch: claim.epoch, until: claim.until }, ...more })
  else out(claimLine(task, claim.until))
}

/** An operator unparks as themselves: dropping --as leaves any environment profile in effect. */
function unparkRecovery(id: string): Recovery {
  const withoutProfile = !io.board && environmentProfile() ? ' with BOARD_PROFILE unset' : ''
  return {
    instruction: `Or, as an operator, lift the park${withoutProfile}`,
    argv: [...cli(), 'tasks', 'unpark', id, 'resume work', ...onSameBoard()],
  }
}

/**
 * This run's claim on task `id`, as the board's handle acts on it, or the failure that says it
 * holds none as whoever it writes as: a claim taken as one profile isn't another's, or yours.
 */
export async function heldBy(board: Board, claims: Claims, id: string) {
  const stored = await claims.get(id)
  if (stored) return { ...stored, ...board.tasks.held(id, stored) }
  const none = `You hold no claim on task ${ref(id)} as ${writesAs() ?? 'yourself'}.`
  const notHeld = (why: string, next: Recovery[]) =>
    new Failed({ class: 'conflict', reason: 'claim_not_held', message: why ? `${none} ${why}` : none, next })
  const here = onThisBoard()
  // A claim of one that's held, waiting, or finished would be refused too: what it is says the step that comes first, or that there's none.
  const task = await board.thread(id, { limit: 1 }).then(({ message }) => message.task, () => undefined)
  const see: Recovery = { instruction: 'See where it stands', argv: [...cli(), 'read', id, ...here] }
  if (task?.state === 'blocked') {
    if (task.parked) throw notHeld("It's parked: claim it once the park lifts.", [see, unparkRecovery(id)])
    const held = "It's held for a person: claim it once the hold lifts."
    if (task.attentionId !== undefined) {
      // An answered request stays visible even if a later plain hold blocks the task again.
      const request = await board.tasks.attention(id).then(({ attention }) => attention, () => null)
      if (request?.id !== task.attentionId) throw notHeld(held, [see])
      if (request.status === 'pending' || request.status === 'stale')
        throw notHeld('It needs a structured answer: claim it once the hold lifts.', [{
          instruction: 'See the current request', argv: [...cli(), 'tasks', 'attention', id, ...here],
        }])
    }
    throw notHeld(held, [{ instruction: 'As its owner, lift the hold, then claim it', argv: [...cli(), 'tasks', 'unblock', id, ...here] }, see])
  }
  if (task?.state === 'waiting') {
    const needs = task.needs.map(ref)
    throw notHeld(`It waits for what it needs${needs.length ? ` (${needs.join(', ')})` : ''}: claim it once those complete.`, [
      { instruction: 'See what it waits for', argv: see.argv },
    ])
  }
  if (task?.state === 'completed' || task?.state === 'failed' || task?.state === 'canceled')
    throw notHeld(`It's ${task.state} already.`, [see])
  throw notHeld('', [{ instruction: 'Claim it', argv: [...cli(), 'tasks', 'claim', id, ...here] }])
}

/** A write a claim makes. One the board answers `claim_lost` is over: the CLI forgets it, and the failure says how to claim again. */
export async function withClaim<T>(claims: Claims, id: string, proof: ClaimProof, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof BoardError && error.code === 'claim_lost') await claims.drop(id, proof)
    throw error
  }
}

/**
 * `--label` on `claim --ready` and `run --ready`: each an exact `key=value`, the one thing a claim
 * matches. The list's `key=a|b` and bare `key` would match nothing, or the value `a|b`, and wait
 * out its `--wait` without a word: they're refused, with the claim of one value and the list.
 */
export function readyLabels(values: string[], target: string, verb: 'claim' | 'run'): Record<string, string> {
  for (const value of values) {
    const at = value.indexOf('=')
    const options = at > 0 ? value.slice(at + 1).split('|') : []
    if (at > 0 && options.length < 2) continue
    const key = at > 0 ? value.slice(0, at) : value
    if (at === 0) throw usage(`--label on ${verb} --ready takes key=value, and ${value} has no key before its =.`)
    const listed = { instruction: "See what's ready, and their labels", argv: [...cli(), 'tasks', target, '--state', 'ready', '--label', value] }
    if (at === -1)
      throw usage(`--label on ${verb} --ready takes key=value: ${value} has no value, and a claim matches one exactly.`, { next: [listed] })
    // The same command with the first value alone, the label written as it was. What follows `--` is run's
    // command, which it hands over as it is: the same text there is the command's own, and stays.
    const one = `${key}=${options[0]}`
    const dash = typed.indexOf('--')
    const ours = (index: number) => dash === -1 || index < dash
    const again = [...cli(), ...typed.map((arg, index) => (!ours(index) ? arg : arg === value && typed[index - 1] === '--label' ? one : arg === `--label=${value}` ? `--label=${one}` : arg))]
    throw usage(`--label on ${verb} --ready takes one value: ${value} has ${options.length}, and a claim matches one exactly.`, {
      next: [{ instruction: `Claim one with ${one}`, argv: again }, listed],
    })
  }
  return labelPairs(values)
}

/**
 * Claims a task for this run, by its ID or with `--ready` the highest priority eligible one in `target`, and
 * keeps the claim. With nothing ready it fails: `nothing_ready`, or `timeout` once `--wait` ran
 * out, as `wait` does. Stopped while it waits, it answers the exit code instead.
 */
export async function claimFor(board: Board, claims: Claims, target: string | undefined, verb: 'claim' | 'run', binding?: TaskBinding): Promise<ClaimedTask | number> {
  const lease = seconds('lease')
  const options = {
    ...(lease !== undefined ? { lease } : {}),
    ...(binding !== undefined ? { binding } : {}),
    ...(io.claimToken !== undefined ? { token: io.claimToken } : {}),
  }
  if (!flags.ready) {
    for (const given of ['label', 'from', 'wait'] as const)
      if (flags[given] !== undefined) throw usage(`--${given} goes with --ready, which claims the next ready task in a channel.`)
    const claim = await board.tasks.claim(taskId(target), options)
    await claims.put(claim.task.id, { epoch: claim.epoch, token: claim.token, until: claim.until })
    return claim
  }
  if (target === undefined) throw usage('Missing the channel to claim a task in: work, or work/ for all under it.', { reason: 'missing_arguments' })
  const wait = seconds('wait')
  // In-process, calls run one at a time: one that waits holds the rest, so it needs a way to be stopped, as `wait` does.
  if (io.board && !io.signal && wait !== undefined)
    throw usage('--wait holds every later call, as vb() runs one at a time: pass a signal.', { reason: 'not_available', next: [] })
  const controller = new AbortController()
  const stop = stopOn(controller)
  let claim: ClaimedTask | null
  try {
    claim = await board.tasks.claim(
      {
        channel: target,
        ...(flags.label?.length ? { label: readyLabels(flags.label, target, verb) } : {}),
        // Owners by their IDs: a handle names no owner.
        ...(flags.from?.length ? { from: flags.from } : {}),
        ...(wait !== undefined ? { wait } : {}),
        ...options,
      },
      { signal: controller.signal },
    )
  } catch (error) {
    // Stopped while it waited: it says nothing, as `wait` does.
    if (controller.signal.aborted) return stop.interrupted() ? 130 : 0
    throw error
  } finally {
    stop.release()
  }
  if (claim) {
    await claims.put(claim.task.id, { epoch: claim.epoch, token: claim.token, until: claim.until })
    return claim
  }
  if (controller.signal.aborted) return stop.interrupted() ? 130 : 0
  if (wait !== undefined) throw new Failed({ class: 'timeout', reason: 'timeout', message: `Nothing was ready in ${target} within ${flags.wait}.` })
  throw new Failed({
    class: 'not_found',
    reason: 'nothing_ready',
    message: `Nothing is ready in ${target}.`,
    next: [
      { instruction: 'Wait for one', argv: rerun('--wait', '10m') },
      { instruction: "Or see what's there", argv: [...cli(), 'tasks', target] },
    ],
  })
}

type One = (extra: string | undefined, takes: string) => void

export async function parkTask(verb: 'park' | 'unpark', id: string, rest: string[], one: One, reason: (what: string) => string): Promise<number> {
  one(rest[2], 'a task and a reason, quoted')
  const why = reason(verb === 'park' ? 'why it is being parked' : 'why it is being unparked')
  const board = (taskBoard = client())
  const task = await board.tasks[verb](id, why)
  printTask(task, verb === 'park' ? 'parked' : 'unparked')
  return 0
}

export async function handoffTask(id: string, rest: string[]): Promise<number> {
  if (rest[4] !== undefined) throw usage('tasks handoff takes a task, commit, packet path, and SHA-256.')
  const [, commit, packetPath, sha256] = rest
  if (!commit || !packetPath || !sha256)
    throw usage('Pass a full commit ID, a repo-relative packet path, and its SHA-256 digest.', { reason: 'missing_arguments' })
  const packet = TaskPacket.safeParse({ commit, packetPath, sha256, supersedes: flags.supersedes })
  if (!packet.success) throw usage('Use a full commit ID, a repo-relative packet path, and a lowercase SHA-256 digest.')
  const { board, claims } = tasksOn()
  const held = await heldBy(board, claims, id)
  const task = await withClaim(claims, id, held, () => held.handoff(packet.data))
  const handoff = task.task?.handoff
  if (flags.json) result({ task, outcome: 'handed_off' })
  else out(`handed off ${messageRef(task.id)}${handoff ? `  ${handoff.id}` : ''}`)
  return 0
}

export async function taskCommand(verb: 'show' | 'priority' | 'ask' | 'attention' | 'answer', board: Board, claims: Claims, id: string, rest: string[], one: One): Promise<number> {
  switch (verb) {
    case 'show': {
      one(rest[1], 'one task')
      const { message, replies } = await board.thread(id)
      if (message.id !== id || !message.task)
        throw new Failed({ class: 'not_found', reason: 'not_a_task', message: `${ref(id)} isn't a task.` })
      if (flags.json) result({ task: message })
      else out(formatTasks([{ message, replies: replies.length, last: replies.at(-1) ?? null }], true))
      return 0
    }
    case 'priority': {
      one(rest[2], 'a task and a priority')
      if (rest[1] === undefined) throw usage('Missing the priority.', { reason: 'missing_arguments' })
      const priority = priorityOf(rest[1], 'Priority')
      const stored = await claims.get(id)
      const task = stored
        ? await withClaim(claims, id, stored, () => board.tasks.held(id, stored).priority(priority))
        : await board.tasks.priority(id, priority)
      if (flags.json) result({ task, outcome: 'set' })
      else out(`${messageRef(id)}  priority ${task.task?.priority ?? priority}`)
      return 0
    }
    case 'ask': {
      one(rest[1], 'one task and --file')
      if (!flags.file) throw usage('Missing --file <path> for the attention draft.', { reason: 'missing_arguments' })
      const draft = await attentionFrom(flags.file)
      const stored = await claims.get(id)
      const request = stored ? { ...draft, claim: { epoch: stored.epoch, token: stored.token } } : draft
      // Don't drop the cached proof: another process might already have stored the next claim.
      let answer
      try {
        answer = await board.tasks.ask(id, request)
      } catch (error) {
        if (!stored || !(error instanceof BoardError) || error.origin !== 'board' || error.code !== 'claim_lost') throw error
        // The board refused the proof. Let it check ownership and state again without one.
        answer = await board.tasks.ask(id, draft)
      }
      if (flags.json) result(answer)
      else out(`requested attention on ${ref(id)}  ${answer.attention.id}`)
      return 0
    }
    case 'attention': {
      one(rest[1], 'one task')
      const answer = await board.tasks.attention(id)
      if (flags.json) result(answer)
      else out(answer.attention ? formatAttention(answer.attention) : `no attention request on ${ref(id)}`)
      return 0
    }
    case 'answer': {
      one(rest[3], 'a task, a request ID, an option, and --commit')
      const [, requestId, option] = rest
      if (!requestId || !option || !flags.commit) throw usage('Missing the request ID, option, or --commit <sha>.', { reason: 'missing_arguments' })
      const checked = AttentionAnswerBody.safeParse({ option, commit: flags.commit })
      if (!checked.success) throw usage('Pass an option ID and a full lowercase SHA-1 or SHA-256 with --commit.')
      const answer = await board.tasks.answer(id, requestId, checked.data)
      if (flags.json) result(answer)
      else out(`answered ${ref(id)}  ${answer.task.task?.state ?? ''}`.trimEnd())
      return 0
    }
  }
}

/** The task this verb names, if any. */
function namedTask(): string | undefined {
  const { command, args: [verb, target] } = current
  return command === 'tasks' && verb !== undefined && TASK_VERBS.has(verb) && target !== undefined && isMessageRef(target) ? messageId(target) : undefined
}

export type TaskHold = 'parked' | 'held' | 'cleared' | 'unknown'

/** A hold and a park share one code. Read the task to see what still holds it, if anything. */
export async function taskHold(): Promise<TaskHold> {
  if (!taskBoard || flags.ready) return 'unknown'
  const id = namedTask()
  if (id === undefined) return 'unknown'
  try {
    const { message } = await taskBoard.thread(id, { limit: 1 })
    if (message.task?.state !== 'blocked') return 'cleared'
    return message.task.parked ? 'parked' : 'held'
  } catch {
    return 'unknown'
  }
}

/** How a board's own word about a task reads from here: the headline, and the way on. Null for any other code. */
export function taskFailure(code: string, status: number, hold: TaskHold): { class: Failure['class']; message: string; next: Recovery[]; whole?: true } | null {
  const { command, args } = current
  const named = namedTask()
  const read = (instruction: string, ...options: string[]): Recovery[] => (named === undefined ? [] : [{ instruction, argv: [...cli(), 'read', named, ...options] }])
  const also = (instruction: string, ...words: string[]): Recovery[] => (named === undefined ? [] : [{ instruction, argv: [...cli(), 'tasks', words[0]!, named, ...words.slice(1)] }])
  switch (code) {
    case 'task_claimed':
      return { class: 'conflict', message: `Can't ${doing()}. Someone holds it.`, next: read('See who holds it, and until when') }
    case 'task_assigned':
      return { class: 'conflict', message: `Can't ${doing()}. It's assigned to another profile.`, next: [...read("See whom it's for"), ...also('Or, as its owner, return it to the pool', 'assign', '--pool')] }
    case 'task_waiting':
      return { class: 'conflict', message: `Can't ${doing()}. It waits for other tasks.`, next: read('See what it waits for') }
    case 'task_blocked': {
      const board = onSameBoard()
      if (hold === 'cleared') {
        const skipRetry = command === 'tasks' &&
          (args[0] === 'cancel' || args[0] === 'unblock')
        const message = `Can't ${doing()}. ` +
          'It was held, and the hold is lifted now.'
        return {
          class: 'conflict',
          message: skipRetry ? message : `${message} Try again.`,
          next: read('See where it stands', ...board, ...asTyped()),
        }
      }
      const see = read("See what it's held for", ...board, ...asTyped())
      if (hold === 'unknown') return { class: 'conflict', message: `Can't ${doing()}. It's held, but the CLI couldn't read the task to see why.`, next: see }
      if (hold === 'parked') return { class: 'conflict', message: `Can't ${doing()}. It's parked.`, next: named === undefined ? see : [...see, unparkRecovery(named)] }
      const lift = args[0] === 'unblock' ? [] : also('Or, as its owner, lift the hold', 'unblock', ...board, ...asTyped())
      return { class: 'conflict', message: `Can't ${doing()}. It's held for a person.`, next: [...see, ...lift] }
    }
    case 'task_finished':
      return { class: 'conflict', message: `Can't ${doing()}. It's finished.`, next: read('See how it ended') }
    case 'binding_mismatch':
      return { class: 'conflict', message: `Can't ${doing()}. The live claim has a different binding.`, next: read('See the current claim') }
    case 'handoff_conflict':
      return { class: 'conflict', message: `Can't ${doing()}. Use --supersedes only to name the current handoff.`, next: read('See the current handoff') }
    case 'no_task_authority':
      return status === 501 ? { class: 'platform', message: `Can't ${doing()}. This board does not support parking, assignment bindings, or handoffs.`, next: [] } : null
    case 'claim_lost':
      return { class: 'conflict', message: `Lost the claim on ${named === undefined ? 'the task' : `task ${ref(named)}`}. Its lease ran out, or the task moved on.`, next: [...read('See where it stands'), ...also('Or claim it again', 'claim', ...asTyped())] }
    case 'priority_raise_forbidden':
      return { class: 'permission', message: `Can't ${doing()}. A claim can lower priority, not raise it.`, next: [...read('See the current priority'), { instruction: 'Ask a task owner or channel manager to raise it' }] }
    case 'task_not_owned':
      return { class: 'permission', message: `You can't ${doing()}. It's someone else's.`, next: read('See whose it is') }
    case 'not_a_task':
      return { class: 'not_found', message: `${named === undefined ? 'That' : ref(named)} isn't a task.`, next: also('Make it one', 'create'), whole: true }
    case 'already_a_task':
      return { class: 'conflict', message: `${named === undefined ? 'That' : ref(named)} is a task already.`, next: read('See it'), whole: true }
    case 'invalid_from':
      return { class: 'usage', message: `Can't ${doing()}. --from takes an owner's ID: several can share a handle.`, next: [{ instruction: "See everyone's IDs", argv: [...cli(), 'actors'] }] }
    case 'invalid_needs':
      // A plan's tasks name each other by key too: what's wrong is in the board's words, under this.
      if (flags.file !== undefined) return { class: 'usage', message: `Can't ${doing()}. A task's needs are tasks you can read, or keys of the plan's own.`, next: [{ instruction: 'See the tasks there are', argv: [...cli(), 'tasks', '--state', 'all'] }] }
      // A change of what a task waits for takes what a new task takes, and none that waits for it: the board's words say which.
      if (command === 'tasks' && args[0] === 'needs') return { class: 'usage', message: `Can't ${doing()}. It waits for tasks you can read, and none that waits for it.`, next: [...read('See what it waits for now'), { instruction: 'Or see the tasks there are', argv: [...cli(), 'tasks', '--state', 'all'] }] }
      return { class: 'usage', message: `Can't ${doing()}. --needs takes tasks you can read.`, next: [{ instruction: 'See the tasks there are', argv: [...cli(), 'tasks', '--state', 'all'] }] }
    // A board's own bounds on how much one request looks through, as Vercel's has: less of the tree fits.
    case 'claim_too_wide':
      return { class: 'limit', message: `Can't ${doing()}. That's too many channels and owners.`, next: [{ instruction: 'Name fewer owners with --from, or a smaller subtree' }] }
    case 'channel_tree_too_large':
      return { class: 'limit', message: `Can't ${doing()}. That's too many channels.`, next: [{ instruction: 'Name a channel, or a smaller subtree' }] }
    case 'attention_stale':
    case 'attention_required':
      return status === 409 ? { class: 'conflict', message: `Can't ${doing()}. ${code === 'attention_required' ? 'It needs a structured answer.' : 'The request or its snapshot is no longer current.'}`, next: also('See the current request', 'attention', ...asTyped()) } : null
    case 'no_task_attention':
      return status === 501 ? { class: 'platform', message: `Can't ${doing()}. This board does not support task attention.`, next: [] } : null
    case 'no_tasks':
      return status === 501 ? { class: 'platform', message: `Can't ${doing()}. This board keeps no tasks.`, next: [] } : null
    case 'reserved_label':
      return { class: 'usage', message: `Can't ${doing()}. Labels under board. are the board's own.`, next: stateCommand() }
    default:
      return null
  }
}

export function doingTasks(a: string | undefined, b: string | undefined): string {
  if (a === undefined || !TASK_VERBS.has(a)) return a === undefined ? 'list tasks' : `list tasks in ${a}`
  const one = b === undefined ? 'a task' : `task ${ref(b)}`
  // `run` fails as its claim does, before its command starts, or as what it settles with after.
  if (a === 'claim' || a === 'run') return flags.ready ? `claim a task in ${b ?? 'a channel'}` : `claim ${one}`
  if (a === 'create' && flags.file !== undefined) return `create tasks in ${b ?? 'a channel'}`
  if (a === 'create') return b !== undefined && isMessageRef(b) ? `make ${ref(b)} a task` : `create a task in ${b ?? 'a channel'}`
  if (a === 'renew') return `renew the claim on ${one}`
  if (a === 'handoff') return `record a handoff for ${one}`
  if (a === 'needs') return `change what ${one} needs`
  if (a === 'ask') return `request attention on ${one}`
  if (a === 'attention') return `read the attention request on ${one}`
  if (a === 'answer') return `answer the attention request on ${one}`
  return `${a} ${one}`
}
