import { resolve } from 'node:path'
import { adviserTimeoutMs, type Adviser, type Usage } from './adviser.ts'
import { appendAudit, readAudit, sha256, type Decision } from './audit.ts'
import { compilePacket, containsCredential, estimateTokens, parseAnswer, type Answer, type TerraCase } from './packet.ts'

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

// Share in-flight work within the service; the audit log replays completed cases.
// If the log could not be written, keep that outcome for the life of the process.
const pending = new Map<string, Promise<Result>>()
const unaudited = new Map<string, Result>()

export function createTerra({ adviser, dir, model, maxTokens, now = () => new Date() }: {
  adviser: Adviser
  dir: string
  model: string
  maxTokens?: number
  now?: () => Date
}) {
  async function evaluate(input: TerraCase, key: string): Promise<Result> {
    const { id, revision, kind } = input
    try {
      const first = readAudit(dir).find((record) => record.case_id === id && record.revision === revision)
      if (first) return result(first, true)
    } catch {
      // An audit I/O failure must not block advice or leak the filesystem error.
    }

    let packet = ''
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

    const safe = (text: string) => containsCredential(text) ? '[withheld]' : text
    try {
      appendAudit(dir, {
        at: now().toISOString(), case_id: safe(id),
        revision: typeof revision === 'string' ? safe(revision) : revision,
        kind: safe(kind), packet_sha256: sha256(packet), packet_tokens_est: estimateTokens(packet),
        packet, model: safe(model), ...decision, ...(usage ? { usage } : {}),
      })
    } catch {
      const outcome = result(decision, false)
      unaudited.set(key, outcome)
      return outcome
    }
    return result(decision, true)
  }

  return {
    async advise(input: TerraCase): Promise<Result> {
      try {
        const key = JSON.stringify([resolve(dir), input.id, input.revision])
        const previous = unaudited.get(key)
        if (previous) return structuredClone(previous)
        let work = pending.get(key)
        if (!work) {
          work = Promise.resolve().then(() => evaluate(input, key)).finally(() => pending.delete(key))
          pending.set(key, work)
        }
        return structuredClone(await work)
      } catch {
        return wake('adviser orchestration unavailable')
      }
    },
  }
}
