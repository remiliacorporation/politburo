import { isDeepStrictEqual } from 'node:util'
import { block, BoardError, type board as openBoard, type MessageView } from '@vercel/board'
import { gates, isEvidence, type Attestation, type Evidence, type Override } from './evidence.ts'
import { decideMove, refuse, stages, type MoveResult, type MoveRoot, type Role, type Stage } from './stages.ts'

type Board = ReturnType<typeof openBoard>
type Draft<T extends Evidence> = Omit<T, 'id' | 'taskId' | 'author' | 'at' | 'kind'>
type Request = { actor: string; reason?: string; requestId?: string }
type Facts = Omit<MoveRoot, 'taskId' | 'paused' | 'parked'> & { role: Role; scopeRef?: string; handoffId?: string; generation?: number }

// Adapter boundary for unlanded party roles, claim admission, review holds, artifact verification and settlement.
export interface Dispatcher {
  inspect(root: MessageView, request: { actor: string; from: Stage | null; to: Stage }): Promise<Facts | null>
  attest(root: MessageView, draft: Draft<Attestation>): Promise<string | null>
  jockey(root: MessageView, who: string, draft: Draft<Override>): Promise<string | null>
  landed(move: { taskId: string; requestId: string; receiptId: string; to: 'implementing' | 'done'; round: number }): Promise<void>
}

const moveSchema = 'swarm-move'
const evidenceSchema = 'swarm-evidence'
const string = { type: 'string' }
const number = { type: 'number' }
const integer = { type: 'integer' }
const nullable = { type: ['string', 'null'] }
const shape = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
})
const binding = {
  id: string, taskId: string, partyId: string, round: integer, commit: string,
  gate: { enum: gates }, author: string, at: number, expiresAt: number,
}
const evidenceProperties = {
  ...binding, kind: { enum: ['attestation', 'override'] }, verdict: { enum: ['pass', 'fail'] }, reason: string,
  artifactRef: { oneOf: [shape({ sha256: string, attachmentId: string }), shape({ sha256: string, repo: string, commit: string, path: string })] },
}
const labels = (root: MessageView) => ({
  'work.stage': root.labels['work.stage'] ?? null, 'work.round': root.labels['work.round'] ?? null,
  'work.move': root.labels['work.move'] ?? null,
})
const state = (root: MessageView) => {
  const { 'work.stage': stage, 'work.round': round, 'work.move': move } = labels(root)
  return { stage: stages.find(value => value === stage) ?? null, round: round === null ? null : Number(round), move }
}

export function createStageService({ board, principal, dispatcher, now = Date.now, newId = () => crypto.randomUUID() }: {
  board: Board; principal: string; dispatcher?: Dispatcher; now?: () => number; newId?: () => string
}) {
  const pending = new Map<string, Promise<unknown>>()
  async function serial<T>(id: string, run: () => Promise<T>) {
    const operation = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(run)
    pending.set(id, operation)
    try { return await operation } finally { if (pending.get(id) === operation) pending.delete(id) }
  }
  const owns = (root: MessageView, id: string) => root.id === id && !root.deleted && root.noSync &&
    !root.origin && !root.from && root.task?.owner === principal
  const writesAsPrincipal = async () => (await board.me()).actor === principal
  const sealed = (reply: MessageView) => reply.by.principal === principal && reply.by.actor === principal && !reply.origin && !reply.from
  const readRoot = async (id: string) => (await board.thread(id, { limit: 1 })).message
  const read = async (id: string) => state(await readRoot(id))

  async function registerSchemas(admin = board) {
    await admin.createSchema({ name: moveSchema, version: 1, schema: shape({
      id: string, previous: nullable, from: nullable, to: { enum: stages }, round: integer, actor: string,
      reason: nullable, scopeRef: nullable, commit: nullable, handoffId: nullable, generation: { type: ['integer', 'null'] },
    }) })
    await admin.createSchema({ name: evidenceSchema, version: 1, schema: {
      ...shape(evidenceProperties, [...Object.keys(binding), 'kind']), oneOf: [
        { properties: { kind: { const: 'attestation' } }, required: ['verdict', 'artifactRef'], not: { required: ['reason'] } },
        { properties: { kind: { const: 'override' } }, required: ['reason'], not: { anyOf: [{ required: ['verdict'] }, { required: ['artifactRef'] }] } },
      ],
    } })
  }

  async function admit(taskId: string, draft: (Draft<Attestation> & { kind: 'attestation' }) | (Draft<Override> & { kind: 'override'; who: string })) {
    const root = await readRoot(taskId)
    if (!dispatcher || !owns(root, taskId) || !await writesAsPrincipal()) throw new Error('forbidden')
    const { partyId, round, commit, gate, expiresAt } = draft
    const binding = { id: newId(), taskId, partyId, round, commit, gate, expiresAt }
    const fields = draft.kind === 'attestation'
      ? { kind: 'attestation' as const, verdict: draft.verdict, artifactRef: draft.artifactRef }
      : { kind: 'override' as const, reason: draft.reason }
    if (!isEvidence({ ...binding, ...fields, author: 'unverified', at: 0 }) || round !== state(root).round ||
      (draft.kind === 'override' && (!draft.who?.trim() || gate === 'submission'))) throw new TypeError('invalid evidence')
    const author = draft.kind === 'attestation'
      ? await dispatcher.attest(root, draft) : await dispatcher.jockey(root, draft.who, draft)
    if (!author?.trim()) throw new Error('forbidden')
    const record: Evidence = { ...binding, ...fields, author, at: now() }
    if (!isEvidence(record)) throw new TypeError('invalid evidence')
    await board.reply(taskId, { text: block(`${evidenceSchema}@1`, record), noSync: true })
    return record
  }

  async function admitted(taskId: string) {
    const records: Evidence[] = []
    const ids = new Set<string>()
    for (const reply of (await board.thread(taskId)).replies.filter(sealed)) {
      // Dropping a modified verdict alone could revive an older pass.
      if (reply.editedAt || reply.deleted) return []
      const blocks = reply.blocks.filter(item => item.schema === evidenceSchema && item.version === 1)
      if (!blocks.length) continue
      const record = blocks[0]!.data
      if (blocks.length !== 1 || !isEvidence(record) || record.taskId !== taskId || ids.has(record.id)) return []
      records.push(record)
      ids.add(record.id)
    }
    return records
  }

  function move(taskId: string, to: Stage, input: Request) {
    const request = { ...input }
    return serial(taskId, async (): Promise<MoveResult> => {
      if (!dispatcher || !await writesAsPrincipal()) return refuse('forbidden')
      const root = await readRoot(taskId)
      const expected = labels(root)
      const from = state(root)
      if (!owns(root, taskId)) return refuse(from.stage === null && to === 'proposed' ? 'intake_missing' : 'forbidden')
      if (from.stage === null ? Object.values(expected).some(value => value !== null) :
        !from.move || expected['work.round'] !== String(from.round)) return refuse('stage_conflict')
      async function check(current: MessageView) {
        const facts = await dispatcher!.inspect(current, { actor: request.actor, from: from.stage, to })
        if (!facts) return { decision: refuse('forbidden'), facts }
        const { paused } = await board.status()
        const decision = decideMove({ stage: from.stage, round: from.round, to, actor: { id: request.actor, role: facts.role },
          ...(request.reason === undefined ? {} : { reason: request.reason }), gates: await admitted(taskId), now: now(),
          root: { ...facts, taskId, paused, parked: Boolean(current.task?.parked) },
        })
        return { decision, facts }
      }
      const { decision, facts } = await check(root)
      if (!decision.ok) return decision
      const receipt = {
        id: request.requestId ?? newId(), previous: from.move, from: from.stage, to, round: decision.round,
        actor: request.actor, reason: request.reason?.trim() || null, scopeRef: facts?.scopeRef ?? null,
        commit: facts?.commit ?? null, handoffId: facts?.handoffId ?? null, generation: facts?.generation ?? null,
      }
      const reply = await board.reply(taskId, { id: receipt.id, text: block(`${moveSchema}@1`, receipt), noSync: true })
      if (!sealed(reply) || reply.re !== taskId || reply.deleted || reply.editedAt ||
        !isDeepStrictEqual(reply.blocks[0]?.data, receipt)) return refuse('stage_conflict')
      const current = await readRoot(taskId)
      if (!owns(current, taskId) || current.revision !== root.revision || !isDeepStrictEqual(labels(current), expected)) return refuse('stage_conflict')
      const sameRefs = (fresh: Facts | null) => fresh?.commit === facts?.commit && fresh?.handoffId === facts?.handoffId &&
        fresh?.generation === facts?.generation && fresh?.scopeRef === facts?.scopeRef
      const final = await check(current)
      if (!final.decision.ok) return final.decision
      if (!sameRefs(final.facts)) return refuse('stage_conflict')
      try {
        await board.label(taskId, { if: expected, set: { 'work.stage': to, 'work.round': String(decision.round), 'work.move': reply.id } })
      } catch (error) {
        if (!(error instanceof BoardError) || error.status !== 409 || error.code !== 'label_conflict') throw error
        await read(taskId)
        return refuse('stage_conflict')
      }
      if (to === 'implementing' || to === 'done') {
        const landed = await readRoot(taskId)
        const recheck = await check(landed)
        if (state(landed).move !== reply.id || landed.revision !== root.revision || !recheck.decision.ok || !sameRefs(recheck.facts)) {
          throw new Error(to === 'done' ? 'completion_pending' : 'admission_refused')
        }
        await dispatcher.landed({ taskId, requestId: receipt.id, receiptId: reply.id, to, round: decision.round })
      }
      return decision
    })
  }
  return {
    read, registerSchemas, move,
    admitEvidence: (id: string, draft: Draft<Attestation>) => {
      const input = structuredClone(draft)
      return serial(id, () => admit(id, { ...input, kind: 'attestation' }))
    },
    override: (id: string, draft: Draft<Override> & { who: string }) => {
      const input = structuredClone(draft)
      return serial(id, () => admit(id, { ...input, kind: 'override' }))
    },
  }
}
