import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { iconFor, itemNames, itemOfSprite, speciesNames, speciesOfMob } from '../src/inspect/app/icons.ts'

type Pools = {
  names: {
    mob_species: {
      passive: Record<string, string[]>
      neutral: Record<string, string[]>
      hostile: Record<string, string[]>
      boss: string[]
    }
    sprite_items: Record<string, string[]>
  }
}

const config = JSON.parse(readFileSync(new URL('../../swarm/src/config/defaults.json', import.meta.url), 'utf8')) as Pools
const species = [
  ...Object.values(config.names.mob_species.passive).flat(),
  ...Object.values(config.names.mob_species.neutral).flat(),
  ...Object.values(config.names.mob_species.hostile).flat(),
  ...config.names.mob_species.boss,
]
const items = Object.values(config.names.sprite_items).flat()

function rects(svg: string): number {
  return svg.match(/<rect /g)?.length ?? 0
}

it('draws every default species and item, and nothing else', () => {
  expect([...speciesNames()].sort()).toEqual([...species].sort())
  expect([...itemNames()].sort()).toEqual([...items].sort())
  const fallback = iconFor('not-a-name')
  const seen = new Set<string>()
  for (const name of [...species, ...items]) {
    const icon = iconFor(name)
    expect(icon, name).not.toBe(fallback)
    expect(seen.has(icon), name).toBe(false)
    seen.add(icon)
  }
})

it('parses a mob id to its species and a sprite id to its item', () => {
  expect(speciesOfMob('317-CAT')).toBe('CAT')
  expect(speciesOfMob('21-BEE2')).toBe('BEE')
  expect(speciesOfMob('21-BEE')).toBe('BEE')
  expect(speciesOfMob('8-PIG')).toBe('PIG')
  expect(speciesOfMob('8-PIG2')).toBe('PIG')
  expect(speciesOfMob('8-PIGLIN')).toBe('PIGLIN')
  expect(speciesOfMob('8-PIGLIN2')).toBe('PIGLIN')
  expect(speciesOfMob('8-PIGMAN')).toBe('PIGMAN')
  expect(speciesOfMob('8-PIGMAN10')).toBe('PIGMAN')
  expect(speciesOfMob('12-HORSE10')).toBe('HORSE')
  for (const name of species) {
    expect(speciesOfMob(`317-${name}`), name).toBe(name)
    expect(speciesOfMob(`21-${name}2`), name).toBe(name)
  }
  expect(speciesOfMob('21-BEE1')).toBeNull()
  expect(speciesOfMob('21-BEE0')).toBeNull()
  expect(speciesOfMob('317-NOPE')).toBeNull()
  expect(speciesOfMob('317-CATX')).toBeNull()
  expect(speciesOfMob('CAT')).toBeNull()
  expect(speciesOfMob('01-CAT')).toBeNull()
  expect(speciesOfMob('21-bee2')).toBeNull()

  expect(itemOfSprite('317-CAT.PICKAXE')).toBe('PICKAXE')
  expect(itemOfSprite('21-BEE2.AXE')).toBe('AXE')
  expect(itemOfSprite('21-BEE2.AXE3')).toBe('AXE')
  expect(itemOfSprite('12-HORSE10.HOE2')).toBe('HOE')
  expect(itemOfSprite('317-CAT.PICKAXE2')).toBe('PICKAXE')
  for (const name of items) {
    expect(itemOfSprite(`317-CAT.${name}`), name).toBe(name)
    expect(itemOfSprite(`21-BEE2.${name}2`), name).toBe(name)
  }
  expect(itemOfSprite('317-CAT.NOPE')).toBeNull()
  expect(itemOfSprite('317-NOPE.PICKAXE')).toBeNull()
  expect(itemOfSprite('317-CAT.AXE1')).toBeNull()
  expect(itemOfSprite('317-CAT.PICK')).toBeNull()
  expect(itemOfSprite('PICKAXE')).toBeNull()
  expect(iconFor(speciesOfMob('21-BEE2') ?? '')).toBe(iconFor('BEE'))
  expect(iconFor('BEE2')).toBe(iconFor('not-a-name'))
})

it('keeps species heads and item tools crisp at 16 px and 64 px', () => {
  for (const size of [16, 64] as const) {
    for (const name of ['COW', 'PICKAXE', 'not-a-name']) {
      const svg = iconFor(name, size)
      expect(svg, name).toContain(`width="${size}"`)
      expect(svg, name).toContain(`height="${size}"`)
      expect(svg, name).toContain('viewBox="0 0 16 16"')
      expect(svg, name).toContain('shape-rendering="crispEdges"')
      expect(svg, name).not.toMatch(/\d\.\d/)
    }
  }
  expect(rects(iconFor('COW'))).toBeGreaterThan(64)
  expect(rects(iconFor('PICKAXE'))).toBeLessThanOrEqual(64)
  expect(rects(iconFor('not-a-name'))).toBeLessThanOrEqual(64)
})
