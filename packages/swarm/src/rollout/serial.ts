/**
 * One-way cutover: start this allocator only after all legacy writers stop.
 * mob-serial.txt is read-only for legacy consumers.
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function readCounter(file: string): number {
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`symlink refused: ${file}`)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 0
    throw error
  }
  const value = Number(text)
  if (!/^[0-9]+\n?$/.test(text) || !Number.isSafeInteger(value)) {
    throw new Error(`invalid serial counter in ${file}: expected a non-negative safe integer`)
  }
  return value
}

function highestClaim(claims: string): number {
  let highest = 0
  for (const entry of readdirSync(claims)) {
    const serial = Number(entry)
    if (/^[1-9][0-9]*$/.test(entry) && Number.isSafeInteger(serial)) highest = Math.max(highest, serial)
  }
  return highest
}

/**
 * Best-effort mirror of the highest claim into mob-serial.txt.
 * serials/ is the authority. The mirror converges when allocators finish and may lag meanwhile.
 */
function mirror(dir: string, claims: string, counter: string): void {
  const temp = join(dir, `.mob-serial-${randomUUID()}.tmp`)
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = readCounter(counter)
      const m = Math.max(current, highestClaim(claims))
      if (!(current < m)) return
      try {
        writeFileSync(temp, `${m}\n`, { flag: 'wx' })
        const latest = readCounter(counter)
        if (latest < m) renameSync(temp, counter)
      } finally {
        rmSync(temp, { force: true })
      }
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Allocate a serial permanently; retirement never frees a serial. */
export function allocateSerial(dir: string): number {
  mkdirSync(dir, { recursive: true })
  dir = realpathSync(dir)
  const claims = join(dir, 'serials')
  const counter = join(dir, 'mob-serial.txt')
  const existing = lstatSync(claims, { throwIfNoEntry: false })
  if (existing && !existing.isDirectory()) throw new Error(`expected a directory, not a symlink or file: ${claims}`)
  // If the legacy file held the next serial instead of the last, skip it rather than reuse it.
  const current = readCounter(counter)
  mkdirSync(claims, { recursive: true })
  let serial = Math.max(current, highestClaim(claims)) + 1
  for (;; serial++) {
    if (!Number.isSafeInteger(serial)) throw new Error(`serial range exhausted in ${dir}`)
    try {
      writeFileSync(join(claims, String(serial)), `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
  }

  try {
    mirror(dir, claims, counter)
  } catch {
    // The claim is permanent. A later allocation can repair the best-effort mirror.
  }
  return serial
}
