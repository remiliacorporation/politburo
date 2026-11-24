import { resolve } from 'node:path'
import { adviserTimeoutMs, type Adviser, type Usage } from './adviser.ts'
import { appendAudit, readAudit, sha256, type AuditDecision, type Decision } from './audit.ts'
import { compilePacket, containsCredential, estimateTokens, parseAnswer, validateAnswer, type Answer, type TerraCase } from './packet.ts'

export { piAdviser, stubAdviser, type Adviser, type Usage } from './adviser.ts'
export { readAudit, type AuditRecord } from './audit.ts'
export { compilePacket, estimateTokens, parseAnswer, type Answer, type TerraCase } from './packet.ts'

const eligibleKinds = new Set(['conflicting_handoffs', 'brief_invariant_dispute', 'check_retire_exception'])

export type Result =
  | { status: 'answered'; answer: Answer; audited: true }
  | { status: 'answered'; answer: Answer; audited: false; reason: string }
  | { status: 'wake_spawner'; reason: string }

function result(decision: Decision, audited: boolean): Result {
  if (decision.outcome !== 'answered') {
    return wake(audited ? decision.reason : `${decision.reason}; audit write failed`)
  }
  return audited
    ? { status: 'answered', answer: decision.answer, audited: true }
    : { status: 'answered', answer: decision.answer, audited: false, reason: 'audit write failed' }
}

function wake(reason: string): Result {
  return { status: 'wake_spawner', reason }
}

async function ask(adviser: Adviser, packet: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('adviser timed out')), adviserTimeoutMs)
    })
    return await Promise.race([adviser.advise(packet), deadline])
  } finally {
    clearTimeout(timer)
  }
}

function reportedUsage(usage: Usage | undefined): Usage | undefined {
  const counts: Usage = {}
  for (const field of ['input', 'output'] as const) {
    const count = usage?.[field]
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) counts[field] = count
  }
  return Object.keys(counts).length ? counts : undefined
}

// Share in-flight work across handles to the same audit log in this process.
const pending = new Map<string, Promise<Result>>()

export function createTerra({ adviser, dir, model, maxTokens, now = () => new Date() }: {
  adviser: Adviser
  dir: string
  model: string
  maxTokens?: number
  now?: () => Date
}) {
  async function evaluate(input: TerraCase): Promise<Result> {
    const { id, revision, kind } = input
    try {
      const last = readAudit(dir).findLast((record) => record.case_id === id && record.revision === revision)
      if (last?.outcome === 'pending') return wake('uncertain_previous_call')
      if (last?.outcome === 'answered' && !validateAnswer(last.answer)) return wake('corrupt_audit')
      if (last) return result(last, true)
    } catch {
      return wake('corrupt_audit')
    }

    let packet = ''
    const safe = (text: string) => containsCredential(text) ? '[withheld]' : text
    const write = (decision: AuditDecision, usage?: Usage) => appendAudit(dir, {
      at: now().toISOString(), case_id: safe(id),
      revision: typeof revision === 'string' ? safe(revision) : revision,
      kind: safe(kind), packet_sha256: sha256(packet), packet_tokens_est: estimateTokens(packet),
      packet, model: safe(model), ...decision, ...(usage ? { usage } : {}),
    })
    let decision: Decision = { outcome: 'refused', reason: 'case kind is not an eligible semantic exception' }
    let usage: Usage | undefined
    if (eligibleKinds.has(kind)) {
      try {
        packet = compilePacket(input, maxTokens)
      } catch {
        decision = { outcome: 'refused', reason: 'case packet could not fit the size cap or failed content screening' }
      }
      if (packet) {
        try {
          write({ outcome: 'pending', reason: null })
        } catch {
          return wake('audit write failed')
        }
        try {
          const reply = await ask(adviser, packet)
          usage = reportedUsage(reply.usage)
          const answer = parseAnswer(reply.text)
          decision = answer
            ? { outcome: 'answered', reason: null, answer }
            : { outcome: 'invalid', reason: 'invalid adviser answer' }
        } catch {
          decision = { outcome: 'unavailable', reason: 'adviser unavailable or timed out' }
        }
      }
    }

    try {
      write(decision, usage)
    } catch {
      return result(decision, false)
    }
    return result(decision, true)
  }

  return {
    async advise(input: TerraCase): Promise<Result> {
      try {
        const key = JSON.stringify([resolve(dir), input.id, input.revision])
        let work = pending.get(key)
        if (!work) {
          work = Promise.resolve().then(() => evaluate(input)).finally(() => pending.delete(key))
          pending.set(key, work)
        }
        return structuredClone(await work)
      } catch {
        return wake('adviser orchestration unavailable')
      }
    },
  }
}
