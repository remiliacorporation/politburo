import { readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const names = readdirSync(join(root, 'src', 'public'))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  .sort()
const lines = names.map((name) => `export * from './public/${name}'`)
writeFileSync(join(root, 'src', 'index.generated.ts'), `${lines.join('\n')}\n`)
