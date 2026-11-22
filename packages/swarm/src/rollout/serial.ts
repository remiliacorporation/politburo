/**
 * One-way cutover: start this allocator only after all legacy writers stop.
 * mob-serial.txt is read-only for legacy consumers.
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

function ownerIsDead(owner: string): boolean {
  try {
    const pid = Number(readFileSync(owner, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false
    process.kill(pid, 0)
    return false
  } catch (error) {
    return hasCode(error, 'ESRCH')
  }
}

const spin = new Int32Array(new SharedArrayBuffer(4))

function mirror(dir: string, claims: string, counter: string): void {
  const lock = join(dir, '.counter.lock')
  const owner = join(lock, 'pid')
  const deadline = performance.now() + 3000
  for (;;) {
    if (performance.now() >= deadline) return
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    const seen = lstatSync(lock, { throwIfNoEntry: false })
    if (!seen) continue
    if (!seen.isDirectory()) return
    if (Date.now() - seen.mtimeMs > 30_000 || ownerIsDead(owner)) {
      const latest = lstatSync(lock, { throwIfNoEntry: false })
      if (latest?.ino === seen.ino && latest.dev === seen.dev && latest.mtimeMs === seen.mtimeMs) {
        const stale = `${lock}-${randomUUID()}`
        try {
          renameSync(lock, stale)
        } catch (error) {
          if (hasCode(error, 'ENOENT')) continue
          throw error
        }
        rmSync(stale, { recursive: true })
        continue
      }
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) return
    Atomics.wait(spin, 0, 0, Math.min(10, remaining))
  }

  const identity = lstatSync(lock)
  const ownsLock = () => {
    const current = lstatSync(lock, { throwIfNoEntry: false })
    return current?.ino === identity.ino && current.dev === identity.dev
  }
  try {
    writeFileSync(owner, `${process.pid}\n`, { flag: 'wx' })
    const temp = join(dir, `.mob-serial-${randomUUID()}.tmp`)
    while (ownsLock()) {
      const current = readCounter(counter)
      const target = Math.max(current, highestClaim(claims))
      if (current === target) return
      try {
        writeFileSync(temp, `${target}\n`, { flag: 'wx' })
        if (readCounter(counter) < target && ownsLock()) renameSync(temp, counter)
      } finally {
        rmSync(temp, { force: true })
      }
    }
  } finally {
    if (ownsLock()) rmSync(lock, { recursive: true })
  }
}

/** Allocate a serial permanently; retirement never frees a serial. */
export function allocateSerial(dir: string): number {
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
