import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { actorIcon, iconFor, itemNames, itemOfSprite, paintIcon, paintedIcon, speciesNames, speciesOfMob } from '../src/inspect/app/icons.ts'
import { itemTextures, speciesTextures } from '../src/inspect/app/texture-faces.ts'

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
  expect(speciesOfMob('21-bee2')).toBe('BEE')

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

it('reads a mob or sprite id in any case, including the tail of an actor id', () => {
  for (const id of ['311-bee', '311-BEE', 'team:user:311-bee', 'vercel:user:311-BEE']) {
    expect(speciesOfMob(id), id).toBe('BEE')
  }
  for (const id of ['311-bee.pickaxe', '311-BEE.PICKAXE', 'team:user:311-bee.pickaxe']) {
    expect(itemOfSprite(id), id).toBe('PICKAXE')
    expect(speciesOfMob(id), id).toBeNull()
  }
  expect(speciesOfMob('rival-bee')).toBeNull()
  expect(speciesOfMob('team:user:rival-bee')).toBeNull()
  expect(speciesOfMob('BEE')).toBeNull()
  expect(speciesOfMob('team:user:311-nope')).toBeNull()
  expect(itemOfSprite('team:user:311-bee.nope')).toBeNull()
  expect(itemOfSprite('rival-bee.pickaxe')).toBeNull()
  const written = 'team:user:311-bee'
  const mark = actorIcon(written)
  expect(mark?.label).toBe('BEE')
  expect(mark?.svg).toBe(iconFor('BEE', 16))
  expect(actorIcon('team:user:311-bee.pickaxe')?.label).toBe('PICKAXE')
  expect(actorIcon('rival-bee')).toBeNull()
  expect(actorIcon(`${written} via julian`)?.label).toBe('BEE')
})

const STEEL = '#c5ccd4'
const WOOD = '#5c3a22'

function flatCells(svg: string, fill: string): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = []
  for (const rect of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="2" height="2" fill="(#[0-9a-f]{6})"\/>/g)) {
    if (rect[3] !== fill) continue
    cells.push({ x: Number(rect[1]) / 2, y: Number(rect[2]) / 2 })
  }
  return cells
}

it('draws SPAWNER as its own cube, crisp at 16 px and 64 px', () => {
  const fallback = iconFor('not-a-name')
  const icon = iconFor('SPAWNER')
  expect(icon).not.toBe(fallback)
  expect(rects(icon)).toBeGreaterThan(64)
  expect(speciesNames()).not.toContain('SPAWNER')
  expect(itemNames()).not.toContain('SPAWNER')
  for (const size of [16, 64] as const) {
    const svg = iconFor('SPAWNER', size)
    expect(svg).toContain(`width="${size}"`)
    expect(svg).toContain(`height="${size}"`)
    expect(svg).toContain('viewBox="0 0 16 16"')
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg).not.toMatch(/\d\.\d/)
  }
})

it('draws the pickaxe head on both sides of the handle', () => {
  const steel = flatCells(iconFor('PICKAXE'), STEEL)
  const wood = flatCells(iconFor('PICKAXE'), WOOD)
  const top = Math.min(...wood.map((cell) => cell.y))
  const handle = wood.filter((cell) => cell.y === top)
  const left = Math.min(...handle.map((cell) => cell.x))
  const right = Math.max(...handle.map((cell) => cell.x))
  const center = (left + right) / 2
  const onLeft = steel.filter((cell) => cell.x < center).length
  const onRight = steel.filter((cell) => cell.x > center).length
  expect(steel.some((cell) => cell.x < left)).toBe(true)
  expect(steel.some((cell) => cell.x > right)).toBe(true)
  expect(onLeft).toBeGreaterThan(0)
  expect(onRight).toBeGreaterThan(0)
  expect(Math.abs(onLeft - onRight)).toBeLessThanOrEqual(1)
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

it('names a texture for every default species and item', () => {
  expect(Object.keys(speciesTextures).sort()).toEqual([...speciesNames()].sort())
  expect(Object.keys(itemTextures).sort()).toEqual([...itemNames()].sort())
})

it('crops the side of the head and keeps the original art when the file is not a texture', async () => {
  const face = speciesTextures.COW!
  const width = face.x + face.w + 1
  const height = face.y + face.h
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4 + 2] = 255
    rgba[i * 4 + 3] = 255
  }
  for (let y = 0; y < face.h; y++) {
    for (let x = 0; x < face.w; x++) {
      const at = ((face.y + y) * width + face.x + x) * 4
      rgba[at] = 255
      rgba[at + 1] = 0
      rgba[at + 2] = 0
      rgba[at + 3] = 255
    }
    const beside = ((face.y + y) * width + face.x + face.w) * 4
    rgba[beside] = 0
    rgba[beside + 1] = 255
    rgba[beside + 2] = 0
    rgba[beside + 3] = 255
  }
  const painted = await paintIcon('COW', rgbaPng(width, height, rgba), 8)
  expect(painted).not.toBeNull()
  expect(painted).toContain('fill="#ff0000"')
  expect(painted).not.toContain('#0000ff')
  expect(painted).not.toContain('#00ff00')
  expect(painted).not.toBe(iconFor('COW', 8))
  expect(await paintIcon('COW', new Uint8Array([1, 2, 3]), 16)).toBeNull()
  expect(await paintIcon('COW', rgbaPng(2, 2, new Uint8Array(16).fill(255)), 16)).toBeNull()
  expect(await paintedIcon('COW', 16)).toBe(iconFor('COW', 16))
})

it('draws a sprite from the whole item texture, nearest-neighbour', async () => {
  // Indexed, the way a game's item texture often is: red, green, blue, white.
  const painted = await paintIcon('PICKAXE', indexedPng(2, 2, [0, 1, 2, 3], [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]), 16)
  expect(painted).not.toBeNull()
  expect(colorAt(painted!, 0, 0)).toBe('#ff0000')
  expect(colorAt(painted!, 15, 0)).toBe('#00ff00')
  expect(colorAt(painted!, 0, 15)).toBe('#0000ff')
  expect(colorAt(painted!, 15, 15)).toBe('#ffffff')
  expect(painted).not.toBe(iconFor('PICKAXE', 16))
})

function colorAt(svg: string, x: number, y: number): string | null {
  for (const rect of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"\/>/g)) {
    const left = Number(rect[1])
    const top = Number(rect[2])
    const width = Number(rect[3])
    if (top === y && x >= left && x < left + width) return rect[4]!
  }
  return null
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type)
  const body = new Uint8Array(name.length + data.length)
  body.set(name)
  body.set(data, name.length)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(name, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(body))
  return out
}

function pngOf(width: number, height: number, colorType: number, raw: Uint8Array, extra: Uint8Array[] = []): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = colorType
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function rgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return pngOf(width, height, 6, raw)
}

function indexedPng(width: number, height: number, indices: number[], palette: number[][]): Uint8Array {
  const raw = new Uint8Array((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = indices[y * width + x]!
  }
  const plte = new Uint8Array(palette.length * 3)
  palette.forEach((rgb, i) => plte.set(rgb, i * 3))
  return pngOf(width, height, 3, raw, [chunk('PLTE', plte)])
}
