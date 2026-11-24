import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function tagProblems(registry: unknown): string[] {
  if (!isObject(registry) || !Array.isArray(registry.tags)) {
    return ['The registry must be an object with a tags array.']
  }

  const problems: string[] = []
  const tags = new Set<string>()
  const projects = new Set<string>()
  for (const [index, entry] of registry.tags.entries()) {
    const report = (detail: string) => problems.push(`Entry ${index} ${detail}.`)
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

function registryPath(file?: string): string {
  return file ?? fileURLToPath(new URL('../registry/tags.json', import.meta.url))
}

export async function readRegistry(file?: string): Promise<unknown> {
  return parse(readFileSync(registryPath(file), 'utf8'))
}

export type OpenedTagRegistry =
  | { status: 'ok'; tags: { tag: string }[] }
  | { status: 'unreadable'; message: string }
  | { status: 'invalid'; problems: string[] }

/** Read and validate a tag registry. `tags check`, `work id`, and `plan-mob` all use this. */
export function openTagRegistry(file?: string): OpenedTagRegistry {
  let text: string
  try {
    text = readFileSync(registryPath(file), 'utf8')
  } catch {
    return { status: 'unreadable', message: file ? `cannot read ${file}` : 'cannot read tag registry' }
  }
  let registry: unknown
  try {
    registry = parse(text)
  } catch {
    return { status: 'invalid', problems: ['Malformed tag registry.'] }
  }
  const problems = tagProblems(registry)
  if (problems.length) return { status: 'invalid', problems }
  return { status: 'ok', tags: (registry as { tags: { tag: string }[] }).tags }
}

export function canonicalTag(tags: readonly { tag: string }[], tag: string): string | undefined {
  const canonical = tag.toLowerCase()
  return tags.some((entry) => entry.tag === canonical) ? canonical : undefined
}
