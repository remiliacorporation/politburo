import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { dirname } from 'node:path'
import { validateEnvelope } from './claim.ts'
import type { Envelope } from './record.ts'

export interface BookEntry {
  envelope: Envelope
  issuedAt: string
  expiresAt: string
  session: string | null
  revoked: boolean
}

export class BookError extends Error {}

function privateFile(stat: BigIntStats) {
  if (!stat.isFile() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n)) {
    throw new BookError('unsafe book file')
  }
}
const versionOf = (stat: BigIntStats) =>
  `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`
const sleep = new Int32Array(new SharedArrayBuffer(4))
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code

function createLock(path: string) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${process.pid}\n`); return fd } catch (error) {
    closeSync(fd)
    try { unlinkSync(path) } catch { /* incomplete lock must not stay */ }
    throw error
  }
}

function lockPid(path: string) {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch { return }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 11) return
    const text = readFileSync(fd, 'utf8').trim()
    if (/^[1-9][0-9]*$/.test(text) && Number(text) <= 0x7fffffff) return Number(text)
  } finally { closeSync(fd) }
}

function deadHolder(path: string) {
  const pid = lockPid(path)
  if (pid === undefined) return false
  try { process.kill(pid, 0); return false } catch (error) { return errno(error) === 'ESRCH' }
}

function takeDeadLock(path: string) {
  if (!deadHolder(path)) return
  const temp = `${path}.tmp`
  let fd: number
  try { fd = createLock(temp) } catch { return }
  let keep = false
  try {
    if (!deadHolder(path)) return
    renameSync(temp, path)
    if (lockPid(path) !== process.pid) return
    keep = true
    return fd
  } finally {
    if (!keep) {
      try { unlinkSync(temp) } catch { /* takeover abandoned */ }
      closeSync(fd)
    }
  }
}

export class Book {
  #file?: string
  #now: () => number
  #version: string | undefined
  #entries = new Map<string, BookEntry>()
  #sessions = new Map<string, string>()

  constructor(opts: { file?: string; now?: () => number } = {}) {
    if (opts.file !== undefined) this.#file = opts.file
    this.#now = opts.now ?? Date.now
    this.#refresh()
  }

  // Readers pick up atomic CLI updates.
  #refresh(force = false) {
    if (!this.#file) return
    const stat = lstatSync(this.#file, { bigint: true, throwIfNoEntry: false })
    if (stat) privateFile(stat)
    if (!force && stat && versionOf(stat) === this.#version) return
    let text = '{}', version: string | undefined
    if (stat) {
      let fd: number
      try { fd = openSync(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new BookError('unsafe book file')
        throw error
      }
      try {
        const opened = fstatSync(fd, { bigint: true })
        privateFile(opened)
        version = versionOf(opened)
        text = readFileSync(fd, 'utf8')
      } finally { closeSync(fd) }
    }
    this.#entries = new Map(Object.entries(JSON.parse(text)))
    this.#sessions.clear()
    for (const [cap, entry] of this.#entries) if (entry.session) this.#sessions.set(entry.session, cap)
    this.#version = version
  }

  #mutate<T>(change: () => T): T {
    if (!this.#file) return change()
    const lock = `${this.#file}.lock`, deadline = performance.now() + 2000
    let fd: number
    for (;;) {
      try { fd = createLock(lock); break } catch (error) {
        if (errno(error) !== 'EEXIST') throw error
      }
      const taken = takeDeadLock(lock)
      if (taken !== undefined) { fd = taken; break }
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new BookError('book is locked')
      Atomics.wait(sleep, 0, 0, Math.min(20, remaining))
    }
    try { this.#refresh(true); return change() } finally {
      try {
        const held = lstatSync(lock, { bigint: true, throwIfNoEntry: false })
        if (held && versionOf(held) === versionOf(fstatSync(fd, { bigint: true }))) unlinkSync(lock)
      } finally { closeSync(fd) }
    }
  }

  #save(cap: string, entry: BookEntry) {
    if (this.#file) {
      const entries = new Map(this.#entries).set(cap, entry)
      const temp = `${this.#file}.${randomBytes(12).toString('hex')}.tmp`
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(fd, JSON.stringify(Object.fromEntries(entries)))
        fsyncSync(fd)
      } catch {
        closeSync(fd)
        try { unlinkSync(temp) } catch { /* incomplete temp must not stay */ }
        throw new BookError('failed to sync book file')
      }
      closeSync(fd)
      try { renameSync(temp, this.#file) } catch (error) { unlinkSync(temp); throw error }
      try {
        const dirfd = openSync(dirname(this.#file), 'r')
        try { fsyncSync(dirfd) } finally { closeSync(dirfd) }
      } catch {
        throw new BookError('failed to sync book file')
      }
      this.#version = versionOf(lstatSync(this.#file, { bigint: true }))
    }
    this.#entries.set(cap, entry)
    if (entry.session) this.#sessions.set(entry.session, cap)
  }

  issue(envelope: Envelope, { ttlMs }: { ttlMs: number }): { capability: string; expiresAt: string } {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000) throw new BookError('invalid ttl')
    if (!validateEnvelope(envelope)) throw new BookError('invalid envelope')
    return this.#mutate(() => {
      const capability = `cap_${randomBytes(24).toString('base64url')}`
      const now = this.#now()
      const expiresAt = new Date(now + ttlMs).toISOString()
      this.#save(capability, { envelope: structuredClone(envelope), issuedAt: new Date(now).toISOString(),
        expiresAt, session: null, revoked: false })
      return { capability, expiresAt }
    })
  }

  bind(capability: string, ccrSessionId: string): void {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(ccrSessionId)) throw new BookError('invalid session id')
    this.#mutate(() => {
      const entry = this.#live(capability, this.#now())
      if (!entry) throw new BookError('unknown envelope')
      if (entry.session === ccrSessionId) return
      if (entry.session || this.#sessions.has(ccrSessionId)) throw new BookError('session already bound')
      this.#save(capability, { ...entry, session: ccrSessionId })
    })
  }

  byCapability(capability: string, now: number): BookEntry | undefined {
    this.#refresh()
    return this.#live(capability, now)
  }

  #live(capability: string, now: number): BookEntry | undefined {
    const entry = this.#entries.get(capability)
    const unexpired = now < Date.parse(entry?.expiresAt ?? '')
    if (!unexpired || !entry || entry.revoked) return undefined
    return structuredClone(entry)
  }

  bySession(sessionId: string, now: number): BookEntry | undefined {
    this.#refresh()
    return this.#live(this.#sessions.get(sessionId) ?? '', now)
  }

  revoke(capability: string): void {
    this.#mutate(() => {
      const entry = this.#entries.get(capability)
      if (entry && !entry.revoked) this.#save(capability, { ...entry, revoked: true })
    })
  }
}
