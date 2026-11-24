import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PartyConfig } from '../config/load.ts'
import { canonicalTag, openTagRegistry } from '../tags.ts'
import { generatedMarker, hasBlockedReference } from './render.ts'

type PlanOptions = {
  skills: string; tag: string; job: string; serial: string
  live?: string; sprite?: string[]; registry?: string
}
type Pools = Record<string, string[]>

function firstFree(pool: string[], used: Set<string>) {
  const free = pool.find((name) => !used.has(name))
  if (free !== undefined) return { base: free, suffix: '' }
  const base = pool[0]!
  let suffix = 2
  while (used.has(`${base}${suffix}`)) suffix++
  return { base, suffix: String(suffix) }
}

const disallowedControls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

export function planMob(config: PartyConfig, { skills, tag, job, serial, live, sprite, registry: registryFile }: PlanOptions) {
  const opened = openTagRegistry(registryFile)
  if (opened.status === 'unreadable') throw new Error(opened.message)
  if (opened.status === 'invalid') throw new Error(`invalid tag registry: ${opened.problems[0]}`)
  const repo = canonicalTag(opened.tags, tag)
  if (!repo) throw new Error(`unknown tag ${tag}`)

  const classes = ['passive', 'neutral', 'hostile'] as const
  const pools: Record<(typeof classes)[number], Pools> = config.names.mob_species
  const mobClass = classes.find((group) => Object.hasOwn(pools[group], job))
  if (!mobClass) {
    const jobs = classes.flatMap((group) => Object.keys(pools[group]))
    throw new Error(`unsupported mob job ${job}; available jobs: ${jobs.join(', ')}`)
  }
  const liveNames = new Set<string>()
  for (const entry of live?.split(',') ?? []) {
    const name = entry.trim()
    if (!name) continue
    liveNames.add(name)
    liveNames.add(name.replace(/\d+$/, ''))
  }
  function pick(pool: string[], used: Set<string>, basePattern: RegExp, maxNameLength = Infinity) {
    const { base, suffix } = firstFree(pool, used)
    const name = `${base}${suffix}`
    if (pool.length === 0 || pool.some((candidate) => !basePattern.test(candidate)) ||
      !/^\d*$/.test(suffix) || name.length > maxNameLength) {
      throw new Error(`invalid name in names.mob_species.${mobClass}.${job}`)
    }
    return name
  }
  const name = pick(pools[mobClass][job]!, liveNames, /^[A-Z0-9]{1,8}$/)
  const mob = `${serial}-${name}`
  const title = `${repo} ${mob}`
  const usedItems = new Set<string>()
  const items: Pools = config.names.sprite_items
  const sprites = (sprite ?? []).map((spriteJob) => {
    if (!Object.hasOwn(items, spriteJob)) throw new Error(`unknown sprite job ${spriteJob}`)
    const item = pick(items[spriteJob]!, usedItems, /^[A-Z0-9]{1,12}$/, 12)
    usedItems.add(item)
    return `${mob}.${item}`
  })

  function installed(relative: string) {
    const path = join(skills, relative)
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`missing skill file: ${path}`)
    return path
  }
  installed('mob-creation/SKILL.md')
  installed('policy/SKILL.md')
  const path = installed('mob-creation/brief-template.md')
  const template = readFileSync(path, 'utf8')
  if (disallowedControls.test(template)) throw new Error('control character in brief template')
  if (!template.split('\n').includes(generatedMarker)) throw new Error(`missing generated marker in ${path}`)
  const fields = new Map([
    ['mob_id', mob], ['class', mobClass], ['repo', repo], ['party', String(config.party.id)], ['tier', 'mob'],
  ])
  const placeholders = /<<[^\r\n]*?>>/g
  const brief = template.replace(placeholders, (match) => fields.get(match.slice(2, -2)) ?? match)
  if (disallowedControls.test(brief)) throw new Error('control character in brief')
  if (hasBlockedReference(brief)) throw new Error('protected repo reference in brief')
  return {
    mob, title, class: mobClass, sprites,
    brief_sha256: createHash('sha256').update(brief).digest('hex'),
    open_placeholders: Array.from(brief.matchAll(placeholders)).length,
    brief,
  }
}
