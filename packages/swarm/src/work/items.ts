import { createHash, randomUUID } from 'node:crypto'
import { BoardError, type Board } from '@vercel/board'
import { parseOutcomesContract } from './contract.ts'
import { allocateWorkId, parseWorkId } from './ids.ts'
import type { Link } from './links.ts'
import { workItemBlock, type WorkKind } from './record.ts'

type Root = Awaited<ReturnType<Board['thread']>>['message']
type WorkTask = Root & { task: NonNullable<Root['task']> }
type Publication = { claimable: boolean; problems: string[] }
export type NewWorkItem = {
  channel: string; tag: string; tags: readonly string[]; title: string
  kind: WorkKind; repo: string; description: string; links: readonly Link[]
  id?: string; reservation?: string
}

const isError = (error: unknown, code: string) => error instanceof BoardError && error.code === code
const outcomes = 'outcomes'
const manual = 'manual_only'

async function readTask(board: Board, id: string): Promise<WorkTask> {
  const { message } = await board.thread(id, { limit: 1 })
  if (message.id !== id || message.deleted || !message.task) throw new Error(`Not a live task root: ${id}`)
  return message as WorkTask
}

async function gateKey(board: Board, channel: string) {
  const { principal, actor } = await board.me()
  const assignee = `${principal}+work-contract-gate`
  if (actor === assignee) throw new Error('Use the dispatcher handle, not the reserved gate profile.')
  const key = createHash('sha256').update(JSON.stringify([channel, actor])).digest('hex')
  return { id: `work-contract-gate:${key}`, assignee }
}

// One held prerequisite per channel and writer. An assignment alone would still let the
// assigned profile claim the work item; needs makes the new work root waiting for everyone.
async function gate(board: Board, channel: string) {
  const { id, assignee } = await gateKey(board, channel)
  const { task: root } = await board.tasks.create(channel, {
    id, text: 'Work contract publication gate. Keep held.', for: assignee,
    labels: { 'work.gate': 'contract' }, noSync: true,
  })
  if (!root.task || root.deleted || root.labels['work.gate'] !== 'contract') throw new Error('Invalid publication gate.')
  if (root.task.state === 'ready') {
    try {
      await board.tasks.block(root.id, 'Only validated work contracts leave this gate.', { kind: 'contract_gate' })
    } catch (error) {
      if (!isError(error, 'task_blocked')) throw error
    }
  }
  const { task } = await readTask(board, root.id)
  if (task.blocked?.kind !== 'contract_gate' || task.for !== assignee) throw new Error('Publication gate is not held.')
  return root.id
}

async function dropGate(board: Board, root: WorkTask) {
  if (!root.task.needs.length) return
  const { id } = await gateKey(board, root.channel)
  let gateId: string
  try {
    gateId = (await board.posted(id)).id
  } catch (error) {
    if (error instanceof BoardError && error.status === 404) return
    throw error
  }
  if (root.task.needs.includes(gateId)) await board.tasks.needs(root.id, root.task.needs.filter(need => need !== gateId))
}

async function ownsOutcomesHold(board: Board, root: WorkTask, actor: string): Promise<boolean> {
  const { blocked, parked, attentionId } = root.task
  if (blocked?.kind !== outcomes || parked || attentionId) return false
  // The current task view omits the hold author (`task.by` is the creator).
  // Recover it from the board-authored hold event as of this task version.
  let after = root.id
  let writer: string | undefined
  for (;;) {
    const page = await board.poll({ re: root.id, after, wait: 0 })
    for (const event of page.events) {
      if (event.message?.id !== root.id) continue
      if (event.message.version > root.version) return writer === actor
      if (event.type === 'task.unblocked') writer = undefined
      if (event.type === 'task.blocked') {
        writer = event.payload.kind === blocked.kind && event.payload.reason === blocked.reason
          ? event.payload.by?.actor : undefined
      }
    }
    if (page.cursor === after) return writer === actor
    after = page.cursor
  }
}

const heldProblem = (root: WorkTask) =>
  root.task.parked?.reason ?? root.task.blocked?.reason ?? 'The outcomes hold changed during publication.'

export async function workIdHighWater(board: Board, tag: string) {
  let max = 0
  let after: string | undefined
  for (;;) {
    const page = await board.tasks.list({ state: 'all', label: ['work.id'], limit: 500, ...(after ? { after } : {}) })
    for (const { message } of page.tasks) {
      const id = parseWorkId(message.labels['work.id'] ?? '')
      if (id?.tag === tag) max = Math.max(max, id.number)
    }
    if (page.tasks.length < 500) return max
    after = page.cursor
  }
}

export async function createWorkItem(board: Board, input: NewWorkItem) {
  const { channel, tags, title, kind, repo, description, links } = input
  const tag = input.tag.toLowerCase()
  if (!/^[a-z]{3}$/.test(tag) || !tags.includes(tag)) throw new RangeError('Unknown work tag.')
  if (!title.trim() || /[\r\n]/.test(title)) throw new TypeError('A work item needs a single-line title.')
  const fixed = input.id
  const parsed = fixed === undefined ? null : parseWorkId(fixed)
  if (fixed !== undefined && (parsed?.tag !== tag || fixed !== `${tag}-${parsed.number}`)) {
    throw new RangeError('Invalid fixed work id.')
  }
  const text = `${title}\n\n${description}`
  const prerequisite = await gate(board, channel)
  let max = fixed === undefined ? await workIdHighWater(board, tag) : 0
  for (let retry = 0; retry < (fixed === undefined ? 5 : 1); retry++) {
    const id = fixed ?? allocateWorkId(tags, tag, max++).id
    const metadata = { work_id: id, repo, kind, links }
    workItemBlock({ ...metadata, contract_revision: null })
    // Board label keys allow dots outside the reserved board.* prefix. work.id, work.kind
    // and work.repo are filterable. A fixed reservation distinguishes retries of
    // this operation from someone else's use of the same work id.
    const nonce = (fixed === undefined ? undefined : input.reservation) ?? randomUUID()
    let root: Root
    try {
      const made = await board.tasks.create(channel, {
        id: `work-id:${id}`, text, needs: [prerequisite],
        labels: { 'work.id': id, 'work.kind': kind, 'work.repo': repo, 'work.reservation': nonce },
      })
      root = made.task
    } catch (error) {
      if (fixed === undefined && isError(error, 'duplicate_id')) continue
      throw error
    }
    if (root.labels['work.reservation'] !== nonce) {
      if (fixed !== undefined) throw new Error(`Work id ${fixed} is already reserved.`)
      continue
    }
    if (fixed !== undefined && (root.deleted || !root.task || root.channel !== channel ||
      root.labels['work.id'] !== id || root.labels['work.repo'] !== repo || root.labels['work.kind'] !== kind)) {
      throw new Error(`Work id ${fixed} does not match the reservation.`)
    }
    // The work-item block's contract_revision is creation-time metadata.
    await board.reply(root.id, {
      ...(fixed === undefined ? {} : { id: `work-item:${fixed}` }),
      text: workItemBlock({ ...metadata, contract_revision: parseOutcomesContract(root.text).valid ? String(root.revision) : null }),
      noSync: true,
    })
    const publication = await publishContract(board, root.id, description)
    return { workId: id, taskId: root.id, ...publication }
  }
  throw new Error(`Could not reserve a work id for ${tag} in five attempts.`)
}

// Serialize the dispatcher's own edits and hold transitions in this process.
const pending = new Map<string, Promise<unknown>>()
async function serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const next = (pending.get(id) ?? Promise.resolve()).then(operation, operation)
  pending.set(id, next)
  try { return await next } finally { if (pending.get(id) === next) pending.delete(id) }
}

/** `between` is a test seam after validation and before the final hold check. */
export function publishContract(board: Board, taskId: string, description: string, between?: () => Promise<void>): Promise<Publication> {
  return serial(taskId, async () => {
    const { actor } = await board.me()
    let root = await readTask(board, taskId)
    const text = `${root.text.split(/\r?\n/, 1)[0]}\n\n${description}`
    const proposed = parseOutcomesContract(text)
    const stopped = (...problems: string[]): Publication => ({ claimable: false, problems })
    const available = (current: WorkTask): Publication => {
      const reason = claimReason(current, actor)
      return reason === null ? { claimable: true, problems: [] } : stopped(reason)
    }
    if (root.task.blocked || root.task.parked) {
      if (!await ownsOutcomesHold(board, root, actor)) return stopped(heldProblem(root))
    } else {
      if (!['ready', 'waiting'].includes(root.task.state)) return stopped(root.task.state)
      if (text === root.text && proposed.valid && root.task.state === 'ready') return available(root)
      try {
        await board.tasks.block(taskId, proposed.valid ? 'Validating a new outcomes contract.' : proposed.problems.join('; '), { kind: outcomes })
      } catch (error) {
        if (!(error instanceof BoardError) || error.status !== 409) throw error
        return stopped(error.message)
      }
      root = await readTask(board, taskId)
      if (!await ownsOutcomesHold(board, root, actor)) return stopped(heldProblem(root))
    }
    if (text !== root.text) {
      await board.edit(taskId, text, { revision: root.revision })
      root = await readTask(board, taskId)
    }
    const stored = parseOutcomesContract(root.text)
    if (stored.valid && root.text !== text) return stopped('The task text changed before publication.')

    if (stored.valid) await between?.()
    root = await readTask(board, taskId)
    if (!await ownsOutcomesHold(board, root, actor)) return stopped(heldProblem(root))
    if (root.task.needs.length) {
      await dropGate(board, root)
      root = await readTask(board, taskId)
      if (!await ownsOutcomesHold(board, root, actor)) return stopped(heldProblem(root))
    }
    if (!stored.valid) return stopped(...stored.problems)
    const latest = await readTask(board, taskId)
    if (latest.version !== root.version) return stopped(heldProblem(latest))
    if (latest.text !== text) return stopped('The task text changed before publication.')
    try {
      await board.tasks.unblock(taskId)
    } catch (error) {
      if (!(error instanceof BoardError) || error.status !== 409) throw error
      return stopped(error.message)
    }

    // Until the board offers a conditional unblock (design/swarm-board-additions.md),
    // a manager can replace the hold after our last read, and a claim can slip
    // in between unblock and re-hold.
    root = await readTask(board, taskId)
    const published = parseOutcomesContract(root.text)
    if (root.text !== text || !published.valid) {
      const reason = 'The task text changed during publication.'
      const problems = published.valid ? [reason] : [reason, ...published.problems]
      if (root.task.blocked || root.task.parked) return stopped(...problems, heldProblem(root))
      try {
        await board.tasks.block(taskId, problems.join('; '), { kind: outcomes })
      } catch (error) {
        if (!(error instanceof BoardError) || error.status !== 409) throw error
        return stopped(...problems, error.message)
      }
      return stopped(...problems)
    }
    return available(root)
  })
}

function claimReason({ task }: WorkTask, actor: string): string | null {
  return task.parked?.reason ?? task.blocked?.reason ??
    (task.state !== 'ready' && !(task.state === 'claimed' && Date.parse(task.claim?.until ?? '') <= Date.now()) ? task.state : null) ??
    (task.for && task.for !== actor ? `Assigned to ${task.for}.` : null)
}

/** State eligibility for this handle, not an authorization check or a claim. */
export async function claimable(board: Board, taskId: string): Promise<{ claimable: boolean; reason: string | null }> {
  const reason = claimReason(await readTask(board, taskId), (await board.me()).actor)
  return { claimable: reason === null, reason }
}

export function markManualOnly(board: Board, taskId: string, actor: string, reason: string): Promise<void> {
  return serial(taskId, async () => {
    if (!reason.trim()) throw new TypeError('A manual-only hold needs a reason.')
    if ((await board.me()).actor !== actor) throw new TypeError('Manual-only actor must match the board handle.')
    const root = await readTask(board, taskId)
    if (root.task.blocked?.kind === manual) return
    if (root.task.blocked || root.task.parked) {
      if (!await ownsOutcomesHold(board, root, actor)) throw new Error('Cannot replace another hold.')
      // Keep the task waiting while replacing our outcomes hold.
      const prerequisite = await gate(board, root.channel)
      await board.tasks.needs(taskId, [...new Set([...root.task.needs, prerequisite])])
      const latest = await readTask(board, taskId)
      if (!await ownsOutcomesHold(board, latest, actor) || (await readTask(board, taskId)).version !== latest.version) {
        throw new Error('The hold changed before it could be replaced.')
      }
      await board.tasks.unblock(taskId)
    }
    await board.tasks.block(taskId, reason, { kind: manual })
    await dropGate(board, await readTask(board, taskId))
  })
}
