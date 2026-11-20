const preference = 'board.button-sounds'
const majorPentatonic = [0, 2, 4, 7, 9]
let enabled = true
let context: AudioContext | undefined
const pitches = new WeakMap<HTMLButtonElement, number>()

export function buttonSoundsEnabled() {
  return enabled
}

export function setButtonSounds(enabledNow: boolean) {
  enabled = enabledNow
  try { localStorage.setItem(preference, enabled ? 'on' : 'off') } catch { /* optional storage */ }
}

export function installButtonFeedback(page: Document) {
  try { enabled = localStorage.getItem(preference) !== 'off' } catch { /* optional storage */ }
  // A trusted click covers pointer, touch and keyboard without playing on both
  // press and activation. Listen on the document to include portaled buttons.
  page.addEventListener('click', (event) => {
    if (!enabled || !event.isTrusted || event.defaultPrevented) return
    const button = event.target instanceof Element && event.target.closest('button')
    if (!button || button.matches(':disabled') || button.closest('[aria-disabled="true"], [inert]')) return
    void thunk(pitchOf(button))
  }, { capture: true })
}

function pitchOf(button: HTMLButtonElement): number {
  const cached = pitches.get(button)
  if (cached !== undefined) return cached
  // Same label, same note after a remount. Keep the note for the life of a
  // button even when it changes its caption (e.g. while a write is pending).
  const label = button.getAttribute('aria-label') || button.title || button.textContent || ''
  let hash = 2166136261
  for (const char of label.trim().replace(/\s+/g, ' ')) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  const note = majorPentatonic[(hash >>> 0) % majorPentatonic.length]!
  const pitch = 65.406 * 2 ** (note / 12) // C2, percussive rather than bright
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
    hit(audio, start, pitch, 0.085)
    hit(audio, start + 0.052, pitch, 0.049)
  } catch {
    // Unsupported or blocked audio must not interfere with the action.
  }
}

function hit(audio: AudioContext, start: number, pitch: number, level: number) {
  const oscillator = audio.createOscillator()
  const filter = audio.createBiquadFilter()
  const envelope = audio.createGain()
  oscillator.type = 'sawtooth'
  oscillator.frequency.value = pitch
  filter.type = 'lowpass'
  filter.frequency.value = 500
  envelope.gain.setValueAtTime(0, start)
  envelope.gain.linearRampToValueAtTime(level, start + 0.004)
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.045)
  oscillator.connect(filter).connect(envelope).connect(audio.destination)
  oscillator.onended = () => {
    oscillator.disconnect()
    filter.disconnect()
    envelope.disconnect()
  }
  oscillator.start(start)
  oscillator.stop(start + 0.046)
}
