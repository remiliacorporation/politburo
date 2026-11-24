import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { installNoClobber } from '../board-restore.mjs'

const backupCli = fileURLToPath(new URL('../board-backup.mjs', import.meta.url))
const restoreCli = fileURLToPath(new URL('../board-restore.mjs', import.meta.url))
const pageSize = 4096

function command(script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 })
  if (result.error) throw result.error
  return result
}

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'restore-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return realpath(root)
}

async function fixture(t) {
  const root = await scratch(t)
  const dir = join(root, 'source')
  const out = join(root, 'backups')
  const target = join(root, 'target')
  await mkdir(join(dir, 'data'), { recursive: true })
  await writeFile(join(dir, 'data', 'sample.txt'), 'sample')
  await writeFile(join(dir, 'metadata.txt'), 'metadata')
  const db = new DatabaseSync(join(dir, 'local.db'))
  try {
    db.exec(`pragma page_size = ${pageSize}; create table items (value blob); begin`)
    const insert = db.prepare('insert into items values (zeroblob(1800))')
    for (let i = 0; i < 24; i++) insert.run()
    db.exec('commit')
  } finally {
    db.close()
  }
  const saved = command(backupCli, '--dir', dir, '--out', out)
  assert.equal(saved.status, 0, saved.stderr)
  const backup = /^backup  (.+)$/m.exec(saved.stdout)?.[1]
  assert.ok(backup, 'backup should print its directory')
  return {
    root, target, backup,
    restore: () => command(restoreCli, '--backup', backup, '--dir', target),
  }
}

async function updateBackup(backup, entries) {
  const manifestPath = join(backup, 'MANIFEST.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const [path, bytes] of entries) {
    await writeFile(join(backup, 'files', path), bytes)
    manifest.files = manifest.files.filter((entry) => entry.path !== path)
    manifest.files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
}

async function assertNoLitter(root) {
  assert.deepEqual((await readdir(root)).filter((name) => /\.(restoring|replaced)-/.test(name)), [])
}

// Catches accepting two paths that would overwrite each other on a case-insensitive volume.
test('restore refuses case-colliding manifest paths', async (t) => {
  const f = await fixture(t)
  // Identical bytes keep both checksums valid even if these paths alias on disk.
  const bytes = Buffer.from('note')
  await updateBackup(f.backup, [['data/Note.txt', bytes], ['data/note.txt', bytes]])
  const result = f.restore()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /^error: backup has two entries that differ only by case: data\/Note\.txt, data\/note\.txt$/m)
  await assert.rejects(lstat(f.target), { code: 'ENOENT' })
  await assertNoLitter(f.root)
})

// Catches installing a corrupt staged database whose manifest checksum still matches.
test('restore checks SQLite integrity after staging', async (t) => {
  const f = await fixture(t)
  const bytes = await readFile(join(f.backup, 'files', 'local.db'))
  const page = Math.floor(bytes.length / (2 * pageSize)) * pageSize
  bytes.fill(0xff, page, page + 64)
  await updateBackup(f.backup, [['local.db', bytes]])
  const result = f.restore()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /^error: integrity check failed for local\.db:/m)
  await assert.rejects(lstat(f.target), { code: 'ENOENT' })
  await assertNoLitter(f.root)
})

// Catches renaming over an existing directory instead of installing only at a vacant path.
test('installNoClobber preserves an existing empty directory', async (t) => {
  const root = await scratch(t)
  const stage = join(root, 'stage')
  const target = join(root, 'target')
  await mkdir(stage)
  await mkdir(target)
  await writeFile(join(stage, 'file'), 'staged bytes')
  await assert.rejects(installNoClobber(stage, target), /target already exists/)
  assert.deepEqual(await readdir(target), [])
  assert.equal(await readFile(join(stage, 'file'), 'utf8'), 'staged bytes')

  const absent = join(root, 'absent')
  await installNoClobber(stage, absent)
  assert.equal(await readFile(join(absent, 'file'), 'utf8'), 'staged bytes')
  await assert.rejects(lstat(stage), { code: 'ENOENT' })
})

// Catches refusing an empty target or needlessly keeping its old directory aside.
test('restore into an empty target succeeds without litter', async (t) => {
  const f = await fixture(t)
  await mkdir(f.target)
  const result = f.restore()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `restored  ${f.target}\n`)
  assert.equal(await readFile(join(f.target, 'data', 'sample.txt'), 'utf8'), 'sample')
  await assertNoLitter(f.root)
})

// Catches replacing or modifying a non-empty target without --replace.
test('restore leaves a non-empty target untouched without --replace', async (t) => {
  const f = await fixture(t)
  const original = Buffer.from([0, 128, 255])
  await mkdir(f.target)
  await writeFile(join(f.target, 'untouched'), original)
  const result = f.restore()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /^error: target is non-empty; use --replace/m)
  assert.deepEqual(await readdir(f.target), ['untouched'])
  assert.deepEqual(await readFile(join(f.target, 'untouched')), original)
  await assertNoLitter(f.root)
})
