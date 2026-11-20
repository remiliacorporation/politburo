import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Vitest runs in Node. Stand in for the browser's delivered clicks and audio
// graph; observe the scheduled sounds rather than the pitch-selection code.
class Control {
  readonly tag: string
  textContent: string
  title = ''
  parent?: Control
  disabled = false
  attributes = new Map<string, string>()
  getAttribute = (name: string) => this.attributes.get(name) ?? null

  constructor(tag: string, text = '') {
    this.tag = tag
    this.textContent = text
  }

  matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled
    const attribute = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(selector)
    if (attribute) return attribute[2] === undefined ? this.attributes.has(attribute[1]!) : this.getAttribute(attribute[1]!) === attribute[2]
    return selector === this.tag
  }

  closest(selectors: string): Control | null {
    return selectors.split(',').some((selector) => this.matches(selector.trim())) ? this : this.parent?.closest(selectors) ?? null
  }
}

function page() {
  const target = new EventTarget()
  return {
    document: target as unknown as Document,
    click(control: Control, trusted = true) {
      const event = new Event('click', { cancelable: true })
      Object.defineProperties(event, { target: { value: control }, isTrusted: { value: trusted } })
      target.dispatchEvent(event)
    },
  }
}

const hits: { shape: string; pitch: number; start: number; end: number }[] = []
const storage = new Map<string, string>()

beforeEach(() => {
  hits.length = 0
  storage.clear()
  vi.resetModules()
  vi.stubGlobal('Element', Control)
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('AudioContext', class {
    state = 'running'
    currentTime = 1
    destination = {}
    createOscillator() {
      let start = 0
      return {
        type: 'sine', frequency: { value: 440 }, connect: (node: unknown) => node,
        start(time: number) { start = time },
        stop(end: number) { hits.push({ shape: this.type, pitch: this.frequency.value, start, end }) },
      }
    }
    createBiquadFilter() { return { frequency: { value: 0 }, connect: (node: unknown) => node } }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

const feedback = () => import('../src/inspect/app/button-feedback.ts')

describe('inspector button sounds', () => {
  it('plays two short low saw hits at the same pentatonic pitch on each activation of a button', async () => {
    const viewer = page()
    const { installButtonFeedback } = await feedback()
    installButtonFeedback(viewer.document)
    const button = new Control('button', 'Refresh')
    const icon = new Control('svg')
    icon.parent = button
    viewer.click(icon)
    viewer.click(button)
    viewer.click(new Control('button', 'Refresh')) // the control was remounted

    expect(hits).toHaveLength(6)
    const pitch = hits[0]!.pitch
    const semitones = 12 * Math.log2(pitch / (440 * 2 ** (-33 / 12))) // relative to C2
    const note = Math.round(semitones)
    expect(semitones).toBeCloseTo(note, 2)
    expect([0, 2, 4, 7, 9]).toContain(note)
    for (let i = 0; i < hits.length; i += 2) {
      const first = hits[i]!
      const second = hits[i + 1]!
      for (const hit of [first, second]) {
        expect(hit.shape).toBe('sawtooth')
        expect(hit.pitch).toBe(pitch)
        expect(hit.end - hit.start).toBeGreaterThan(0)
      }
      expect(second.start).toBeGreaterThanOrEqual(first.end)
      expect(second.end - first.start).toBeLessThan(0.15)
    }
  })

  it('stays silent on links, disabled buttons and programmatic clicks', async () => {
    const viewer = page()
    const { installButtonFeedback } = await feedback()
    installButtonFeedback(viewer.document)
    const disabled = new Control('button')
    disabled.disabled = true
    const ariaDisabled = new Control('button')
    ariaDisabled.attributes.set('aria-disabled', 'true')
    viewer.click(disabled)
    viewer.click(ariaDisabled)
    viewer.click(new Control('a'))
    viewer.click(new Control('button'), false)
    expect(hits).toHaveLength(0)
  })

  it('keeps a muted inspector silent after reload until sounds are enabled again', async () => {
    const first = page()
    const before = await feedback()
    before.installButtonFeedback(first.document)
    before.setButtonSounds(false)
    first.click(new Control('button'))
    expect(hits).toHaveLength(0)

    vi.resetModules()
    const second = page()
    const after = await feedback()
    after.installButtonFeedback(second.document)
    expect(after.buttonSoundsEnabled()).toBe(false)
    second.click(new Control('button'))
    expect(hits).toHaveLength(0)
    after.setButtonSounds(true)
    second.click(new Control('button'))
    expect(hits).toHaveLength(2)
  })
})
