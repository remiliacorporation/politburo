import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type Command = {
  name: string
  summary: string
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
  if (loaded.name !== name || typeof loaded.summary !== 'string' || typeof loaded.run !== 'function') {
    throw new Error(`swarm command ${name} must export name, summary, and run`)
  }
  return { name: loaded.name, summary: loaded.summary, run: loaded.run }
}
