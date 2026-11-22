import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import {
  contains, digest, integrityCheck, intendedPath, runCli, skipped, sqliteFile,
  statIfPresent, timestamp,
} from './board-backup.mjs'

function parts(path) {
  if (typeof path !== 'string' || isAbsolute(path) || win32.isAbsolute(path) || /[\\\0]/.test(path)) {
    throw new Error('invalid path in manifest')
  }
  const segments = path.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..' || skipped(part))) {
    throw new Error(`invalid path in manifest: ${path}`)
  }
  return segments
}

async function regularFile(root, path) {
  const segments = parts(path)
  let file = root
  for (const [index, part] of segments.entries()) {
    file = join(file, part)
    const info = await lstat(file)
    if (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`not a regular backup file: ${path}`)
    }
  }
  return file
}

async function verifyFile(file, entry) {
  const { size, sha256 } = await digest(file)
  if (size !== entry.size || sha256 !== entry.sha256) {
    throw new Error(`size or sha256 mismatch: ${entry.path}`)
  }
}

async function verifyBackup(backup) {
  const manifestPath = await regularFile(backup, 'MANIFEST.json')
  const text = await readFile(manifestPath, 'utf8')
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error('invalid json in MANIFEST.json')
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.databases) || !manifest.databases.length) {
    throw new Error('invalid backup manifest: expected version 1 with files and databases')
  }
  const files = join(backup, 'files')
  if (!(await lstat(files)).isDirectory()) throw new Error('backup files is not a directory')
  const listed = new Map()
  for (const entry of manifest.files) {
    const path = entry?.path
    parts(path)
    // Compare NFC-normalized paths in lowercase on every platform.
    const folded = path.normalize('NFC').toLowerCase()
    const previous = listed.get(folded)
    if (previous === path) throw new Error(`duplicate file in manifest: ${path}`)
    if (previous !== undefined) {
      throw new Error(`backup has two entries that differ only by case: ${previous}, ${path}`)
    }
    listed.set(folded, path)
  }
  const databases = new Set()
  for (const entry of manifest.files) {
    const file = await regularFile(files, entry.path)
    await verifyFile(file, entry)
    if (!entry.path.includes('/') && await sqliteFile(file)) databases.add(entry.path)
  }
  for (const entry of manifest.databases) {
    if (!databases.delete(entry?.path) || entry.integrity !== 'ok') {
      throw new Error('invalid database entry in manifest')
    }
  }
  if (databases.size) throw new Error('backup contains a database not listed in the manifest')
  return { files: manifest.files, databases: new Set(manifest.databases.map((entry) => entry.path)) }
}

async function lockTarget(dir, replace, expected) {
  const path = join(dir, '.lock')
  const info = await statIfPresent(path)
  const nonEmpty = () => new Error('target is non-empty; use --replace or a different --dir')
  // A live board must already have a lock file. Do not create one in a
  // non-empty directory that we would reject anyway.
  if (!info && !replace) throw nonEmpty()
  if (info && !info.isFile()) throw new Error('target .lock is not a regular file')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('pragma busy_timeout = 0; pragma locking_mode = exclusive; begin exclusive; commit')
    const current = await lstat(dir)
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error('target directory changed while locking it; retry the restore')
    }
    // A stopped board's old lock files are not board data, but they still
    // make the directory non-empty for the purposes of requiring --replace.
    if (!replace) throw nonEmpty()
    return db
  } catch (error) {
    db.close()
    if (error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) === 5) {
      throw new Error('a board is running there; stop it first')
    }
    throw error
  }
}

const targetConflict = (error) => ['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error.code)

export async function installNoClobber(stage, target) {
  try {
    // Reserve the name exclusively. Rename can replace the reservation only while it is empty.
    await mkdir(target, { mode: 0o700 })
    await rename(stage, target)
  } catch (error) {
    if (!targetConflict(error)) throw error
    throw Object.assign(new Error(`target already exists: ${target}`, { cause: error }), { code: 'EEXIST' })
  }
}

async function restore({ backup, dir, replace }) {
  backup = await realpath(backup)
  const { files, databases } = await verifyBackup(backup)
  const requested = resolve(dir)
  const target = join(await intendedPath(dirname(requested)), basename(requested))
  if (contains(target, backup) || contains(backup, target)) {
    throw new Error('--backup and --dir must not overlap')
  }
  await mkdir(dirname(target), { recursive: true })
  const stamp = timestamp()
  const stage = `${target}.restoring-${stamp}`
  const aside = `${target}.replaced-${stamp}`
  let kept = false
  let lock
  await mkdir(stage)
  try {
    for (const entry of files) {
      const to = join(stage, entry.path)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(await regularFile(join(backup, 'files'), entry.path), to, constants.COPYFILE_EXCL)
      await chmod(to, 0o600)
      await verifyFile(to, entry)
    }
    // Check the completed stage before making any changes at the target.
    for (const path of databases) await integrityCheck(join(stage, path), path)

    const info = await statIfPresent(target)
    if (info) {
      if (!info.isDirectory()) throw new Error('target is not a directory')
      if ((await readdir(target)).length === 0) {
        await rmdir(target)
      } else {
        lock = await lockTarget(target, replace, info)
        if (await statIfPresent(aside)) throw new Error('cannot keep old directory: replacement path exists')
        await rename(target, aside)
        kept = true
      }
    }
    try {
      await installNoClobber(stage, target)
    } catch (error) {
      if (!kept) throw error
      const appeared = () => new Error(`target appeared during restore; the old directory is kept at ${aside}`)
      if (error.code === 'EEXIST') throw appeared()
      if (!await statIfPresent(target)) {
        try {
          await installNoClobber(aside, target)
          kept = false
        } catch (rollbackError) {
          if (rollbackError.code === 'EEXIST') throw appeared()
          throw new Error(`cannot put the old directory back: ${rollbackError.message}; kept at ${aside}`)
        }
      }
      throw new Error(`cannot install restore: ${error.message}${kept ? `; old directory kept at ${aside}` : ''}`)
    }
  } finally {
    lock?.close()
    await rm(stage, { recursive: true, force: true })
  }
  console.log(`restored  ${target}`)
  if (kept) console.log(`kept  ${aside}`)
}

if (import.meta.main) {
  await runCli({ backup: { type: 'string' }, dir: { type: 'string' }, replace: { type: 'boolean' } },
    ['backup', 'dir'], restore)
}
