import { randomUUID } from 'node:crypto'
import { loadConfig } from '../config/load.ts'
import { ClassifierInvalid, validateAnswer, type Classifier } from './client.ts'
import { guardState, safeId, unsafeText, type State } from './guard.ts'
import { findQuestion, resolveChoices, type Action, type QuestionKey } from './questions.ts'
import { summarize } from './report.ts'
import { activeLatches, callHistory, openClassifierStore, type CallRecord, type Mode, type Outcome, type Reason } from './store.ts'

export type Ask = {
  question: string; urgency: 'p0' | 'p1' | 'p2' | 'p3'; state: State;
  case_ref: string; caseId?: string; candidateRepos?: readonly string[]
}
export type Decision = { action: Action; action_would: Action; reason: Reason; call_id: string | null }
type Policy = { enabled: boolean; state: Mode; prompt_version: number; threshold: number; late_p1_rate_limit: string }
const wake = (reason: Reason): Decision => ({ action: 'wake', action_would: 'wake', reason, call_id: null })

function rateLimit(text: string): [number, number] {
  if (!/^\d+\/[1-9]\d*$/.test(text)) throw new Error('invalid classifier rate limit')
  const [max, window] = text.split('/').map(Number) as [number, number]
  if (!Number.isSafeInteger(max) || !Number.isSafeInteger(window) || max > window) throw new Error('invalid classifier rate limit')
  return [max, window]
}

export function createClassifier({ classifier, dir, config, now = () => new Date(), idGen = randomUUID }: {
  classifier: Classifier; dir: string; config?: unknown; now?: () => Date; idGen?: () => string
}) {
  const policies: Record<QuestionKey, Policy> = loadConfig({ party: config }).secretary.questions
  const store = openClassifierStore(dir)
  const at = () => now().toISOString()

  function effectiveState(question: QuestionKey): Mode {
    try {
      const switches = store.readSwitches(), records = store.readCalls()
      if (activeLatches(switches).has(question)) return 'shadow'
      const clear = switches.findLast((s) => s.question === question && s.type === 'clear')
      // Older clears have no log cursor; timestamps cannot safely establish order.
      const { calls, outcomes } = callHistory(records, clear?.type === 'clear' ? clear.call_cursor ?? 0 : 0)
      const policy = policies[question], limit = policy.late_p1_rate_limit
      const [max, window] = rateLimit(limit)
      // Replay in call order. Outcome arrival order hides a breach in an earlier window.
      const history: number[] = []
      let costly = 0
      for (const call of calls) {
        if (call.question !== question || call.label === null) continue
        const outcome = outcomes.get(call.id)
        if (!outcome) continue
        const mistake = Number(outcome.costly)
        history.push(mistake)
        costly += mistake - (history[history.length - window - 1] ?? 0)
        if (costly <= max) continue
        store.appendSwitch({ type: 'breach', question, at: at(), reason: 'costly mistake limit exceeded',
          costly, classified: Math.min(history.length, window), limit })
        return 'shadow'
      }
      return policy.state
    } catch {
      // Unreadable history or a failed latch write must never permit a live action.
    }
    return 'shadow'
  }

  async function ask(q: Ask): Promise<Decision> {
    try {
      if (q.urgency === 'p0') return wake('p0')
      const definition = findQuestion(q.question)
      if (!definition || !['p1', 'p2', 'p3'].includes(q.urgency)) return wake('invalid')
      const { key, prompts } = definition
      const policy = policies[key]
      if (!policy.enabled) return wake('disabled')
      if (policy.prompt_version !== 1) return wake('invalid')
      rateLimit(policy.late_p1_rate_limit)
      const approved = guardState(q.state), caseRef = q.case_ref, caseId = q.caseId ?? caseRef
      if (!approved || !safeId(caseRef) || !safeId(caseId)) return wake('guard')
      const candidates = key === 'intake_route' ? [...(q.candidateRepos ?? [])] : []
      if (candidates.some((label) => !safeId(label) || definition.labels.includes(label))) return wake('guard')
      const { labels: choices, actions } = resolveChoices(definition, candidates)
      const id = idGen()
      if (!safeId(id)) return wake('guard')
      const record: CallRecord = {
        id, at: at(), question: key, prompt_version: 1, state: effectiveState(key),
        label: null, probability: null, action_would: 'wake', action_taken: 'wake', reason: 'unavailable', case_ref: caseRef,
      }
      try {
        const response = await classifier.classify({
          question: key, promptVersion: 1, instruction: prompts[1], state: approved, choices: [...choices], caseId,
        })
        const { label, probabilities } = validateAnswer(response, choices)
        const action = Object.hasOwn(actions, label) ? actions[label] : undefined
        if (!action || (key === 'intake_route' && action.startsWith('route:') && !q.candidateRepos?.includes(label))) {
          throw new ClassifierInvalid()
        }
        record.label = label
        record.probability = probabilities[label]!
        if (record.state === 'live') record.state = effectiveState(key)
        if (record.probability < policy.threshold) record.reason = 'below_threshold'
        else {
          record.action_would = action
          record.action_taken = record.state === 'live' ? action : 'wake'
          record.reason = record.state === 'live' ? 'classified' : 'shadow'
        }
      } catch (error) {
        record.reason = error instanceof ClassifierInvalid ? 'invalid' : 'unavailable'
      }
      store.appendCall(record)
      return { action: record.action_taken, action_would: record.action_would, reason: record.reason, call_id: id }
    } catch { return wake('unavailable') }
  }

  function outcome(callId: string, { spawner_did, costly }: Outcome): void {
    const { calls, outcomes } = callHistory(store.readCalls())
    if (outcomes.has(callId)) return
    const call = calls.find(({ id }) => id === callId)
    if (!call) throw new Error('unknown classifier call')
    if (!safeId(spawner_did) || !/^(?:wake|hold|drop|(?:route|escalate):.+)$/.test(spawner_did) || typeof costly !== 'boolean') {
      throw new Error('invalid classifier outcome')
    }
    rateLimit(policies[call.question].late_p1_rate_limit)
    store.appendCall({ call_id: callId, at: at(), spawner_did, costly })
    effectiveState(call.question)
  }

  function clear(question: string, why: string): void {
    const definition = findQuestion(question)
    if (!definition || !why.trim() || unsafeText.test(why)) throw new Error('invalid classifier clear')
    store.appendSwitch({ type: 'clear', question: definition.key, at: at(), reason: why,
      call_cursor: store.readCalls().length })
  }

  return { ask, outcome, clear, report: () => summarize(store, (key) => policies[key].state) }
}
