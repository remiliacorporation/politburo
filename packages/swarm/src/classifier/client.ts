import { guardState, plainObject, safeId, unsafeText, type State } from './guard.ts'

export type ClassifierInput = {
  question: string; promptVersion: number; instruction: string; choices: string[]; state: State; caseId?: string
}
export type Answer = { label: string; probabilities: Record<string, number>; snapshot?: string }
export interface Classifier {
  classify(input: ClassifierInput): Promise<Answer>
}

export class ClassifierUnavailable extends Error { override name = 'ClassifierUnavailable' }
export class ClassifierInvalid extends Error { override name = 'ClassifierInvalid' }

export function validateAnswer(raw: unknown, choices: readonly string[]): Answer {
  if (!plainObject(raw) || typeof raw.label !== 'string' || !choices.includes(raw.label) ||
      !plainObject(raw.probabilities) || Object.keys(raw.probabilities).length !== choices.length ||
      (raw.snapshot !== undefined && typeof raw.snapshot !== 'string')) throw new ClassifierInvalid()
  const entries = choices.map((choice): [string, number] => {
    const p = Object.getOwnPropertyDescriptor(raw.probabilities, choice)?.value
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new ClassifierInvalid()
    return [choice, p]
  })
  const sum = entries.reduce((acc, [, p]) => acc + p, 0)
  if (sum < 0.99 || sum > 1.01) throw new ClassifierInvalid()
  return { label: raw.label, probabilities: Object.fromEntries(entries),
    ...(raw.snapshot === undefined ? {} : { snapshot: raw.snapshot }) }
}

export function fakeClassifier(recorded: Record<string, Answer | Record<string, Answer>>): Classifier {
  return { async classify({ question, caseId }) {
    const fixture = Object.hasOwn(recorded, question) ? recorded[question] : undefined
    if (fixture && typeof fixture.label === 'string') return structuredClone(fixture as Answer)
    if (fixture && caseId !== undefined && Object.hasOwn(fixture, caseId)) {
      return structuredClone((fixture as Record<string, Answer>)[caseId]!)
    }
    throw new ClassifierUnavailable('no recording')
  } }
}

export function typesafeClassifier(options: {
  fetch?: typeof fetch; baseUrl?: string; env?: Readonly<{ TYPESAFE_API_KEY?: string }>
} = {}): Classifier {
  return { async classify({ question, instruction, choices, state }) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const key = (options.env ?? process.env).TYPESAFE_API_KEY
      if (!key) throw new ClassifierUnavailable('no key')
      // The TypeSafe base URL and wire shape are unverified. Require an explicit endpoint origin.
      if (!options.baseUrl) throw new ClassifierUnavailable()
      const url = new URL('/v1/systemone', options.baseUrl)
      if (url.protocol !== 'https:' || url.username || url.password) throw new ClassifierUnavailable()
      const approved = guardState(state)
      if (!approved || !safeId(question) || unsafeText.test(instruction) || choices.length === 0 ||
          [...choices].some((choice) => !safeId(choice)) || new Set(choices).size !== choices.length) {
        throw new ClassifierInvalid()
      }
      const allowed = [...choices]
      const controller = new AbortController()
      const request = async () => {
        const response = await (options.fetch ?? fetch)(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'jev-1.14.0', state: approved, questions: [{
            type: 'choice', instructions: instruction, criteria: Object.fromEntries(allowed.map((label) => [label, label])),
          }] }),
        })
        if (!response.ok) throw new ClassifierUnavailable()
        const raw: unknown = await response.json().catch(() => { throw new ClassifierInvalid() })
        if (!plainObject(raw)) throw new ClassifierInvalid()
        return validateAnswer({ label: raw.choice, probabilities: raw.probabilities, snapshot: raw.snapshot }, allowed)
      }
      return await Promise.race([request(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new ClassifierUnavailable()); controller.abort() }, 10_000)
      })])
    } catch (error) {
      if (error instanceof ClassifierInvalid) throw new ClassifierInvalid('invalid answer or input')
      throw new ClassifierUnavailable(error instanceof ClassifierUnavailable && error.message === 'no key' ? 'no key' : 'request unavailable')
    } finally {
      clearTimeout(timer)
    }
  } }
}
