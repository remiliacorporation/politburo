// Runs the decisions tool against a real `vb serve` board in a temporary directory. Nothing of the
// board's is faked: the tool calls the built CLI, as it does in use. Build first:
// `pnpm --filter @vercel/board build`, then `node --test tools/decisions/`.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', '..', 'packages', 'board', 'dist', 'cli.mjs')
const tool = join(here, 'decisions.mjs')

let dir
let server
let env

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
    probe.on('error', reject)
  })

/** Runs the tool. Answers its exit code and output, and never throws for a refusal. */
async function decisions(args, extra = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [tool, ...args], { env: { ...env, ...extra } })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const vb = async (...args) => (await run(process.execPath, [cli, ...args], { env })).stdout

/** Waits until `check` answers something, or fails after `ms`. */
async function until(check, ms = 10_000) {
  const end = Date.now() + ms
  for (;;) {
    const found = await check()
    if (found) return found
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'decisions-test-'))
  const port = await freePort()
  env = {
    PATH: process.env.PATH,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, 'config'),
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    BOARD_URL: `http://127.0.0.1:${port}/api/board`,
    DECISIONS_STATE_DIR: join(dir, 'state'),
    DECISIONS_ANSWERS_DIR: join(dir, 'answers'),
  }
  server = spawn(process.execPath, [cli, 'serve', '--port', String(port), '--dir', join(dir, 'data'), '--no-open', '--no-inspect'], { env, stdio: 'ignore' })
  await until(() => fetch(env.BOARD_URL).then((response) => response.ok, () => false))
})

after(async () => {
  server?.kill()
  await rm(dir, { recursive: true, force: true })
})

test('an ask repeated with the same key is one decision', async () => {
  const first = await decisions(['ask', '--key', 'ask-1', '--summary', 'Pick a push path', '--needs', 'owner', '--urgency', 'p1'])
  const again = await decisions(['ask', '--key', 'ask-1', '--summary', 'Pick a push path', '--needs', 'owner', '--urgency', 'p1'])
  assert.equal(first.code, 0, first.stderr)
  assert.equal(again.stdout, first.stdout)
  const listed = await decisions(['open'])
  assert.equal(listed.stdout.split('\n').filter((line) => line.includes('Pick a push path')).length, 1)
  assert.match(listed.stdout, new RegExp(`#${first.stdout}\\s+open \\d+m\\s+owner\\s+Pick a push path`))
})

test('an answer applies once, and the decision leaves the open list', async () => {
  const { stdout: id } = await decisions(['ask', '--key', 'ask-2', '--summary', 'Raise the spending limit?', '--needs', 'owner'])
  const first = await decisions(['answer', id, 'yes, raise it'])
  assert.equal(first.code, 0, first.stderr)
  const second = await decisions(['answer', id, 'no, wait'])
  assert.equal(second.code, 1)
  assert.match(second.stderr, /not an open decision/)
  const thread = await vb('read', id)
  assert.match(thread, /yes, raise it/)
  assert.doesNotMatch(thread, /no, wait/)
  assert.doesNotMatch((await decisions(['open'])).stdout, /Raise the spending limit/)
})

test('watch notifies for a new decision and records its answer', async () => {
  const seen = join(dir, 'notified')
  await writeFile(seen, '')
  const watching = spawn(process.execPath, [tool, 'watch', '--timeout', '30s'], {
    env: { ...env, DECISIONS_STATE_DIR: join(dir, 'watch-state'), DECISIONS_NOTIFY: `printf '%s|%s|%s\\n' "$DECISION_ID" "$DECISION_NEEDS" "$DECISION_TITLE" >> '${seen}'` },
    stdio: 'ignore',
  })
  try {
    // The watch is following once it has kept a cursor.
    await until(() => readFile(join(dir, 'watch-state', 'cursor'), 'utf8').then((text) => text.trim() !== '', () => false))
    const { stdout: id } = await decisions(['ask', '--key', 'ask-3', '--summary', 'Route the task to another model?', '--needs', 'owner'])
    await until(async () => (await readFile(seen, 'utf8')).includes(`${id}|owner|Route the task to another model?`))
    // A reply is not a new decision.
    await vb('reply', id, 'more context', '--no-sync')
    await decisions(['answer', id, 'option 2'])
    const record = JSON.parse(await until(() => readFile(join(dir, 'answers', 'ask-3.json'), 'utf8').catch(() => null)))
    assert.equal(record.key, 'ask-3')
    assert.equal(record.id, id)
    assert.equal(record.answer, 'option 2')
    assert.equal((await readFile(seen, 'utf8')).split('\n').filter((line) => line.startsWith(`${id}|`)).length, 1)
  } finally {
    watching.kill()
  }
})
