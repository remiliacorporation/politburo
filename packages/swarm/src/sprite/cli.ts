import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fchmodSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildSetup, codexSetupParts } from './build.ts'

const usage = 'usage: swarm setup build [--out FILE] [--target claude|codex] [--out-dir DIR]'
const targets = new Set(['claude', 'codex'])

function printError(message: string) {
  const safe = message.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  console.error(`error: ${safe}`)
}

function misuse(message: string): number {
  printError(message)
  console.error(usage)
  return 2
}

function writeNewFile(out: string, text: string) {
  const temp = join(realpathSync.native(dirname(out)), `.swarm-setup-${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o644)
  try {
    try {
      writeFileSync(fd, text)
      fchmodSync(fd, 0o644)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, out)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

const codexFiles = [
  ['setup.sh', 'setup'],
  ['maintenance.sh', 'maintenance'],
  ['settings.md', 'settings'],
] as const

function printCodex(parts: ReturnType<typeof codexSetupParts>) {
  for (const [name, key] of codexFiles) {
    const text = parts[key]
    const hash = createHash('sha256').update(text).digest('hex')
    process.stdout.write(`# politburo-codex ${name} sha256:${hash}\n${text}`)
  }
}

export function runSetup(args: string[]): number {
  const [action, ...flags] = args
  if (action === '--help' && flags.length === 0) {
    console.log(usage)
    return 0
  }
  if (action === undefined) return misuse('missing setup command')
  if (action !== 'build') return misuse(`unknown setup command ${action}`)

  let out: string | undefined
  let outDir: string | undefined
  let target = 'claude'
  try {
    const values = parseArgs({
      args: flags,
      strict: true,
      options: {
        out: { type: 'string' },
        target: { type: 'string' },
        'out-dir': { type: 'string' },
      },
    }).values
    out = values.out
    outDir = values['out-dir']
    if (values.target !== undefined) target = values.target
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return misuse(message.replace(/^./, (letter) => letter.toLowerCase()))
  }
  if (out === '') return misuse('--out requires a file')
  if (outDir === '') return misuse('--out-dir requires a directory')
  if (!targets.has(target)) return misuse(`unknown setup target ${target}`)
  if (out !== undefined && outDir !== undefined) return misuse('use either --out or --out-dir')
  if (target === 'claude' && outDir !== undefined) return misuse('--out-dir is for --target codex')
  if (target === 'codex' && out !== undefined) return misuse('--out is for the claude script; use --out-dir for codex')

  try {
    if (target === 'claude') {
      const { text, version, hash } = buildSetup()
      if (out === undefined) {
        process.stdout.write(text)
      } else {
        writeNewFile(out, text)
        console.log(`wrote ${out} (v${version} sha256:${hash.slice(0, 12)})`)
      }
      return 0
    }
    const parts = codexSetupParts()
    if (outDir === undefined) {
      printCodex(parts)
    } else {
      realpathSync.native(outDir)
      for (const [name, key] of codexFiles) {
        const text = parts[key]
        writeNewFile(join(outDir, name), text)
        const hash = createHash('sha256').update(text).digest('hex')
        console.log(`wrote ${join(outDir, name)} sha256:${hash}`)
      }
    }
    return 0
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error))
    return 1
  }
}
