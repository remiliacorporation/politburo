// Usage: node tools/host/board-backup.mjs --dir <board> --out <backups> [--keep N]
// One --out directory per board. Backups serialize on its .publish.lock.
// --keep N prunes older backups only when their token, directory identity, and
// MANIFEST.json digest match the local .backup-index.json. An unreadable index
// disables pruning. Prune never deletes in place: it renames a candidate to
// .pruning-<uuid>, verifies that directory, and deletes only the verified files
// and directories. A leftover .pruning-* directory from a crash is never
// deleted by the tool (a person removes it).
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile,
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
    const path = prefix + entry.name
    if (entry.isDirectory()) {
      await copyAttachments(from, dest, databases, `${path}/`)
    } else if (entry.isFile()) {
      const to = join(dest, path)
      await mkdir(dirname(to), { recursive: true })
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
  // The lock is an open `begin exclusive` transaction on a separate file; the OS drops
  // it if the process dies. Never unlink the file. Stay in normal locking mode: in
  // exclusive mode a failed attempt keeps its shared lock, so two waiting processes
  // would each hold one and neither could ever upgrade. Poll with non-blocking attempts.
  const path = join(out, '.publish.lock')
  const stat = await statIfPresent(path)
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('invalid publish lock file')
  const db = new DatabaseSync(path)
  const deadline = Date.now() + 10 * 60 * 1000
  try {
    db.exec('pragma busy_timeout = 0')
    for (;;) {
      try {
        db.exec('begin exclusive')
        return db
      } catch (error) {
        if (error.code !== 'ERR_SQLITE_ERROR' || (error.errcode & 0xff) !== 5) throw error
        if (Date.now() >= deadline) throw new Error('another backup of this board is running')
        await sleep(25 + Math.floor(Math.random() * 100))
      }
    }
  } catch (error) {
    db.close()
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
    for (const { name, token, dev, ino, manifest } of backups) {
      if (typeof name !== 'string' || !BACKUP_NAME.test(name) ||
          typeof token !== 'string' || !token || index.has(name)) throw new Error('invalid entry')
      if (manifest !== undefined && (typeof manifest !== 'string' || !/^[a-f0-9]{64}$/.test(manifest))) {
        throw new Error('invalid manifest digest')
      }
      index.set(name, { name, token, dev, ino, manifest })
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

async function filesMatchListed(root, listed) {
  const remaining = new Map(listed)
  const parents = new Set()
  for (const path of remaining.keys()) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) parents.add(segments.slice(0, i).join('/'))
  }
  const files = []
  const dirs = []
  async function walk(dir, prefix) {
    for (const name of await readdir(dir)) {
      const rel = prefix + name
      const path = join(dir, name)
      const info = await lstat(path)
      if (info.isDirectory()) {
        if (!parents.has(rel)) return false
        if (!await walk(path, `${rel}/`)) return false
        dirs.push(rel) // Children must be removed before their parents.
      } else if (info.isFile()) {
        const entry = remaining.get(rel)
        if (!entry) return false
        const got = await digest(path)
        if (got.size !== entry.size || got.sha256 !== entry.sha256) return false
        files.push(rel)
        remaining.delete(rel)
      } else {
        return false
      }
    }
    return true
  }
  if (!await walk(root, '') || remaining.size !== 0) return false
  return { files, dirs }
}

async function quarantineVerified(dir, { token, dev, ino, manifest: expectedDigest }) {
  try {
    const stat = await lstat(dir, { bigint: true })
    if (!stat.isDirectory() || String(stat.dev) !== dev || String(stat.ino) !== ino) return false
    const names = await readdir(dir)
    if (names.length !== 2 || !names.includes('MANIFEST.json') || !names.includes('files')) return false
    const manifestPath = join(dir, 'MANIFEST.json')
    if (!(await lstat(manifestPath)).isFile()) return false
    const bytes = await readFile(manifestPath)
    if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) return false
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (manifest.version !== 1 || manifest.token !== token || !Array.isArray(manifest.files)) return false
    const listed = new Map()
    for (const file of manifest.files) {
      if (typeof file?.path !== 'string' || typeof file.size !== 'number' || typeof file.sha256 !== 'string') {
        return false
      }
      const segments = file.path.split('/')
      if (isAbsolute(file.path) || segments.some((part) => !part || part === '.' || part === '..')) return false
      if (listed.has(file.path)) return false
      listed.set(file.path, file)
    }
    const files = join(dir, 'files')
    if (!(await lstat(files)).isDirectory()) return false
    const matched = await filesMatchListed(files, listed)
    if (!matched) return false
    return {
      files: ['MANIFEST.json', ...matched.files.map((path) => `files/${path}`)],
      dirs: [...matched.dirs.map((path) => `files/${path}`), 'files'],
    }
  } catch {
    return false
  }
}

// The only prune deletion: unlink verified files, then rmdir verified directories.
async function rmVerifiedQuarantine(dir, verified) {
  for (const path of verified.files) await unlink(join(dir, path))
  for (const path of verified.dirs) await rmdir(join(dir, path))
  await rmdir(dir)
}

async function prune(out, keep, source, index, current, hooks) {
  const backups = [current]
  for (const [name, entry] of index) {
    const dir = join(out, name)
    if (name !== current && entry.manifest && !contains(dir, source) && await matchesBackup(dir, entry)) {
      backups.push(name)
    }
  }
  // The next publish drops entries for deleted directories. All syncs precede deletion.
  for (const name of backups.sort().reverse().slice(keep)) {
    if (name === current) continue
    const entry = index.get(name)
    const dir = join(out, name)
    if (!await matchesBackup(dir, entry)) continue
    const quarantined = `.pruning-${randomUUID()}`
    const holding = join(out, quarantined)
    try {
      await rename(dir, holding)
    } catch {
      continue
    }
    const verified = await quarantineVerified(holding, entry)
    await hooks.afterQuarantine?.({ dir, holding })
    if (verified) {
      try {
        await rmVerifiedQuarantine(holding, verified)
        index.delete(name)
      } catch (error) {
        if (error.code !== 'ENOTEMPTY') throw error
        console.error(`warning: backup ${name} changed during pruning; left at ${quarantined}`)
      }
    } else {
      let left = quarantined
      try {
        // Reserve the name exclusively so rename cannot replace a directory that appeared.
        await mkdir(dir, { mode: 0o700 })
        await rename(holding, dir)
        left = undefined
      } catch {}
      console.error(`warning: backup ${name} did not verify; not deleted${
        left ? `; left at ${left}` : ''}`)
    }
  }
}

async function assertSameBoard(source, identity, requested) {
  const now = await statIfPresent(source, { bigint: true })
  if (!now?.isDirectory() || now.dev !== identity.dev || now.ino !== identity.ino) {
    throw new Error('board directory changed during the backup; retry')
  }
  let resolved
  try {
    resolved = await realpath(requested)
  } catch {
    throw new Error('board directory changed during the backup; retry')
  }
  if (resolved !== source) {
    throw new Error('board directory changed during the backup; retry')
  }
}

async function publishBackup(source, out, keep, identity, hooks, requested) {
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
  let manifest
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
    await hooks.afterSnapshots?.()
    await assertSameBoard(source, identity, requested)
    // The board writes attachments before committing a reference to them.
    await copyAttachments(source, dest, databases)
    files = []
    for await (const file of manifestFiles(dest)) files.push(file)
    const manifestBytes = Buffer.from(JSON.stringify({
      version: 1, token, created: created.toISOString(), files,
      databases: [...databases].map((path) => ({ path, integrity: 'ok' })),
    }, null, 2) + '\n')
    await writeFile(join(partial, 'MANIFEST.json'), manifestBytes)
    manifest = createHash('sha256').update(manifestBytes).digest('hex')
    synced = await syncPath(partial, true)
    await hooks.beforePublish?.()
    await assertSameBoard(source, identity, requested)
    await rename(partial, complete)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
  console.log(`backup  ${complete}\ndatabases  ${databases.size}  files  ${files.length}`)
  if (synced && index) {
    // A crash between rename and indexing leaves a backup that cannot be pruned.
    const { dev, ino } = await lstat(complete, { bigint: true })
    index.set(name, { name, token, dev: String(dev), ino: String(ino), manifest })
    synced = await writeIndex(out, index)
  }
  if (synced) synced = await syncPath(out)
  if (!synced) console.error('warning: backup not synced; nothing pruned')
  else if (index && keep !== undefined) await prune(out, keep, source, index, name, hooks)
}

// Test seam: hooks.afterSnapshots and hooks.beforePublish are awaited at those
// points so a test can swap the board directory or retarget a --dir symlink.
// hooks.afterQuarantine is awaited after checking a quarantined candidate,
// before deletion or rollback, so a test can add a file or recreate
// the original name. The CLI does not pass hooks.
export async function makeBackup(dir, out, keep, hooks = {}) {
  const source = await realpath(dir)
  const identity = await lstat(source, { bigint: true })
  out = await intendedPath(resolve(out))
  if (contains(source, out)) throw new Error('--out must be outside the board directory')
  await mkdir(out, { recursive: true })
  const lock = await lockPublisher(out)
  try {
    await publishBackup(source, out, keep, identity, hooks, dir)
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
