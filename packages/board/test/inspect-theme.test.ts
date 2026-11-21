import { describe, expect, it } from 'vitest'
import { CSS } from '../src/inspect/style.ts'

const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

function declarations(rule: RegExp): Record<string, string> {
  const body = css.match(rule)?.[1]
  if (body === undefined) throw new Error(`Missing CSS rule: ${rule}`)
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map(([, name, value]) => [name!, value!.trim()]))
}

const dark = declarations(/^\s*:root\s*\{([^{}]*)\}/)
const light = declarations(/@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)\s*\{\s*:root\s*\{([^{}]*)\}\s*\}/)
const surfaces = ['bg', 'panel', 'rail', 'chrome', 'shade', 'shade-hover', 'selected']

type RGB = [number, number, number]

function rgb(hex: string | undefined, name = 'color'): RGB {
  if (!hex || !/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected ${name} to be an opaque hex color, got ${hex}`)
  const value = Number.parseInt(hex.slice(1), 16)
  return [value >> 16, (value >> 8) & 0xff, value & 0xff]
}

const color = (theme: Record<string, string>, name: string) => rgb(theme[`--${name}`], `--${name}`)

/** WCAG relative luminance, with each sRGB channel linearized first. */
function luminance([r, g, b]: RGB): number {
  const linear = (channel: number) => {
    const s = channel / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: RGB, b: RGB): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function hue([r, g, b]: RGB): number {
  const max = Math.max(r, g, b)
  const chroma = max - Math.min(r, g, b)
  if (chroma === 0) throw new Error('An achromatic color has no hue')
  const sector = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
  return (sector * 60 + 360) % 360
}

const lightness = (channels: RGB) => (Math.max(...channels) + Math.min(...channels)) / (2 * 255)

describe.each([{ scheme: 'dark', theme: dark }, { scheme: 'light', theme: light }])('the inspector $scheme theme', ({ scheme, theme }) => {
  const checkContrast = (foreground: string, background: string, minimum: number) => {
    expect(contrast(color(theme, foreground), color(theme, background)), `--${foreground} on --${background}`).toBeGreaterThanOrEqual(minimum)
  }

  it('sets the browser color scheme', () => {
    expect(theme['color-scheme']).toBe(scheme)
  })

  it.each(['bright', 'dim', 'muted', 'faint', 'accent', 'red', 'warning'])('gives --%s text at least 4.5:1 contrast on every surface', (name) => {
    for (const surface of surfaces) checkContrast(name, surface, 4.5)
  })

  it('gives action button labels at least 4.5:1 contrast', () => {
    checkContrast('label', 'action', 4.5)
  })

  it.each(['gold', 'focus'])('gives --%s indicators at least 3:1 contrast on every surface', (name) => {
    for (const surface of surfaces) checkContrast(name, surface, 3)
  })

  it.each([
    ['red', 'warning', 15],
    ['red', 'accent', 15],
    ['warning', 'accent', 15],
  ] as const)('keeps --%s and --%s hues at least %s degrees apart', (first, second, minimum) => {
    const gap = Math.abs(hue(color(theme, first)) - hue(color(theme, second)))
    expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(minimum)
  })
})

it.each(['bg', 'chrome'])('keeps the default --%s a dark maroon', (name) => {
  const channels = color(dark, name)
  const [r, g, b] = channels
  expect(r - Math.max(g, b)).toBeGreaterThanOrEqual(0x1a)
  expect(lightness(channels)).toBeGreaterThanOrEqual(lightness(rgb('#2a0a10')))
  expect(lightness(channels)).toBeLessThanOrEqual(lightness(rgb('#4a1018')))
})

it('gives the default theme a gold accent, not pink', () => {
  const [r, g, b] = color(dark, 'accent')
  expect(r).toBeGreaterThan(g)
  expect(g).toBeGreaterThan(b)
  expect(b).toBeLessThan(0x9a)
})

it('gives the light theme a warm cream background', () => {
  const [r, g, b] = color(light, 'bg')
  expect(r).toBeGreaterThanOrEqual(g)
  expect(g).toBeGreaterThanOrEqual(b)
  expect(g).toBeGreaterThan(0xe0)
  expect(b).toBeGreaterThanOrEqual(0xd0)
})

it('keeps the home emblem image transparent', () => {
  const emblem = declarations(/^\s*\.home-emblem\s+img\s*\{([^{}]*)\}/m)
  expect(Object.keys(emblem).filter((property) => /^background(?:-|$)/i.test(property))).toEqual([])
})
