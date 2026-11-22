import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

async function snapshot(source, dest) {
  const { DatabaseSync, backup } = await import('node:sqlite')
  const uri = pathToFileURL(source)
  const busyTimeout = 5000
  // With no WAL or rollback journal, use an immutable read to avoid creating
  // sidecars in a stopped board. Reject a checkpoint or startup during the copy.
  const before = await lstat(source, { bigint: true })
  const wal = await statIfPresent(`${source}-wal`)
  const journal = await statIfPresent(`${source}-journal`)
  if (wal && !(await statIfPresent(`${source}-shm`))?.isFile()) {
    throw new Error('wal has no shared-memory file; open and cleanly stop the board first')
  }
  const immutable = !wal && !journal
  uri.searchParams.set(immutable ? 'immutable' : 'readonly_shm', '1')
  const db = new DatabaseSync(uri, { readOnly: true })
  try {
    db.exec(`pragma busy_timeout = ${busyTimeout}; begin; select count(*) from sqlite_schema`)
    // The read transaction pins this database's snapshot even if writes continue.
    await backup(db, dest)
  } finally {
    db.close()
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

async function prune(out, keep, source) {
  const backups = []
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue
    const dir = join(out, entry.name)
    if (contains(dir, source)) continue
    if ((await statIfPresent(join(dir, 'MANIFEST.json')))?.isFile()) backups.push(entry.name)
  }
  for (const older of backups.sort().reverse().slice(keep)) {
    await rm(join(out, older), { recursive: true })
  }
}

async function makeBackup(dir, out, keep) {
  const source = await realpath(dir)
  const databases = new Set()
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!skipped(entry.name) && entry.isFile() && await sqliteFile(join(source, entry.name))) {
      databases.add(entry.name)
    }
  }
  if (!databases.size) throw new Error('no sqlite database in --dir')

  out = await intendedPath(resolve(out))
  if (contains(source, out)) throw new Error('--out must be outside the board directory')
  await mkdir(out, { recursive: true })
  const created = new Date()
  const partial = join(out, `.partial-${timestamp(created)}`)
  const complete = join(out, `backup-${timestamp(created)}`)
  await mkdir(partial)
  let files
  try {
    const dest = join(partial, 'files')
    await mkdir(dest)
    for (const path of databases) {
      try {
        await snapshot(join(source, path), join(dest, path))
        await integrityCheck(join(dest, path), path)
      } catch (error) {
        throw new Error(`snapshot ${path}: ${error.message}`)
      }
    }
    // The board writes attachments before committing a reference to them.
    await copyAttachments(source, dest, databases)
    files = []
    for await (const file of manifestFiles(dest)) files.push(file)
    await writeFile(join(partial, 'MANIFEST.json'), JSON.stringify({
      version: 1, created: created.toISOString(), files,
      databases: [...databases].map((path) => ({ path, integrity: 'ok' })),
    }, null, 2) + '\n')
    await rename(partial, complete)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
  console.log(`backup  ${complete}\ndatabases  ${databases.size}  files  ${files.length}`)
  if (keep !== undefined) await prune(out, keep, source)
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
