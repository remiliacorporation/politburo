import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import {
  contains, digest, integrityCheck, intendedPath, privateCopy, runCli, skipped, sqliteFile,
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
  const listed = new Set()
  const databases = new Set()
  for (const entry of manifest.files) {
    const file = await regularFile(files, entry?.path)
    if (listed.has(entry.path)) throw new Error(`duplicate file in manifest: ${entry.path}`)
    listed.add(entry.path)
    await verifyFile(file, entry)
    if (!entry.path.includes('/') && await sqliteFile(file)) databases.add(entry.path)
  }
  for (const entry of manifest.databases) {
    if (!databases.delete(entry?.path) || entry.integrity !== 'ok') {
      throw new Error('invalid database entry in manifest')
    }
    await integrityCheck(join(files, entry.path), entry.path)
  }
  if (databases.size) throw new Error('backup contains a database not listed in the manifest')
  return manifest.files
}

async function lockTarget(dir, replace, expected) {
  const path = join(dir, '.lock')
  const info = await statIfPresent(path)
  const nonEmpty = () => new Error('target is non-empty; use --replace or a different --dir')
  // A live board must already have a lock file. Do not create one in a
  // non-empty directory that we would reject anyway.
  if (!info && !replace && (await readdir(dir)).length) throw nonEmpty()
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
    if (!replace && (info || (await readdir(dir)).some((name) => name !== '.lock' && name !== '.lock-journal'))) {
      throw nonEmpty()
    }
    return db
  } catch (error) {
    db.close()
    if (error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) === 5) {
      throw new Error('a board is running there; stop it first')
    }
    throw error
  }
}

async function restore({ backup, dir, replace }) {
  backup = await realpath(backup)
  const files = await verifyBackup(backup)
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
      await privateCopy(await regularFile(join(backup, 'files'), entry.path), to)
      await verifyFile(to, entry)
    }
    const info = await statIfPresent(target)
    if (info) {
      if (!info.isDirectory()) throw new Error('target is not a directory')
      lock = await lockTarget(target, replace, info)
      if (await statIfPresent(aside)) throw new Error('cannot keep old directory: replacement path exists')
      await rename(target, aside)
      kept = true
    }
    try {
      await rename(stage, target)
    } catch (error) {
      // Do not overwrite a directory another process has created in the gap.
      if (kept && !await statIfPresent(target)) await rename(aside, target)
      throw new Error(`cannot install restore: ${error.message}${kept && await statIfPresent(aside) ? `; old directory kept at ${aside}` : ''}`)
    }
  } finally {
    lock?.close()
    await rm(stage, { recursive: true, force: true })
  }
  console.log(`restored  ${target}`)
  if (kept) console.log(`kept  ${aside}`)
}

await runCli({ backup: { type: 'string' }, dir: { type: 'string' }, replace: { type: 'boolean' } },
  ['backup', 'dir'], restore)
