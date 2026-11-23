/**
 * One-way cutover: start this allocator only after all legacy writers stop.
 * mob-serial.txt is read-only for legacy consumers.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
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
 * serials/ is the authority. The mirror may lag while writers compete or if retries run out.
 */
function mirror(dir: string, claims: string, counter: string): void {
  const temp = join(dir, `.mob-serial-${randomUUID()}.tmp`)
  let highest = highestClaim(claims)
  let current = readCounter(counter)
  for (let round = 0; round < 5 && current < highest; round++) {
    try {
      writeFileSync(temp, `${highest}\n`, { flag: 'wx' })
      if (readCounter(counter) < highest) renameSync(temp, counter)
    } finally {
      rmSync(temp, { force: true })
    }
    // A peer can publish a higher claim between the last read and our rename.
    highest = highestClaim(claims)
    current = readCounter(counter)
  }
}

/** Allocate a serial permanently; retirement never frees a serial. */
export function allocateSerial(dir: string): number {
  mkdirSync(dir, { recursive: true })
  dir = realpathSync(dir)
  const claimsPath = join(dir, 'serials')
  const counter = join(dir, 'mob-serial.txt')
  const existing = lstatSync(claimsPath, { throwIfNoEntry: false })
  if (existing && !existing.isDirectory()) throw new Error(`expected a directory, not a symlink or file: ${claimsPath}`)
  // If the legacy file held the next serial instead of the last, skip it rather than reuse it.
  const current = readCounter(counter)
  mkdirSync(claimsPath, { recursive: true })
  const claims = realpathSync(claimsPath)
  if (claims !== claimsPath) throw new Error(`symlink refused: ${claimsPath}`)
  // A swap in the microseconds after this check requires write access to --dir and is out of scope.
  let serial = Math.max(current, highestClaim(claims)) + 1
  for (;; serial++) {
    if (!Number.isSafeInteger(serial)) throw new Error(`serial range exhausted in ${dir}`)
    let fd: number
    try {
      fd = openSync(join(claims, String(serial)), 'wx')
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      continue
    }
    try {
      try {
        writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      } finally {
        closeSync(fd)
      }
    } catch {
      // The exclusive create is the claim. Its informational content is best-effort.
    }
    break
  }

  try {
    mirror(dir, claims, counter)
  } catch {
    // The claim is permanent. A later allocation can repair the best-effort mirror.
  }
  return serial
}
