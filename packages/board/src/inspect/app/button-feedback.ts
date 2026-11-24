const preference = 'board.button-sounds'
const majorPentatonic = [0, 2, 4, 7, 9]
const pitches = new WeakMap<Element, number>()
let enabled = true
let context: AudioContext | undefined

/** A label's semitone offset from C2, over two octaves of the major pentatonic scale. */
export function noteFor(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  const step = (hash >>> 0) % (2 * majorPentatonic.length)
  return majorPentatonic[step % majorPentatonic.length]! + 12 * Math.floor(step / majorPentatonic.length)
}

export function buttonSoundsEnabled() {
  return enabled
}

export function setButtonSounds(enabledNow: boolean) {
  enabled = enabledNow
  try { localStorage.setItem(preference, enabled ? 'on' : 'off') } catch { /* optional storage */ }
}

export function installButtonFeedback(root: HTMLElement) {
  try { enabled = localStorage.getItem(preference) !== 'off' } catch { /* optional storage */ }
  // Native click covers pointer, touch, and keyboard activation without pairing
  // pointer/key events with the click they synthesize.
  root.addEventListener('click', (event) => {
    if (!enabled || !event.isTrusted || event.defaultPrevented) return
    const button = event.target instanceof Element && event.target.closest('button')
    if (!button || !root.contains(button) || button.closest(':disabled, [aria-disabled="true"], [inert]')) return
    void thunk(pitchFor(button))
  }, { capture: true })
}

function pitchFor(button: Element): number {
  const known = pitches.get(button)
  if (known !== undefined) return known
  const key = button.getAttribute('aria-label')?.trim()
    || button.getAttribute('title')?.trim()
    || button.textContent?.trim()
    || button.getAttribute('class')?.trim()
    || ''
  const pitch = 65.406 * 2 ** (noteFor(key) / 12)
  // A toggle can change its label while keeping the same physical button.
  pitches.set(button, pitch)
  return pitch
}

async function thunk(pitch: number) {
  try {
    if (!context || context.state === 'closed') context = new AudioContext()
    const audio = context
    if (audio.state !== 'running') {
      const clickedAt = performance.now()
      await audio.resume()
      if (performance.now() - clickedAt > 150) return
    }
    if (!enabled || audio.state !== 'running') return

    const start = audio.currentTime
    hit(audio, start, pitch, 0.085, 0.046)
    hit(audio, start + 0.052, pitch, 0.049, 0.034)
  } catch {
    // Unsupported or blocked audio must not interfere with the action.
  }
}

function hit(audio: AudioContext, start: number, pitch: number, level: number, duration: number) {
  const oscillator = audio.createOscillator()
  const filter = audio.createBiquadFilter()
  const envelope = audio.createGain()
  oscillator.type = 'sawtooth'
  oscillator.frequency.value = pitch
  filter.type = 'lowpass'
  filter.frequency.value = 500
  envelope.gain.setValueAtTime(0, start)
  envelope.gain.linearRampToValueAtTime(level, start + 0.004)
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration - 0.001)
  oscillator.connect(filter).connect(envelope).connect(audio.destination)
  oscillator.onended = () => {
    oscillator.disconnect()
    filter.disconnect()
    envelope.disconnect()
  }
  oscillator.start(start)
  oscillator.stop(start + duration)
}
