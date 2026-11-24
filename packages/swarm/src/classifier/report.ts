import { questions, type QuestionKey } from './questions.ts'
import { activeLatches, callHistory, type Mode, type openClassifierStore } from './store.ts'

export function summarize(store: ReturnType<typeof openClassifierStore>, configuredState: (key: QuestionKey) => Mode) {
  const { calls, outcomes } = callHistory(store.readCalls())
  const latches = activeLatches(store.readSwitches())
  return questions.map(({ id, key }) => {
    const rows = calls.filter((call) => call.question === key)
    let costly = 0, agreed = 0, compared = 0
    for (const call of rows) {
      const outcome = outcomes.get(call.id)
      if (!outcome || call.label === null) continue
      if (outcome.costly) costly++
      if (call.state === 'shadow') {
        compared++
        if (call.action_would === outcome.spawner_did) agreed++
      }
    }
    const latched = latches.has(key)
    return { id, question: key, state: latched ? 'shadow' as const : configuredState(key),
      calls: rows.length, shadow_agreement: { agreed, compared }, costly, latched }
  })
}

export function formatReport(rows: ReturnType<typeof summarize>): string {
  return rows.map(({ id, state, calls, shadow_agreement: { agreed, compared }, costly, latched }) =>
    `${id.padEnd(3)}  ${state.padEnd(6)}  ${calls} calls  ${agreed}/${compared} agree  ${costly} costly  ${latched ? 'breach latched' : 'not latched'}`,
  ).join('\n')
}
