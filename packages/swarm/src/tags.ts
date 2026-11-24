import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function tagProblems(registry: unknown, { indexOnly = false } = {}): string[] {
  if (!isObject(registry) || !Array.isArray(registry.tags)) {
    return ['The registry must be an object with a tags array.']
  }

  const problems: string[] = []
  const tags = new Set<string>()
  const projects = new Set<string>()
  for (const [index, entry] of registry.tags.entries()) {
    const report = (detail: string) => problems.push(indexOnly ? `Entry ${index}.` : `Entry ${index} ${detail}.`)
    if (!isObject(entry)) {
      report('must be an object')
      continue
    }
    const { tag, project } = entry
    if (typeof tag !== 'string' || !/^[a-z]{3}$/.test(tag)) {
      report('must have a tag of exactly three lowercase ASCII letters')
    }
    if (typeof tag === 'string') {
      if (tags.has(tag)) report(`repeats tag ${JSON.stringify(tag)}`)
      tags.add(tag)
    }
    if (typeof project === 'string') {
      if (projects.has(project)) report(`repeats project ${JSON.stringify(project)}`)
      projects.add(project)
    }
  }
  return problems
}

export async function readRegistry(file?: string): Promise<unknown> {
  return parse(await readFile(file ?? new URL('../registry/tags.json', import.meta.url), 'utf8'))
}
