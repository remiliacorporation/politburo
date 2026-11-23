import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { makeBackup } from '../board-backup.mjs'

const warningListeners = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.startsWith('SQLite ')) return
  for (const listener of warningListeners) listener.call(process, warning)
})

const backup = fileURLToPath(new URL('../board-backup.mjs', import.meta.url))
const manifestPath = (dir) => join(dir, 'MANIFEST.json')

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'backup-retention-test-'))
  const dir = join(home, 'board')
  const out = join(home, 'backups')
  const index = join(out, '.backup-index.json')
  const runs = []
  t.after(async () => {
    for (const { child, done } of runs) {
      child.kill()
      await done
    }
    await rm(home, { recursive: true, force: true })
  })
  await mkdir(out)
  await mkdir(dir)
  const db = new DatabaseSync(join(dir, 'sample.db'))
  try {
    db.exec('create table sample (value integer); insert into sample values (42)')
  } finally {
    db.close()
  }
  function start(...args) {
    const child = spawn(process.execPath, [backup, '--dir', dir, '--out', out, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const done = once(child, 'close').then(([code]) => {
      assert.equal(code, 0, stderr)
      const match = /^backup  (.+)\ndatabases  1  files  1\n$/.exec(stdout)
      assert.ok(match, stdout)
      return { path: match[1], stderr }
    })
    // Allow a test to inspect a running command before awaiting its result.
    done.catch(() => {})
    const run = { child, done }
    runs.push(run)
    return run
  }
  return { dir, out, index, start, save: (...args) => start(...args).done }
}

const published = async (out) => (await readdir(out)).filter((name) => name.startsWith('backup-'))
const pruning = async (out) => (await readdir(out)).filter((name) => name.startsWith('.pruning-'))

async function swapBoard(dir) {
  await rename(dir, `${dir}.aside`)
  await mkdir(dir)
  const db = new DatabaseSync(join(dir, 'sample.db'))
  try {
    db.exec('create table sample (value integer); insert into sample values (99)')
  } finally {
    db.close()
  }
}

// Catches pruning by name and manifest alone, even when the manifest is an exact copy.
test('--keep prunes only older backups registered at their own names', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const { path: older } = await f.save()
  const manifest = await readFile(manifestPath(older))
  assert.ok(JSON.parse(manifest).token, 'the backup has an ownership marker')
  const copy = join(f.out, 'backup-2000-01-01T00-00-00.000Z')
  await mkdir(copy)
  await writeFile(manifestPath(copy), manifest)
  await mkdir(join(f.out, 'backup-incomplete'))
  await mkdir(join(f.out, 'other-directory'))
  await writeFile(join(f.out, 'other-directory', 'MANIFEST.json'), '{}')
  await writeFile(join(f.out, 'backup-note'), 'keep me')
  for (const name of ['backup-000', 'backup-manual']) {
    await mkdir(join(f.out, name))
    await writeFile(manifestPath(join(f.out, name)), '{}')
  }

  const { path: newest } = await f.save('--keep', '1')
  await assert.rejects(lstat(older), { code: 'ENOENT' })
  assert.deepEqual(await readFile(manifestPath(copy)), manifest, 'unindexed copy should survive')
  assert.deepEqual((await readdir(f.out)).filter((name) => !name.startsWith('.')).sort(), [
    basename(newest), basename(copy),
    'backup-000', 'backup-incomplete', 'backup-manual', 'backup-note', 'other-directory',
  ].sort())
  assert.equal(await readFile(join(f.out, 'backup-note'), 'utf8'), 'keep me')
  const { token } = JSON.parse(await readFile(manifestPath(newest), 'utf8'))
  assert.notEqual(token, JSON.parse(manifest).token)
  const { dev, ino } = await lstat(newest, { bigint: true })
  const index = JSON.parse(await readFile(f.index, 'utf8'))
  assert.equal(index.version, 1)
  assert.deepEqual(index.backups.find(({ name }) => name === basename(newest)), {
    name: basename(newest), token, dev: String(dev), ino: String(ino),
  })
  assert.equal((await lstat(f.index)).mode & 0o777, 0o600)
})

// Catches pruning a copied backup at its original name based on the name and token alone.
test('--keep preserves a copied backup put back at its original name', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const { path: original } = await f.save()
  const { path: genuine } = await f.save()
  const copy = join(f.out, 'copy')
  const manifest = await readFile(manifestPath(original))
  await cp(original, copy, { recursive: true })
  await rm(original, { recursive: true })
  await rename(copy, original)

  await f.save('--keep', '1')
  assert.deepEqual(await readFile(manifestPath(original)), manifest, 'copy should survive at its original name')
  await assert.rejects(lstat(genuine), { code: 'ENOENT' })
})

// Catches pruning a legacy index entry with a matching token but no verifiable directory identity.
test('--keep preserves a backup indexed without directory identity', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const { path: older } = await f.save()
  const { path: genuine } = await f.save()
  const index = JSON.parse(await readFile(f.index, 'utf8'))
  const entry = index.backups.find(({ name }) => name === basename(older))
  delete entry.dev
  delete entry.ino
  await writeFile(f.index, JSON.stringify(index))
  const manifest = await readFile(manifestPath(older))

  await f.save('--keep', '1')
  assert.deepEqual(await readFile(manifestPath(older)), manifest, 'legacy backup should survive')
  await assert.rejects(lstat(genuine), { code: 'ENOENT' })
})

// Catches pruning an indexed directory whose current manifest does not match its registered token.
test('--keep preserves a backup with a replaced manifest token', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const { path: older } = await f.save()
  const path = manifestPath(older)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.token = 'changed'
  const changed = JSON.stringify(manifest)
  await writeFile(path, changed)
  await f.save('--keep', '1')
  assert.equal(await readFile(path, 'utf8'), changed)
})

// Catches publishing while another process owns the lock or racing concurrent --keep runs.
test('overlapping backups wait and publish one complete retained backup', { timeout: 30000 }, async (t) => {
  const f = await fixture(t)
  const lock = new DatabaseSync(join(f.out, '.publish.lock'))
  let first
  try {
    lock.exec('pragma locking_mode = exclusive; begin exclusive; commit')
    first = f.start('--keep', '1')
    await sleep(1500)
    assert.deepEqual(await published(f.out), [], 'published before the lock was released')
    assert.equal(first.child.exitCode, null, 'backup exited while the lock was held')
    assert.equal(first.child.signalCode, null)
  } finally {
    lock.close()
  }
  const { path } = await first.done
  assert.deepEqual(await published(f.out), [basename(path)])

  // Three at once, several rounds: an exclusive-mode lock that keeps its shared lock on a
  // failed attempt deadlocks them in a fraction of rounds, and the test times out.
  for (let round = 0; round < 30; round++) {
    const saves = await Promise.all([1, 2, 3].map(() => f.start('--keep', '1').done))
    const names = await published(f.out)
    assert.equal(names.length, 1)
    assert.ok(saves.some(({ path }) => basename(path) === names[0]), 'retained a new backup')
  }
  const retained = join(f.out, (await published(f.out))[0])
  const manifest = JSON.parse(await readFile(manifestPath(retained), 'utf8'))
  const bytes = await readFile(join(retained, 'files', 'sample.db'))
  assert.deepEqual(manifest.files, [{
    path: 'sample.db', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  }])
})

// Catches overwriting an unreadable index or guessing which backups to prune without it.
test('a malformed index warns, remains untouched, and does not block publication', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const { path: older } = await f.save()
  const malformed = Buffer.from('{"version": 1, "backups": [\n')
  await writeFile(f.index, malformed)
  const { path: newer, stderr } = await f.save('--keep', '1')
  assert.match(stderr, /^warning: backup index unreadable; nothing pruned$/m)
  assert.notEqual(newer, older)
  assert.deepEqual((await published(f.out)).sort(), [basename(older), basename(newer)].sort())
  assert.ok(malformed.equals(await readFile(f.index)), 'malformed index bytes changed')
})

// Catches pruning an indexed directory whose identity matches but whose files do not.
test('--keep keeps an indexed backup that gained an extra file and prunes a genuine older one', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const { path: tampered } = await f.save()
  const { path: genuine } = await f.save()
  await writeFile(join(tampered, 'files', 'extra.txt'), 'extra')
  const { path: newest, stderr } = await f.save('--keep', '1')
  assert.ok(
    stderr.split('\n').includes(`warning: backup ${basename(tampered)} did not verify; not deleted`),
    stderr,
  )
  assert.doesNotMatch(stderr, /left at/)
  assert.equal(await readFile(join(tampered, 'files', 'extra.txt'), 'utf8'), 'extra')
  await assert.rejects(lstat(genuine), { code: 'ENOENT' })
  assert.deepEqual((await published(f.out)).sort(), [basename(tampered), basename(newest)].sort())
  assert.deepEqual(await pruning(f.out), [])
})

// Catches leaving a .pruning-* directory in --out after a successful prune.
test('--keep leaves no .pruning-* directory after a normal prune', { timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const { path: older } = await f.save()
  const { path: newest } = await f.save('--keep', '1')
  await assert.rejects(lstat(older), { code: 'ENOENT' })
  assert.ok((await published(f.out)).includes(basename(newest)))
  assert.deepEqual(await pruning(f.out), [])
})

// Catches publishing a backup whose databases and attachments come from different directories.
test('a swapped board directory is not published', { timeout: 15000 }, async (t) => {
  for (const hook of ['afterSnapshots', 'beforePublish']) {
    const f = await fixture(t)
    const { path: prior } = await f.save()
    const index = await readFile(f.index)
    await assert.rejects(
      () => makeBackup(f.dir, f.out, undefined, { [hook]: () => swapBoard(f.dir) }),
      { message: 'board directory changed during the backup; retry' },
    )
    assert.deepEqual(await published(f.out), [basename(prior)])
    assert.deepEqual((await readdir(f.out)).filter((name) => name.startsWith('.partial-')), [])
    assert.ok(index.equals(await readFile(f.index)), `index changed after ${hook}`)
  }
})
