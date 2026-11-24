import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { emptyRegistry, RegistryError, validateRegistry, type Party, type Registry, type Role } from './model.ts'
import { principalOf } from './principal.ts'

function normalizedEmail(email: string): string {
  principalOf(email)
  return email.toLowerCase()
}

function rejectSymlink(file: string): void {
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new RegistryError('', 'registry path must not be a symlink')
  }
}

export function loadRegistry(file: string): Registry {
  rejectSymlink(file)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new RegistryError('', 'invalid registry JSON')
  }
  // Keep the JSON-only format, but check keys with the same parser as config.
  if (parseDocument(text, { uniqueKeys: true }).errors.some(({ code }) => code === 'DUPLICATE_KEY')) {
    throw new RegistryError('', 'duplicate key in registry JSON')
  }
  return validateRegistry(value)
}

function saveRegistry(file: string, reg: Registry): void {
  const text = `${JSON.stringify(validateRegistry(reg), null, 2)}\n`
  const temp = join(dirname(file), `.parties-${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, text)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function updateRegistry(file: string, mutate: (reg: Registry) => Registry): void {
  rejectSymlink(file)
  const lock = `${file}.lock`
  const deadline = performance.now() + 5_000
  const wait = new Int32Array(new SharedArrayBuffer(4))
  let fd: number
  for (;;) {
    try {
      fd = openSync(lock, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = lstatSync(lock, { throwIfNoEntry: false })
      if (info && Date.now() - info.mtimeMs > 60_000) throw new RegistryError('', `stale registry lock: ${lock}`)
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new RegistryError('', `another update holds the lock: ${lock}`)
      Atomics.wait(wait, 0, 0, Math.min(25, remaining))
    }
  }
  try {
    closeSync(fd)
    saveRegistry(file, mutate(loadRegistry(file)))
  } finally {
    rmSync(lock, { force: true })
  }
}

export function getParty(reg: Registry, id: string): Party {
  const party = reg.parties.find((party) => party.id === id)
  if (!party) throw new RegistryError('id', `unknown party ${id}`)
  return party
}

export function addParty(reg: Registry, party: Omit<Party, 'members'>): Registry {
  return validateRegistry({ ...reg, parties: [...reg.parties, { ...party, members: [] }] })
}

export function removeParty(reg: Registry, id: string): Registry {
  getParty(reg, id)
  return { ...reg, parties: reg.parties.filter((party) => party.id !== id) }
}

export function setMember(reg: Registry, partyId: string, email: string, role: Role): Registry {
  const party = getParty(reg, partyId)
  email = normalizedEmail(email)
  const member = { email, role }
  const members = party.members.some((item) => item.email === email)
    ? party.members.map((item) => item.email === email ? member : item)
    : [...party.members, member]
  return validateRegistry({ ...reg, parties: reg.parties.map((item) => item === party ? { ...party, members } : item) })
}

export function removeMember(reg: Registry, partyId: string, email: string): Registry {
  const party = getParty(reg, partyId)
  email = normalizedEmail(email)
  const members = party.members.filter((member) => member.email !== email)
  if (members.length === party.members.length) throw new RegistryError('email', `unknown member ${email}`)
  return { ...reg, parties: reg.parties.map((item) => item === party ? { ...party, members } : item) }
}

export function addJockey(reg: Registry, email: string): Registry {
  return validateRegistry({ ...reg, jockeys: [...reg.jockeys, normalizedEmail(email)] })
}

export function removeJockey(reg: Registry, email: string): Registry {
  email = normalizedEmail(email)
  if (!reg.jockeys.includes(email)) throw new RegistryError('email', `unknown jockey ${email}`)
  return { ...reg, jockeys: reg.jockeys.filter((jockey) => jockey !== email) }
}
