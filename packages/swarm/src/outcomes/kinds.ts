function pathKind(...required_sections: string[]) {
  return Object.freeze({ evidence: 'path' as const, required_sections: Object.freeze(required_sections) })
}

export const OUTCOME_KINDS = Object.freeze({
  report: pathKind(),
  research: pathKind('scope', 'sources', 'findings'),
  ops: pathKind('operation', 'verification'),
})

export type OutcomeKind = keyof typeof OUTCOME_KINDS

export function isOutcomeKind(value: unknown): value is OutcomeKind {
  return typeof value === 'string' && Object.hasOwn(OUTCOME_KINDS, value)
}
