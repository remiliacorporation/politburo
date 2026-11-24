import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('../../../packages/board/dist/cli.mjs', import.meta.url))
const backup = fileURLToPath(new URL('../board-backup.mjs', import.meta.url))
const restore = fileURLToPath(new URL('../board-restore.mjs', import.meta.url))

function command(home, script, args, url) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: home, env: { HOME: home, BOARD_URL: url }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const done = once(child, 'close').then(([code]) => ({
    code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(),
  }))
  return { child, done }
}

async function ok(result) {
  const { code, stdout, stderr } = await result
  assert.equal(code, 0, stderr)
  return stdout
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'board-backup-test-'))
  const boards = []
  t.after(async () => {
    for (const { child, done } of boards) {
      child.kill()
      await done
    }
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'board')
  const out = join(home, 'backups')
  async function start(path) {
    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const { port } = listener.address()
    await new Promise((resolve) => listener.close(resolve))
    const run = command(home, cli, ['serve', '--no-inspect', '--port', String(port), '--dir', path])
    boards.push(run)
    return { ...run, url: `http://127.0.0.1:${port}/api/board` }
  }
  async function serve(path = dir) {
    const { url, child, done } = await start(path)
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) await ok(done)
      const response = await fetch(url, { signal: AbortSignal.timeout(250) }).catch(() => null)
      if (response) {
        await response.body?.cancel()
        if (response.status !== 503) return (...args) => ok(command(home, cli, args, url).done)
      }
      await sleep(20)
    }
    assert.fail('board did not come up')
  }
  return {
    dir, out, start, serve, home,
    async save(...args) {
      const result = await ok(command(home, backup, ['--dir', dir, '--out', out, ...args]).done)
      const match = /^backup  (.+)\ndatabases  \d+  files  \d+\n$/.exec(String(result))
      assert.ok(match, 'backup should print its directory and counts')
      return match[1]
    },
    load: (saved, target, ...args) => command(home, restore, ['--backup', saved, '--dir', target, ...args]).done,
  }
}

const post = async (board, text, ...args) => JSON.parse(await board('post', 'updates', text, ...args, '--json')).message.id
const thread = async (board, id) => JSON.parse(await board('read', id, '--json')).message

// Catches losing WAL messages or attachment bytes when backing up a board that is still posting.
test('online snapshot restores messages and a binary attachment', { timeout: 20000 }, async (t) => {
  const f = await fixture(t)
  const board = await f.serve()
  const bytes = Buffer.from([0, 9, 128, 255, 10, 0])
  const attachment = join(f.home, 'sample.bin')
  await writeFile(attachment, bytes)
  const texts = ['first message', 'with attachment', 'last before snapshot']
  const ids = [await post(board, texts[0]), await post(board, texts[1], '--attach', attachment), await post(board, texts[2])]
  const naive = join(f.home, 'naive')
  await mkdir(naive)
  await copyFile(join(f.dir, 'local.db'), join(naive, 'local.db'))
  const naiveBoard = await f.serve(naive)
  assert.doesNotMatch(String(await naiveBoard('read', '--json')), /last before snapshot/)

  let finished = false
  const during = []
  const writing = (async () => {
    for (let i = 0; !finished; i++) {
      const result = await board('post', ids[2], `overlapping message ${i}`, '--json')
      during.push(JSON.parse(result).message.id)
    }
  })()
  const saved = await f.save().finally(async () => {
    finished = true
    await writing
  })
  assert.ok(during.length > 0)
  const target = join(f.home, 'restored')
  await ok(f.load(saved, target))
  const restored = await f.serve(target)
  for (const [index, id] of ids.entries()) assert.equal((await thread(restored, id)).text, texts[index])
  const savedThread = JSON.parse(await restored('read', ids[2], '--json'))
  const savedReplies = savedThread.replies.map(({ id }) => id)
  assert.deepEqual(savedReplies, during.slice(0, savedReplies.length))
  const { attachments } = await thread(restored, ids[1])
  assert.deepEqual(await restored('download', attachments[0].id, '-'), bytes)
})

// Catches refusing an empty target, clobbering a non-empty one, or deleting the old directory.
test('non-empty target is refused or kept aside', { timeout: 20000 }, async (t) => {
  const f = await fixture(t)
  await f.serve()
  const saved = await f.save()
  const target = join(f.home, 'target')
  const original = Buffer.from([0, 128, 255])
  await mkdir(target)
  await writeFile(join(target, 'untouched'), original)
  const denied = await f.load(saved, target)
  assert.equal(denied.code, 1)
  assert.match(denied.stderr, /non-empty.*--replace/)
  assert.deepEqual(await readdir(target), ['untouched'])
  assert.deepEqual(await readFile(join(target, 'untouched')), original)
  const result = String(await ok(f.load(saved, target, '--replace')))
  const kept = result.match(/^kept  (.+)$/m)?.[1]
  assert.ok(kept?.startsWith(`${target}.replaced-`))
  assert.deepEqual(await readFile(join(kept, 'untouched')), original)
  assert.deepEqual(await readdir(target), ['local.db'])

  const empty = join(f.home, 'empty')
  await mkdir(empty)
  await ok(f.load(saved, empty))
  assert.deepEqual(await readdir(empty), ['local.db'])
})

// Catches replacing a directory while a real board still owns it.
test('a live target refuses even --replace', { timeout: 20000 }, async (t) => {
  const f = await fixture(t)
  const board = await f.serve()
  const id = await post(board, 'still here')
  const saved = await f.save()
  const denied = await f.load(saved, f.dir, '--replace')
  assert.equal(denied.code, 1)
  assert.match(denied.stderr, /a board is running there; stop it first/)
  assert.equal((await thread(board, id)).text, 'still here')
})

// Catches accepting a modified backup instead of verifying checksums before creating the target.
test('tampered manifest cannot be restored', { timeout: 20000 }, async (t) => {
  const f = await fixture(t)
  await f.serve()
  const saved = await f.save()
  const path = join(saved, 'MANIFEST.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.files[0].sha256 = '0'.repeat(64)
  await writeFile(path, JSON.stringify(manifest))
  const target = join(f.home, 'target')
  const denied = await f.load(saved, target)
  assert.equal(denied.code, 1)
  assert.match(denied.stderr, /sha256 mismatch/)
  await assert.rejects(lstat(target), { code: 'ENOENT' })
})

// Catches a backup that interferes with the running board or its exclusive directory lock.
test('backup leaves the live board responsive and its lock held', { timeout: 20000 }, async (t) => {
  const f = await fixture(t)
  const board = await f.serve()
  await f.save()
  const id = await post(board, 'still writing')
  assert.equal((await thread(board, id)).text, 'still writing')
  const { child, done } = await f.start(f.dir)
  const denied = await Promise.race([done, once(child.stdout, 'data').then(() => null)])
  assert.ok(denied, 'second board started on a directory the first board owns')
  assert.equal(denied.code, 1)
  assert.match(denied.stderr, /another process owns this board's directory/)
})
