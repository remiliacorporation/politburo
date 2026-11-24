import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type Command = {
  name: string
  summary: string
  usage: readonly string[]
  usageOrder?: number
  catalog: boolean
  run(argv: string[]): number | Promise<number>
}

const file = fileURLToPath(import.meta.url)
const directory = dirname(file)
const extension = file.endsWith('.ts') ? '.ts' : '.js'

export function commandNames(): Set<string> {
  const names = new Set<string>()
  for (const entry of readdirSync(directory)) {
    if (entry === `load${extension}` || !entry.endsWith(extension) || entry.endsWith('.d.ts')) continue
    names.add(entry.slice(0, -extension.length))
  }
  return names
}

export async function loadCommand(name: string): Promise<Command> {
  const loaded = await import(pathToFileURL(join(directory, `${name}${extension}`)).href) as Partial<Command>
  const usage = loaded.usage
  if (loaded.name !== name || typeof loaded.summary !== 'string' || typeof loaded.run !== 'function' ||
    !Array.isArray(usage) || usage.some((line) => typeof line !== 'string')) {
    throw new Error(`swarm command ${name} must export name, summary, usage, and run`)
  }
  if (usage.length > 0 && typeof loaded.usageOrder !== 'number') {
    throw new Error(`swarm command ${name} must export usageOrder with its usage lines`)
  }
  if (loaded.catalog !== undefined && typeof loaded.catalog !== 'boolean') {
    throw new Error(`swarm command ${name} catalog must be a boolean`)
  }
  return {
    name: loaded.name, summary: loaded.summary, usage, usageOrder: loaded.usageOrder,
    catalog: loaded.catalog !== false, run: loaded.run,
  }
}

export async function loadCommands(): Promise<Command[]> {
  const names = [...commandNames()].sort()
  const commands: Command[] = []
  for (const name of names) commands.push(await loadCommand(name))
  return commands
}
