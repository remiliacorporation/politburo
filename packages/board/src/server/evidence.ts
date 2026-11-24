import type { Protocol } from '../api/protocol.ts'
import type { Discovery } from '../api/routes.ts'
import { currentEvidence, unexpired, type AttestationGate, type EvidencePolicy, type Gate } from '../contract/evidence.ts'
import type { Message, Task } from '../contract/folds.ts'
import { authorize, type Access, type Permission } from './access.ts'
import { badRequest, forbidden, HttpError, noWorkEvidence, notFound } from './errors.ts'
import { indexOf, ref } from './feed.ts'
import type { Events, Identity } from './writes.ts'

const conflict = (code: string, message: string) => new HttpError(409, code, message)
const stale = () => conflict('stale_candidate', 'the commit and round must name the current submission')

type Root = Message & { task: Task }
export type UnreadableEdge = 'missing' | 'skip'

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

  function passing(need: Message | undefined, evidenceId: string | undefined, now: number): boolean {
    if (!need || need.task?.state !== 'completed' || evidenceId === undefined) return false
    const state = currentEvidence(need, now)
    return state !== null && (state.submission.id === evidenceId || Object.values(state.evidence).some((record) => record.id === evidenceId && record.verdict === 'pass' && unexpired(record, now)))
  }

  function satisfied(task: Task, needs: ReadonlyMap<number, Message>, access: Access | undefined, now: number, unreadable: UnreadableEdge): boolean {
    return task.needs.every((id) => {
      const need = needs.get(id)
      // Claims fail closed. Routing skips hidden edges so it cannot reveal their verdicts.
      if (need && access && !access.readable(need.channel)) return unreadable === 'skip'
      return passing(need, task.releases?.[id], now)
    })
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
      if (root.task.evidence?.submission.round === root.task.epoch) throw conflict('already_submitted', 'this claim already submitted work; a new claim starts a new round')
      return [{ type: 'task.work_submitted', payload: { id: root.id, thread: root.thread, by: identity.author, round: root.task.epoch, revision: root.revision ?? root.id, commit, artifactRef } }]
    },
    attestation(root: Root, pauseEpoch: number, expiresAt: string | undefined, now: number) {
      return { current: currentEvidence(root, now, pauseEpoch) !== null, fresh: unexpired({ expiresAt: expiresAt ?? null }, now) }
    },
    record(root: Root, identity: Identity, { commit, round, gate, verdict, artifactRef, expiresAt }: Protocol['recordEvidence']['input'], pauseEpoch: number, now: number): Events {
      role(identity, root.channel, 'post', attesters.get(gate))
      const state = candidate(root, { commit, round }, now, pauseEpoch)
      if (gate === 'review' && state.submission.by.principal === identity.principal.id) throw forbidden('the reviewer must be a different principal from the submitter')
      future(expiresAt, now)
      return [{ type: 'task.work_evidence', payload: { id: root.id, thread: root.thread, by: identity.author, commit, round, gate, verdict, artifactRef, expiresAt: expiresAt ?? null } }]
    },
    override(root: Root, identity: Identity, { commit, round, gate, reason, expiresAt }: Protocol['overrideEvidence']['input'], pauseEpoch: number, now: number): Events {
      role(identity, root.channel, 'manage', operators)
      candidate(root, { commit, round }, now, pauseEpoch)
      future(expiresAt, now)
      return [{ type: 'task.work_override', payload: { id: root.id, thread: root.thread, by: identity.author, commit, round, gate, reason, expiresAt } }]
    },
    completion(root: Root, commit: string | undefined, pauseEpoch: number, now: number): HttpError | null {
      if (!enabled && commit !== undefined) return noWorkEvidence()
      if (!required.length && commit === undefined) return null
      const state = currentEvidence(root, now, pauseEpoch)
      if (!state || commit === undefined) return conflict('evidence_required', 'completion requires a current submission and its full commit ID')
      if (state.submission.commit !== commit) return stale()
      for (const gate of required) {
        if (gate === 'submission') continue // Overrides cannot create a submission.
        const record = state.evidence[gate]
        const waiver = state.overrides[gate]
        if (!(record?.verdict === 'pass' && unexpired(record, now)) && !(waiver && unexpired(waiver, now)))
          return conflict('evidence_required', `completion requires current passing ${gate} evidence or an override`)
      }
      return null
    },
    satisfied,
    resolve(root: Root, identity: Identity, { needId, evidenceId, ifVersion }: Protocol['resolveWorkEdge']['input'], needs: ReadonlyMap<number, Message>) {
      role(identity, root.channel, 'manage', resolvers)
      if ((root.version ?? root.id) !== ifVersion) throw conflict('stale_task', 'the task changed; read it before resolving the edge')
      const id = indexOf(needId)
      const need = id === null ? undefined : needs.get(id)
      const { access } = identity.principal
      if (!need || !access.readable(need.channel) || need.deleted) throw notFound('prerequisite not found', 'need_not_found')
      const same = root.task.releases?.[need.id] === evidenceId
      const others = { ...root.task, needs: root.task.needs.filter((id) => id !== need.id) }
      const verdict = (now: number) => ({
        named: passing(need, evidenceId, now),
        ready: !same && root.task.state === 'waiting' && satisfied(others, needs, access, now, 'skip'),
      })
      return {
        verdict,
        events({ named, ready }: ReturnType<typeof verdict>): Events {
          if (!named) throw conflict('invalid_evidence', 'resolution requires current passing evidence from that completed prerequisite')
          if (same) return []
          const about = { id: root.id, thread: root.thread }
          return [
            { type: 'task.work_resolved', payload: { ...about, needId: need.id, evidenceId, by: identity.author } },
            ...(ready ? [{ type: 'task.ready' as const, payload: about }] : []),
          ]
        },
      }
    },
  }
}
