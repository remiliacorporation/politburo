import { useLayoutEffect, useState } from 'react'
import { appearance, themeFor, type Appearance as Preferences } from '../store.ts'

const KEY = 'board.appearance'

export function useAppearance() {
  const [preferences, setPreferences] = useState(() => {
    try { return appearance(JSON.parse(localStorage.getItem(KEY) ?? 'null')) }
    catch { return appearance(null) }
  })
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const root = document.documentElement
    const apply = () => { root.dataset.theme = themeFor(preferences.theme, media.matches) }
    apply()
    root.dataset.density = preferences.density
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preferences])
  return {
    preferences,
    change(next: Preferences) {
      setPreferences(next)
      try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {}
    },
  }
}

export function Appearance({ preferences, change }: ReturnType<typeof useAppearance>) {
  return (
    <div className="appearance">
      <label>
        Theme
        <select value={preferences.theme} onChange={(event) => change(appearance({ ...preferences, theme: event.target.value }))}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label>
        Density
        <select value={preferences.density} onChange={(event) => change(appearance({ ...preferences, density: event.target.value }))}>
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </label>
    </div>
  )
}
