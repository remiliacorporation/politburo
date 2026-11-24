export type Action = 'wake' | 'hold' | 'drop' | `route:${string}` | `escalate:${string}`

function define<K extends string>(
  id: `J${number}`, key: K, actions: Readonly<Record<string, Action>>,
  costlyDirection: string, costlyLabels: readonly string[], instruction: string,
) {
  return { id, key, labels: Object.keys(actions), actions, costlyDirection, costlyLabels, prompts: { 1: instruction } }
}

export const questions = [
  define('J1', 'intake_route', { ambiguous: 'wake', out_of_scope: 'wake' },
    'Wrong repo sees the text', [], 'Choose a supplied repo ID, ambiguous if unclear, or out_of_scope if none fits.'),
  define('J2', 'needs_spawner', { needs_spawner: 'wake', no_spawner: 'drop' },
    'Drop a real ask', ['no_spawner'], 'Choose needs_spawner for a real ask; otherwise no_spawner.'),
  define('J3', 'can_wait', { urgent: 'wake', can_wait: 'hold' },
    'Hold something urgent', ['can_wait'], 'Choose urgent if it needs attention before the next heartbeat; otherwise can_wait.'),
  define('J4', 'urgency_match', { raise: 'wake', match: 'wake', lower: 'hold' },
    'Lower a real p1', ['lower'], 'Compare stated urgency to the text. Choose raise, match, or lower; lower only if delay is safe.'),
  define('J5', 'report_clean', { clean: 'hold', needs_decision: 'wake' },
    'Call a blocked report clean', ['clean'], 'Choose clean for an unblocked report with links; otherwise needs_decision.'),
  define('J6', 'duplicate', { duplicate: 'drop', new_fact: 'wake' },
    'Drop a new fact', ['duplicate'], 'Choose duplicate only if already handled and nothing is new; otherwise new_fact.'),
  define('J7', 'still_relevant', { live: 'wake', stale: 'drop' },
    'Drop a live item', ['stale'], 'Given later events, choose live if still relevant or stale if superseded.'),
  define('J8', 'handler', { secretary: 'route:secretary', spawner: 'wake', terra: 'escalate:terra', core: 'escalate:core' },
    'Under-escalate', ['secretary', 'spawner', 'terra'], 'Choose who is needed: secretary, spawner, terra, or core.'),
  define('J9', 'outcomes_complete', { complete: 'route:complete', incomplete: 'wake' },
    'Pass an uncheckable ticket', ['complete'], 'Choose complete only if the outcomes are independently checkable; otherwise incomplete.'),
  define('J10', 'finding_blocks_invariant', { blocker: 'wake', minor: 'hold' },
    'Call a blocker minor', ['minor'], 'Choose blocker if the finding touches a named invariant of the brief; otherwise minor.'),
] as const

export type QuestionKey = (typeof questions)[number]['key']
export const findQuestion = (name: string) => questions.find(({ id, key }) => name === id || name === key)

export function resolveChoices(question: (typeof questions)[number], candidates: readonly string[] = []) {
  if (question.key !== 'intake_route') return question
  const costlyLabels = [...new Set(candidates)].filter((id) => !question.labels.includes(id))
  return { ...question, costlyLabels, labels: [...question.labels, ...costlyLabels], actions: {
    ...question.actions, ...Object.fromEntries(costlyLabels.map((id) => [id, `route:${id}` as const])),
  } }
}
