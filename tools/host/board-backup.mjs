// Usage: node tools/host/board-backup.mjs --dir <board> --out <backups> [--keep N]
// One --out directory per board. Backups serialize on its .publish.lock.
// --keep N prunes older backups only when their token and directory identity
// match the local .backup-index.json. An unreadable index disables pruning.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const skipped = (name) => name.startsWith('.lock') || /-(wal|shm|journal)$/.test(name)
export const timestamp = (date = new Date()) => date.toISOString().replaceAll(':', '-')

export async function statIfPresent(path, options) {
  try {
    return await lstat(path, options)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export function contains(dir, path) {
  const rel = relative(dir, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

export async function digest(path) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { size, sha256: hash.digest('hex') }
}

export async function privateCopy(source, dest) {
  await copyFile(source, dest)
  await chmod(dest, 0o600)
}

export async function sqliteFile(path) {
  const file = await open(path, 'r')
  try {
    const magic = Buffer.alloc(16)
    const { bytesRead } = await file.read(magic)
    return bytesRead === magic.length && magic.toString() === 'SQLite format 3\0'
  } finally {
    await file.close()
  }
}

export async function integrityCheck(path, name) {
  const { DatabaseSync } = await import('node:sqlite')
  const uri = pathToFileURL(path)
  uri.searchParams.set('immutable', '1')
  const db = new DatabaseSync(uri, { readOnly: true })
  try {
    const rows = db.prepare('pragma integrity_check').all()
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
      throw new Error(rows.map((row) => row.integrity_check).join('; '))
    }
  } catch (error) {
    throw new Error(`integrity check failed for ${name}: ${error.message}`)
  } finally {
    db.close()
  }
}

class BoardChangedError extends Error {}

async function snapshot(source, dest) {
  const { DatabaseSync, backup } = await import('node:sqlite')
  const uri = pathToFileURL(source)
  const busyTimeout = 5000
  // With no WAL or rollback journal, use an immutable read to avoid creating
  // sidecars in a stopped board. Reject a checkpoint or startup during the copy.
  const before = await lstat(source, { bigint: true })
  const journal = await statIfPresent(`${source}-journal`)
  const sidecars = () => Promise.all(['wal', 'shm'].map((suffix) =>
    statIfPresent(`${source}-${suffix}`, { bigint: true })))
  const sidecarsBefore = await sidecars()
  const [wal, shm] = sidecarsBefore
  if (wal && !shm?.isFile()) {
    throw new Error('wal has no shared-memory file; open and cleanly stop the board first')
  }
  const immutable = !wal && !journal
  uri.searchParams.set(immutable ? 'immutable' : 'readonly_shm', '1')
  try {
    const db = new DatabaseSync(uri, { readOnly: true })
    try {
      db.exec(`pragma busy_timeout = ${busyTimeout}; begin; select count(*) from sqlite_schema`)
      // The read transaction pins this database's snapshot even if writes continue.
      await backup(db, dest)
    } finally {
      db.close()
    }
  } finally {
    const sidecarsAfter = await sidecars()
    if (sidecarsBefore.some((prior, i) => {
      const now = sidecarsAfter[i]
      if (!prior) return !!now
      return !now || now.dev !== prior.dev || now.ino !== prior.ino || (prior.size > 0n && now.size === 0n)
    })) {
      // Never remove a sidecar: a restarting board may already be using it.
      const leftover = sidecarsAfter[0]?.size === 0n ? ' (an empty -wal was left in place)' : ''
      throw new BoardChangedError(`board stopped or restarted during the backup; retry${leftover}`)
    }
  }
  if (immutable) {
    const after = await lstat(source, { bigint: true })
    const changed = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])
    if (changed || await statIfPresent(`${source}-wal`) || await statIfPresent(`${source}-journal`)) {
      throw new Error('database changed while opening the snapshot; retry the backup')
    }
  }
  await chmod(dest, 0o600)
}

export async function intendedPath(path) {
  if (await statIfPresent(path)) return realpath(path)
  return join(await intendedPath(dirname(path)), relative(dirname(path), path))
}

async function copyAttachments(source, dest, databases, prefix = '') {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (skipped(entry.name) || (!prefix && databases.has(entry.name))) continue
    const from = join(source, entry.name)
    const to = join(dest, entry.name)
    const path = prefix + entry.name
    if (entry.isDirectory()) {
      await mkdir(to)
      await copyAttachments(from, to, databases, `${path}/`)
    } else if (entry.isFile()) {
      await privateCopy(from, to)
    } else {
      throw new Error(`not a regular file or directory: ${path}`)
    }
  }
}

async function* manifestFiles(dir, prefix = '') {
  for (const name of (await readdir(dir)).sort()) {
    const file = join(dir, name)
    const path = prefix + name
    if ((await lstat(file)).isDirectory()) yield* manifestFiles(file, `${path}/`)
    else yield { path, ...await digest(file) }
  }
}

const BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/

const INDEX_NAME = '.backup-index.json'

async function lockPublisher(out) {
  const { DatabaseSync } = await import('node:sqlite')
  // SQLite holds the OS lock until close or process death. Never unlink the file.
  const path = join(out, '.publish.lock')
  const stat = await statIfPresent(path)
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('invalid publish lock file')
  const db = new DatabaseSync(path)
  try {
    db.exec('pragma busy_timeout = 600000; pragma locking_mode = exclusive; begin exclusive; commit')
    return db
  } catch (error) {
    db.close()
    if (error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) === 5) {
      throw new Error('another backup of this board is running')
    }
    throw error
  }
}

async function readIndex(out) {
  const path = join(out, INDEX_NAME)
  try {
    const stat = await statIfPresent(path)
    if (!stat) return new Map()
    if (!stat.isFile()) throw new Error('not a regular file')
    const { version, backups } = JSON.parse(await readFile(path, 'utf8'))
    if (version !== 1 || !Array.isArray(backups)) throw new Error('invalid index')
    const index = new Map()
    for (const { name, token, dev, ino } of backups) {
      if (typeof name !== 'string' || !BACKUP_NAME.test(name) ||
          typeof token !== 'string' || !token || index.has(name)) throw new Error('invalid entry')
      index.set(name, { name, token, dev, ino })
    }
    return index
  } catch {
    console.error('warning: backup index unreadable; nothing pruned')
    return null
  }
}

async function syncPath(path, tree = false) {
  try {
    if (tree) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!await syncPath(join(path, entry.name), entry.isDirectory())) return false
      }
    }
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    return true
  } catch {
    return false
  }
}

async function writeIndex(out, index) {
  const backups = [...index.values()]
  const temp = join(out, `.backup-index-${randomUUID()}.tmp`)
  const file = await open(temp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify({ version: 1, backups }) + '\n')
    } finally {
      await file.close()
    }
    if (!await syncPath(temp)) {
      await unlink(temp).catch(() => {})
      return false
    }
    await rename(temp, join(out, INDEX_NAME))
    return true
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function matchesBackup(dir, { token, dev, ino }) {
  if (dev == null || ino == null) return false
  try {
    const stat = await lstat(dir, { bigint: true })
    if (!stat.isDirectory() || dev !== String(stat.dev) || ino !== String(stat.ino)) return false
    const path = join(dir, 'MANIFEST.json')
    if (!(await lstat(path)).isFile()) return false
    return JSON.parse(await readFile(path, 'utf8'))?.token === token
  } catch {
    return false
  }
}

async function prune(out, keep, source, index, current) {
  const backups = [current]
  for (const [name, entry] of index) {
    const dir = join(out, name)
    if (name !== current && !contains(dir, source) && await matchesBackup(dir, entry)) backups.push(name)
  }
  // The next publish drops entries for deleted directories. All syncs precede deletion.
  for (const name of backups.sort().reverse().slice(keep)) {
    const dir = join(out, name)
    if (name !== current && await matchesBackup(dir, index.get(name))) {
      await rm(dir, { recursive: true })
    }
  }
}

async function publishBackup(source, out, keep) {
  const databases = new Set()
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!skipped(entry.name) && entry.isFile() && await sqliteFile(join(source, entry.name))) {
      databases.add(entry.name)
    }
  }
  if (!databases.size) throw new Error('no sqlite database in --dir')

  const index = await readIndex(out)
  if (index) {
    // Drop entries left by an interrupted publish or a manually removed backup.
    // An existing entry is retained even if its manifest cannot be read.
    for (const name of index.keys()) {
      if (!await statIfPresent(join(out, name))) index.delete(name)
    }
  }
  let created = new Date()
  let name = `backup-${timestamp(created)}`
  let complete = join(out, name)
  while (await statIfPresent(complete)) {
    await sleep(1)
    created = new Date()
    name = `backup-${timestamp(created)}`
    complete = join(out, name)
  }
  const token = randomUUID()
  const partial = join(out, `.partial-${token}`)
  await mkdir(partial)
  let files
  let synced
  try {
    const dest = join(partial, 'files')
    await mkdir(dest)
    for (const path of databases) {
      try {
        await snapshot(join(source, path), join(dest, path))
        await integrityCheck(join(dest, path), path)
      } catch (error) {
        if (error instanceof BoardChangedError) throw error
        throw new Error(`snapshot ${path}: ${error.message}`)
      }
    }
    // The board writes attachments before committing a reference to them.
    await copyAttachments(source, dest, databases)
    files = []
    for await (const file of manifestFiles(dest)) files.push(file)
    await writeFile(join(partial, 'MANIFEST.json'), JSON.stringify({
      version: 1, token, created: created.toISOString(), files,
      databases: [...databases].map((path) => ({ path, integrity: 'ok' })),
    }, null, 2) + '\n')
    synced = await syncPath(partial, true)
    await rename(partial, complete)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
  console.log(`backup  ${complete}\ndatabases  ${databases.size}  files  ${files.length}`)
  if (synced && index) {
    // A crash between rename and indexing leaves a backup that cannot be pruned.
    const { dev, ino } = await lstat(complete, { bigint: true })
    index.set(name, { name, token, dev: String(dev), ino: String(ino) })
    synced = await writeIndex(out, index)
  }
  if (synced) synced = await syncPath(out)
  if (!synced) console.error('warning: backup not synced; nothing pruned')
  else if (index && keep !== undefined) await prune(out, keep, source, index, name)
}

async function makeBackup(dir, out, keep) {
  const source = await realpath(dir)
  out = await intendedPath(resolve(out))
  if (contains(source, out)) throw new Error('--out must be outside the board directory')
  await mkdir(out, { recursive: true })
  const lock = await lockPublisher(out)
  try {
    await publishBackup(source, out, keep)
  } finally {
    lock.close()
  }
}

export async function runCli(options, required, run) {
  let values
  try {
    values = parseArgs({ options }).values
    for (const key of required) {
      if (!values[key]) throw new Error(`--${key} is required`)
    }
    if (values.keep !== undefined && (!/^\d+$/.test(values.keep) ||
        !Number.isSafeInteger(Number(values.keep)) || Number(values.keep) < 1)) {
      throw new Error('--keep must be a positive integer')
    }
  } catch (error) {
    console.error(`error: ${error.message}`)
    process.exitCode = 2
    return
  }
  process.umask(0o077)
  try {
    await run(values)
  } catch (error) {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await runCli({ dir: { type: 'string' }, out: { type: 'string' }, keep: { type: 'string' } },
    ['dir', 'out'], ({ dir, out, keep }) => makeBackup(dir, out, keep === undefined ? undefined : Number(keep)))
}
