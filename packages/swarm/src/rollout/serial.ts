import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

function readCounter(file: string): number {
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
    if (/^[0-9]+$/.test(entry)) highest = Math.max(highest, Number(entry))
  }
  return highest
}

/** Allocate a serial permanently; retirement never frees a serial. */
export function allocateSerial(dir: string): number {
  const claims = join(dir, 'serials')
  const counter = join(dir, 'mob-serial.txt')
  mkdirSync(claims, { recursive: true })
  // Assume the live file holds the last issued serial; if it holds the next one,
  // we skip one number rather than reuse it.
  let serial = Math.max(readCounter(counter), highestClaim(claims)) + 1
  for (;; serial++) {
    if (!Number.isSafeInteger(serial)) throw new Error(`serial range exhausted in ${dir}`)
    try {
      writeFileSync(join(claims, String(serial)), `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
  }

  // A stale rename can briefly lower the compatibility counter, but the last
  // writer rescans after its rename and repairs any lost update before returning.
  // Even if it is killed before repairing, permanent claims preserve the high
  // water mark for the next allocation.
  let target = serial
  const temp = join(dir, `.mob-serial-${randomUUID()}.tmp`)
  for (;;) {
    const current = readCounter(counter)
    target = Math.max(target, highestClaim(claims), current)
    if (current === target) return serial
    writeFileSync(temp, `${target}\n`, { flag: 'wx' })
    try {
      const latest = readCounter(counter)
      if (latest < target) renameSync(temp, counter)
      else target = latest
    } finally {
      rmSync(temp, { force: true })
    }
  }
}
