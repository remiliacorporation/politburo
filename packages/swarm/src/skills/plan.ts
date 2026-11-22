import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PartyConfig } from '../config/load.ts'
import { tagProblems } from '../tags.ts'
import { generatedMarker } from './render.ts'

type PlanOptions = { skills: string; tag: string; job: string; serial: string; live?: string; sprite?: string[] }
type Pools = Record<string, string[]>

function nextFree(base: string, used: Set<string>): string {
  let name = base
  for (let suffix = 2; used.has(name); suffix++) name = `${base}${suffix}`
  return name
}

export function planMob(config: PartyConfig, { skills, tag, job, serial, live, sprite }: PlanOptions) {
  const registry = JSON.parse(readFileSync(new URL('../../registry/tags.json', import.meta.url), 'utf8'))
  const problems = tagProblems(registry)
  if (problems.length) throw new Error(`invalid tag registry: ${problems[0]}`)
  if (!(registry.tags as { tag: string }[]).some((entry) => entry.tag === tag)) {
    throw new Error(`unknown tag ${tag}`)
  }

  const classes = ['passive', 'neutral', 'hostile'] as const
  const pools: Record<(typeof classes)[number], Pools> = config.names.mob_species
  const mobClass = classes.find((group) => Object.hasOwn(pools[group], job))
  if (!mobClass) {
    const jobs = classes.flatMap((group) => Object.keys(pools[group]))
    throw new Error(`unsupported mob job ${job}; available jobs: ${jobs.join(', ')}`)
  }
  const liveNames = new Set(live?.split(','))
  const species = pools[mobClass][job]!
  const name = species.find((candidate) => !liveNames.has(candidate)) ?? nextFree(species[0]!, liveNames)
  const mob = `${serial}-${name}`
  const title = `${tag} ${mob}`
  const usedItems = new Set<string>()
  const items: Pools = config.names.sprite_items
  const sprites = (sprite ?? []).map((spriteJob) => {
    if (!Object.hasOwn(items, spriteJob)) throw new Error(`unknown sprite job ${spriteJob}`)
    const item = nextFree(items[spriteJob]![0]!, usedItems)
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
  if (!template.split(/\r?\n/).includes(generatedMarker)) throw new Error(`missing generated marker in ${path}`)
  const fields = new Map([
    ['mob_id', mob], ['class', mobClass], ['repo', tag], ['party', String(config.party.id)], ['tier', 'mob'],
  ])
  const placeholders = /<<[^\r\n]*?>>/g
  const brief = template.replace(placeholders, (match) => fields.get(match.slice(2, -2)) ?? match)
  return {
    mob, title, class: mobClass, sprites,
    brief_sha256: createHash('sha256').update(brief).digest('hex'),
    open_placeholders: Array.from(brief.matchAll(placeholders)).length,
    brief,
  }
}
