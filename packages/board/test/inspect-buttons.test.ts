// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteFor } from '../src/inspect/app/button-feedback.ts'
import { CSS } from '../src/inspect/style.ts'

const labels = ['send', 'cancel', 'complete', 'claim', 'release', 'settings', 'post as this']

describe('button notes', () => {
  it('gives the same label the same note between other button presses', () => {
    const notes = labels.map(noteFor)
    expect([...labels].reverse().map(noteFor).reverse()).toEqual(notes)
  })

  it('chooses only pentatonic semitones within two octaves of C2', () => {
    const allowed = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]
    for (const label of labels) expect(allowed).toContain(noteFor(label))
  })

  it('does not give all the buttons the same note', () => {
    expect(new Set(labels.map(noteFor)).size).toBeGreaterThan(1)
  })
})

// A small cascade for the stylesheet's button selectors: plain compounds, descendants,
// children, and :is/:not/:where lists. No DOM or CSS dependencies in the node test.
const list = (text: string) => (text.match(/(?:\([^()]*\)|\[[^\]]*\]|[^,([])+/g) ?? []).map((s) => s.trim())
const parts = (text: string): string[] => text.match(/(?:\([^()]*\)|\[[^\]]*\]|[^\s>+~([])+|[>+~]/g) ?? []
const tokens = (text: string) => text.match(/:[\w-]+\([^()]*\)|\[[^\]]*\]|[.#:]?[\w-]+|\*/g) ?? []
const normalize = (term: string) => term.replace(/["']/g, '').replace(/\s*=\s*/g, '=')
type Selector = { weight: number; matches: (path: string[]) => boolean }

function compound(text: string): Selector {
  const terms = tokens(text)
  if (terms.join('') !== text) return { weight: 0, matches: () => false }
  const tests = terms.map((term): Selector => {
    const group = /^:(is|not|where)\((.*)\)$/.exec(term)
    if (group) {
      const branches = list(group[2]!).map(selector)
      return {
        weight: group[1] === 'where' ? 0 : Math.max(...branches.map((b) => b.weight)),
        matches: (path) => branches.some((b) => b.matches(path)) !== (group[1] === 'not'),
      }
    }
    const normalized = normalize(term)
    return {
      weight: term === '*' ? 0 : term.startsWith('#') ? 10000 : '.:['.includes(term[0]!) ? 100 : 1,
      matches: (path) => term === '*' || tokens(path.at(-1) ?? '').map(normalize).some((have) =>
        have === normalized || (normalized.startsWith('[') && have.split('=')[0] + ']' === normalized),
      ),
    }
  })
  return { weight: tests.reduce((sum, test) => sum + test.weight, 0), matches: (path) => tests.every((t) => t.matches(path)) }
}

function selector(text: string): Selector {
  const chain = parts(text)
  if (chain.includes('+') || chain.includes('~')) return { weight: 0, matches: () => false }
  const tests = chain.map(compound)
  const matches = (path: string[], at = tests.length - 1): boolean => {
    if (!path.length || !tests[at]?.matches(path)) return false
    if (at === 0) return true
    const parents = path.slice(0, -1)
    if (chain[at - 1] === '>') return matches(parents, at - 2)
    return parents.some((_, i) => matches(parents.slice(0, i + 1), at - 1))
  }
  return { weight: tests.reduce((sum, test) => sum + test.weight, 0), matches }
}

function rules(css: string) {
  const stack: string[] = []
  const out: { match: Selector; conditions: string[]; declarations: Map<string, string> }[] = []
  for (const [, head, body, group] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}|([^{}]+)\{|}/g)) {
    if (head && body !== undefined) {
      const declarations = new Map<string, string>()
      for (const [, name, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) declarations.set(name!, value!.trim())
      for (const one of list(head)) out.push({ match: selector(one), conditions: [...stack], declarations })
    } else if (group) stack.push(group.trim())
    else stack.pop()
  }
  return out
}

const stylesheet = rules(CSS)
const root = 'html:root'
function styleOf(target: string, dark = false, reduce = false) {
  const active = ['@media (hover: hover)', '@media (min-width: 64rem)']
  if (dark) active.push('@media (prefers-color-scheme: dark)')
  if (reduce) active.push('@media (prefers-reduced-motion: reduce)')
  const cascade = (path: string[]) => {
    const values = new Map<string, { value: string; important: boolean }>()
    const matched = stylesheet.filter((r) => r.conditions.every((m) => active.includes(m)) && r.match.matches(path))
    // Stable sort keeps source order for ties.
    for (const { declarations } of matched.sort((a, b) => a.match.weight - b.match.weight)) {
      for (const [name, raw] of declarations) {
        const value = raw.replace(/\s*!important$/, '')
        const important = value !== raw
        if (important || !values.get(name)?.important) values.set(name, { value, important })
      }
    }
    return values
  }
  const defaults = cascade([root])
  const values = cascade([root, ...parts(target)])
  const lookup = (name: string): string | undefined => (values.get(name) ?? defaults.get(name))?.value
    .replace(/var\((--[\w-]+)\)/g, (_, name: string) => lookup(name) ?? '')
  return lookup
}

const controls = [
  'button.send', 'button.act', 'button.act.primary', 'button.act.danger', 'button.tool',
  'header.header button.tool', 'span.tab-actions button', 'span.tab-actions button.act', 'div.home-view button',
]
const pressed = [':hover:active', ":hover[aria-pressed='true']"]
const insetEdges = (shadow = '') => ['1px', '-1px'].map((px) => {
  const edge = new RegExp(`^inset\\s+${px}\\s+${px}\\s+(.+)$`)
  return list(shadow).map((part) => edge.exec(part)?.[1]).find(Boolean)
})

describe('inspector button styles', () => {
  it.each(controls)('reverses both inset edges and moves %s down and right when pressed', (control) => {
    for (const dark of [false, true]) {
      const raised = insetEdges(styleOf(control, dark)('box-shadow'))
      expect(raised.every(Boolean)).toBe(true)
      expect(raised[0]).not.toBe(raised[1])
      for (const state of pressed) {
        const style = styleOf(control + state, dark)
        expect(insetEdges(style('box-shadow')), state).toEqual([...raised].reverse())
        expect(style('transform')).toMatch(/^translate\(\s*1px,\s*1px\s*\)$/)
        expect(style('transition')).toBe('none')
      }
    }
  })

  it('keeps the pressed bevel but disables movement and animation in reduced motion', () => {
    for (const control of [...controls, 'button']) {
      for (const state of pressed) {
        const target = control + state
        const style = styleOf(target, false, true)
        expect(style('transform') ?? 'none', target).toBe('none')
        expect(style('transition'), target).toBe('none')
        expect(style('animation'), target).toBe('none')
        expect(style('box-shadow'), target).toBe(styleOf(target)('box-shadow'))
      }
    }
  })

  it('keeps the default cursor and does not smooth-scroll', () => {
    for (const control of [...controls, 'button']) {
      for (const state of ['', ...pressed]) expect(styleOf(control + state)('cursor'), control + state).toBe('default')
    }
    expect(stylesheet.map((rule) => rule.declarations.get('scroll-behavior')?.replace(/\s*!important$/, ''))).not.toContain('smooth')
  })
})

class FakeButton {
  textContent: string
  private readonly attrs: Record<string, string>
  constructor(text: string, attrs: Record<string, string> = {}) {
    this.textContent = text
    this.attrs = attrs
  }
  getAttribute(name: string) { return this.attrs[name] ?? null }
  closest(selector: string) { return selector === 'button' ? this : null }
}

async function install(storage = new Map<string, string>()) {
  const starts: { type: OscillatorType; frequency: number; time: number }[] = []
  const ends: number[] = []
  const levels: number[] = []
  class FakeNode {
    connect<T>(next: T) { return next }
    disconnect() {}
  }
  class FakeOscillator extends FakeNode {
    type: OscillatorType = 'sine'
    frequency = { value: 0 }
    start(time: number) { starts.push({ type: this.type, frequency: this.frequency.value, time }) }
    stop(time: number) { ends.push(time) }
  }
  class FakeAudioContext {
    state = 'running'
    currentTime = 1
    destination = new FakeNode()
    createOscillator() { return new FakeOscillator() }
    createBiquadFilter() { return Object.assign(new FakeNode(), { frequency: { value: 0 } }) }
    createGain() {
      return Object.assign(new FakeNode(), { gain: {
        setValueAtTime() {},
        linearRampToValueAtTime(level: number) { levels.push(level) },
        exponentialRampToValueAtTime() {},
      } })
    }
  }
  vi.stubGlobal('Element', FakeButton)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('matchMedia', () => ({ matches: true })) // even with reduced motion, sound is a separate preference
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  })
  type Click = { target: FakeButton; isTrusted: boolean; defaultPrevented: boolean }
  let listener: (event: Click) => void
  const root = {
    addEventListener(type: string, onClick: typeof listener) { if (type === 'click') listener = onClick },
    contains: (button: FakeButton) => button instanceof FakeButton,
  }
  vi.resetModules() // a fresh document, sharing only the stored preference
  const feedback = await import('../src/inspect/app/button-feedback.ts')
  feedback.installButtonFeedback(root as unknown as HTMLElement)
  return {
    ...feedback, starts, ends, levels,
    click: (target: FakeButton) => listener({ target, isTrusted: true, defaultPrevented: false }),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('inspector button sounds', () => {
  it('plays two sawtooth hits at one frequency, the second later, shorter, and quieter', async () => {
    const audio = await install()
    audio.click(new FakeButton('send'))
    expect(audio.starts.map((hit) => hit.type)).toEqual(['sawtooth', 'sawtooth'])
    const [first, second] = audio.starts
    expect(first!.frequency).toBeGreaterThan(0)
    expect(second!.frequency).toBe(first!.frequency)
    expect(second!.time).toBeGreaterThan(first!.time)
    expect(audio.ends[1]! - second!.time).toBeLessThan(audio.ends[0]! - first!.time)
    expect(audio.levels[1]).toBeLessThan(audio.levels[0]!)
  })

  it('returns to a button’s note even after another click and a label change', async () => {
    const audio = await install()
    const send = new FakeButton('send')
    audio.click(send)
    audio.click(new FakeButton('', { 'aria-label': 'cancel' }))
    send.textContent = 'cancel'
    audio.click(send)
    const frequencies = audio.starts.map((hit) => hit.frequency)
    expect(frequencies).toHaveLength(6)
    expect(frequencies[2]).not.toBe(frequencies[0])
    expect(frequencies.slice(4)).toEqual(frequencies.slice(0, 2))
  })

  it('mutes immediately and stays silent after reinstalling in a fresh document', async () => {
    const storage = new Map<string, string>()
    const audio = await install(storage)
    audio.setButtonSounds(false)
    expect(storage.get('board.button-sounds')).toBe('off')
    audio.click(new FakeButton('send'))
    expect(audio.starts).toHaveLength(0)

    const reopened = await install(storage)
    reopened.click(new FakeButton('send'))
    expect(reopened.starts).toHaveLength(0)
    expect(reopened.buttonSoundsEnabled()).toBe(false)
  })
})
