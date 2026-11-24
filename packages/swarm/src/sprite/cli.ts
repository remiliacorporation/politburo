import { randomUUID } from 'node:crypto'
import { closeSync, fchmodSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildSetup } from './build.ts'

const usage = 'usage: swarm setup build [--out FILE]'

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

export function runSetup(args: string[]): number {
  const [action, ...flags] = args
  if (action === '--help' && flags.length === 0) {
    console.log(usage)
    return 0
  }
  if (action === undefined) return misuse('missing setup command')
  if (action !== 'build') return misuse(`unknown setup command ${action}`)

  let out: string | undefined
  try {
    out = parseArgs({ args: flags, strict: true, options: { out: { type: 'string' } } }).values.out
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return misuse(message.replace(/^./, (letter) => letter.toLowerCase()))
  }
  if (out === '') return misuse('--out requires a file')

  try {
    const { text, version, hash } = buildSetup()
    if (out === undefined) {
      process.stdout.write(text)
    } else {
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
      console.log(`wrote ${out} (v${version} sha256:${hash.slice(0, 12)})`)
    }
    return 0
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error))
    return 1
  }
}
