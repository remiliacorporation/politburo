import type { Protocol } from '../api/protocol.ts'
import type { Discovery } from '../api/routes.ts'
import { currentEvidence, unexpired, type AttestationGate, type EvidencePolicy, type Gate } from '../contract/evidence.ts'
import type { Message, Task } from '../contract/folds.ts'
import { authorize, type Access, type Permission } from './access.ts'
import { badRequest, forbidden, HttpError, notFound } from './errors.ts'
import { indexOf, ref } from './feed.ts'
import type { Events, Identity } from './writes.ts'

export const noWorkEvidence = () => new HttpError(501, 'no_work_evidence', 'this board keeps no work evidence for this operation')
const conflict = (code: string, message: string) => new HttpError(409, code, message)
const stale = () => conflict('stale_candidate', 'the commit and round must name the current submission')

type Root = Message & { task: Task }

export function createEvidence(policy: EvidencePolicy | undefined) {
  const required: Gate[] = !policy || policy.gates === false ? [] : ['submission', 'tests', 'review']
  for (const gate of ['browserQA', 'acceptance', 'publication'] as const) if (required.length && policy?.[gate]) required.push(gate)
  const releaseDependencies = policy?.releaseDependencies === true
  const enabled = required.length > 0 || releaseDependencies
  const capability: Discovery['workEvidence'] = enabled ? { version: 1, gates: [...required], releaseDependencies } : undefined
  const attesters = new Map<AttestationGate, ReadonlySet<string>>(Object.entries(policy?.attesters ?? {}).map(([gate, ids]) => [gate as AttestationGate, new Set(ids)]))
  const operators = new Set(policy?.operators)
  const resolvers = new Set(policy?.resolvers)

  function checkEnabled() {
    if (!enabled) throw noWorkEvidence()
  }

  function role(identity: Identity, channel: string, permission: Permission, allowed: ReadonlySet<string> | undefined) {
    authorize(identity.principal.access, permission, channel)
    if (!allowed?.has(identity.principal.id)) throw forbidden('this principal is not configured for this work operation')
  }

  function candidate(root: Root, input: { commit: string; round: number }, now: number, pauseEpoch: number) {
    const state = currentEvidence(root, now, pauseEpoch)
    if (state?.submission.commit !== input.commit || state.submission.round !== input.round) throw stale()
    return state
  }

  function future(expiresAt: string | undefined, now: number) {
    if (expiresAt !== undefined && !unexpired({ expiresAt }, now)) throw badRequest('expiresAt must be in the future')
  }

  function heldBy(root: Root, identity: Identity) {
    const claim = root.task.claim
    if (claim?.principal !== identity.principal.id || claim.actor !== identity.actor.id)
      throw conflict('claim_lost', 'work evidence requires the actor that holds the claim')
    authorize(identity.principal.access, 'label', root.channel)
  }

  function passing(need: Message | undefined, evidenceId: string | undefined, now: number): boolean {
    if (!need || need.task?.state !== 'completed' || evidenceId === undefined) return false
    const state = currentEvidence(need, now)
    return state !== null && (state.submission.id === evidenceId || Object.values(state.evidence).some((record) => record.id === evidenceId && record.verdict === 'pass' && unexpired(record, now)))
  }

  return {
    capability,
    releaseDependencies,
    checkEnabled,
    status(root: Root, needs: ReadonlyMap<number, Message>, access: Access, pauseEpoch: number): Protocol['workEvidence']['output'] {
      const state = currentEvidence(root, Date.now(), pauseEpoch)
      const releases = root.task.needs.flatMap((id) => {
        const evidenceId = root.task.releases?.[id]
        const need = needs.get(id)
        return evidenceId !== undefined && need && access.readable(need.channel) ? [{ needId: ref(id), evidenceId }] : []
      })
      return { required: [...required], submission: state?.submission ?? null, evidence: Object.values(state?.evidence ?? {}), overrides: Object.values(state?.overrides ?? {}), releases }
    },
    submit(root: Root, identity: Identity, { commit, artifactRef }: Protocol['submitWork']['input']): Events {
      heldBy(root, identity)
      if (root.task.evidence?.submission.round === root.task.epoch) throw conflict('already_submitted', 'this claim already submitted work; a new claim starts a new round')
      return [{ type: 'task.work_submitted', payload: { id: root.id, thread: root.thread, by: identity.author, round: root.task.epoch, revision: root.revision ?? root.id, commit, artifactRef } }]
    },
    record(root: Root, identity: Identity, { commit, round, gate, verdict, artifactRef, expiresAt }: Protocol['recordEvidence']['input'], pauseEpoch: number): Events {
      role(identity, root.channel, 'post', attesters.get(gate))
      const now = Date.now()
      const state = candidate(root, { commit, round }, now, pauseEpoch)
      if (gate === 'review' && state.submission.by.principal === identity.principal.id) throw forbidden('the reviewer must be a different principal from the submitter')
      future(expiresAt, now)
      return [{ type: 'task.work_evidence', payload: { id: root.id, thread: root.thread, by: identity.author, commit, round, gate, verdict, artifactRef, expiresAt: expiresAt ?? null } }]
    },
    override(root: Root, identity: Identity, { commit, round, gate, reason, expiresAt }: Protocol['overrideEvidence']['input'], pauseEpoch: number): Events {
      role(identity, root.channel, 'manage', operators)
      const now = Date.now()
      candidate(root, { commit, round }, now, pauseEpoch)
      future(expiresAt, now)
      return [{ type: 'task.work_override', payload: { id: root.id, thread: root.thread, by: identity.author, commit, round, gate, reason, expiresAt } }]
    },
    complete(root: Root, identity: Identity, commit: string | undefined, pauseEpoch: number) {
      if (!enabled && commit !== undefined) throw noWorkEvidence()
      if (!required.length && commit === undefined) return
      heldBy(root, identity)
      const now = Date.now()
      const state = currentEvidence(root, now, pauseEpoch)
      if (!state || commit === undefined) throw conflict('evidence_required', 'completion requires a current submission and its full commit ID')
      if (state.submission.commit !== commit) throw stale()
      for (const gate of required) {
        if (gate === 'submission') continue // Overrides cannot create a submission.
        const record = state.evidence[gate]
        const waiver = state.overrides[gate]
        if (!(record?.verdict === 'pass' && unexpired(record, now)) && !(waiver && unexpired(waiver, now)))
          throw conflict('evidence_required', `completion requires current passing ${gate} evidence or an override`)
      }
    },
    satisfied(task: Task, needs: ReadonlyMap<number, Message>): boolean {
      const now = Date.now()
      return task.needs.every((id) => passing(needs.get(id), task.releases?.[id], now))
    },
    resolve(root: Root, identity: Identity, { needId, evidenceId, ifVersion }: Protocol['resolveWorkEdge']['input'], needs: ReadonlyMap<number, Message>): Events {
      role(identity, root.channel, 'manage', resolvers)
      if ((root.version ?? root.id) !== ifVersion) throw conflict('stale_task', 'the task changed; read it before resolving the edge')
      const id = indexOf(needId)
      const need = id === null ? undefined : needs.get(id)
      if (!need || !identity.principal.access.readable(need.channel) || need.deleted) throw notFound('prerequisite not found', 'need_not_found')
      const now = Date.now()
      if (!passing(need, evidenceId, now)) throw conflict('invalid_evidence', 'resolution requires current passing evidence from that completed prerequisite')
      if (root.task.releases?.[need.id] === evidenceId) return []
      const about = { id: root.id, thread: root.thread }
      const events: Events = [{ type: 'task.work_resolved', payload: { ...about, needId: need.id, evidenceId, by: identity.author } }]
      if (root.task.state === 'waiting' && root.task.needs.every((needed) => passing(needs.get(needed), needed === need.id ? evidenceId : root.task.releases?.[needed], now)))
        events.push({ type: 'task.ready', payload: about })
      return events
    },
  }
}
