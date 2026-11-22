import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { accessSync, chmodSync, closeSync, constants, existsSync, linkSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { test, type TestContext } from 'node:test'
import { Book, type Claim, type Envelope, type SpendRecord } from '../src/capture-cloud/index.ts'

const envelope: Envelope = {
  party: 'default', repo: 'plb', work_id: 'plb-111', attempt: 'att-1', tier: 'mob',
  parent: 'exec-1', session: 'sess-2', trace: { id: 'tr-1', execution_id: 'exec-2' },
}
const session = 'canary-session'
const claim: Claim = {
  source_event_key: 'response-1', model: 'claude-canary', status: 'completed',
  started: '2026-11-22T12:00:00Z', ended: '2026-11-22T12:00:02Z', occurred: '2026-11-22T12:00:03Z',
  tokens: { input_uncached: 7, input_total: 11, output: 3, cache_read: 4, cache_write: 0, reasoning: 1 },
}

function paths(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-capture-cloud-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { bookFile: join(dir, 'book.json'), ledgerFile: join(dir, 'spend.jsonl'), envelopeFile: join(dir, 'envelope.json') }
}
function records(path: string): SpendRecord[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}
function post(url: string, capability: string) {
  return fetch(`${url}/v1/claims/${capability}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim) })
}

const cli = ['dist/cli.js', 'capture-cloud']
const cwd = new URL('../', import.meta.url)
function run(...args: string[]) { return runWithInput('', ...args) }
function runWithInput(input: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [...cli, ...args], { cwd, input, encoding: 'utf8', timeout: 5_000 })
  if (result.error) throw result.error
  return result
}

// Catches a broken CLI dispatch, binding, ephemeral listener, or file handoff.
test('CLI issues, binds and serves a claim into the ledger', async (t) => {
  const { bookFile, ledgerFile, envelopeFile } = paths(t)
  writeFileSync(envelopeFile, JSON.stringify(envelope))
  const issued = run('issue', '--book', bookFile, '--envelope', envelopeFile, '--ttl-hours', '1', '--json')
  assert.equal(issued.status, 0, issued.stderr)
  const { capability } = JSON.parse(issued.stdout)
  assert.match(capability, /^cap_\S+$/)
  const bind = ['bind', '--book', bookFile, '--session', session]
  const bound = runWithInput(`${capability}\nignored\n`, ...bind)
  assert.equal(bound.status, 0, bound.stderr)
  const empty = run(...bind), flag = run(...bind, '--capability', 'not-a-secret')
  assert.deepEqual([empty.status, empty.stderr.trim()], [2, 'error: missing capability on stdin'])
  assert.deepEqual([flag.status, flag.stderr.trim()], [2, 'error: invalid flags'])
  assert.equal(new Book({ file: bookFile }).bySession(session, Date.now())?.session, session)
  const child = spawn(process.execPath, [...cli, 'serve', '--book', bookFile, '--ledger', ledgerFile, '--port', '0'], { cwd })
  const closed = once(child, 'close')
  t.after(async () => { child.kill('SIGKILL'); await closed })
  const lines = createInterface({ input: child.stdout })
  t.after(() => lines.close())
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  const [line] = await Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(5_000) }),
    closed.then(([code]) => assert.fail(`serve exited before listening (${code}): ${stderr}`)),
  ])
  assert.match(line, /^listening\s+http:\/\/127\.0\.0\.1:[1-9]\d*$/)
  assert.equal(statSync(ledgerFile).mode & 0o777, 0o600, 'ledger exists privately before the first claim')
  assert.equal((await post(line.trim().split(/\s+/)[1], capability)).status, 202)
  // Independent file read immediately after the child acknowledges append; it cannot observe fsync.
  const [row, ...rest] = records(ledgerFile)
  assert.ok(row && rest.length === 0, 'expected exactly one record')
  assert.deepEqual(row.envelope, envelope)
  assert.deepEqual(row.tokens, claim.tokens)
})

function serveError(book: string, ledger: string, message: string) {
  const result = run('serve', '--book', book, '--ledger', ledger, '--port', '0')
  assert.deepEqual([result.status, result.stdout, result.stderr.trim()], [1, '', `error: ${message}`])
}

test('CLI serve rejects a ledger alias of the book', (t) => {
  const { bookFile, ledgerFile } = paths(t)
  const alias = join(dirname(bookFile), 'alias')
  symlinkSync(dirname(bookFile), alias, 'dir')
  serveError(bookFile, join(alias, basename(bookFile)), 'book and ledger must be different files')
  writeFileSync(bookFile, '{\n}', { mode: 0o600 })
  linkSync(bookFile, ledgerFile)
  serveError(bookFile, ledgerFile, 'book and ledger must be different files')
})

test('CLI serve rejects ledger symlinks and non-regular files', (t) => {
  const { bookFile, ledgerFile } = paths(t)
  const rejectsLedger = () => serveError(bookFile, ledgerFile, 'ledger path is not a safe regular file')
  symlinkSync(bookFile, ledgerFile)
  rejectsLedger()
  writeFileSync(bookFile, '{}', { mode: 0o600 })
  rejectsLedger()
  rmSync(ledgerFile)
  mkdirSync(ledgerFile)
  rejectsLedger()
})

test('CLI serve rejects the book lock through a directory alias', (t) => {
  const { bookFile } = paths(t)
  const alias = join(dirname(bookFile), 'alias')
  symlinkSync(dirname(bookFile), alias, 'dir')
  serveError(bookFile, join(alias, `${basename(bookFile)}.lock`), 'book and ledger must be different files')
})

test('CLI serve rejects unavailable parent directories before listening', (t) => {
  const { bookFile, ledgerFile } = paths(t)
  const dir = join(dirname(bookFile), 'unavailable')
  const nested = join(dir, 'file')
  const rejectsParents = () => {
    serveError(nested, ledgerFile, 'cannot use book directory')
    serveError(bookFile, nested, 'cannot use ledger directory')
  }
  rejectsParents()
  mkdirSync(dir, { mode: 0o500 })
  let writable = true
  try { accessSync(dir, constants.W_OK) } catch { writable = false }
  try { if (!writable) rejectsParents() } finally { chmodSync(dir, 0o700) }
})

test('CLI bind refuses terminal stdin', (t) => {
  const probe = spawnSync('script', ['-qec', 'exit 23', '/dev/null'], { timeout: 2_000 })
  if (probe.status !== 23) return t.skip('script with -qec is unavailable for a pseudo-terminal')
  const { bookFile } = paths(t)
  const argv = [process.execPath, ...cli, 'bind', '--book', bookFile, '--session', session]
  const command = argv.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')
  const result = spawnSync('script', ['-qec', command, '/dev/null'], {
    cwd, input: 'not-a-capability\n', encoding: 'utf8', timeout: 5_000,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 2, result.stdout)
  assert.match(result.stdout, /error: capability must be piped on stdin\r?\n/)
})

test('CLI issue reports a failed capability handoff', (t) => {
  if (!existsSync('/dev/full')) return t.skip('/dev/full is unavailable')
  const { bookFile, envelopeFile } = paths(t)
  writeFileSync(envelopeFile, JSON.stringify(envelope))
  const full = openSync('/dev/full', 'w')
  t.after(() => closeSync(full))
  const result = spawnSync(process.execPath, [...cli, 'issue', '--book', bookFile,
    '--envelope', envelopeFile, '--ttl-hours', '1'], {
    cwd, stdio: ['ignore', full, 'pipe'], encoding: 'utf8', timeout: 5_000,
  })
  if (result.error) throw result.error
  assert.deepEqual([result.status, result.stderr.trim()], [1, 'error: cannot deliver capability'])
})

test('CLI --json errors are one document on stderr', (t) => {
  const { bookFile, envelopeFile } = paths(t)
  writeFileSync(envelopeFile, JSON.stringify({ ...envelope, extra: true }))
  const issue = ['issue', '--book', bookFile, '--ttl-hours', '1', '--envelope']
  for (const [args, status, message] of [
    [[...issue, '/dev/null'], 1, 'cannot read envelope json'],
    [[...issue, envelopeFile], 1, 'invalid envelope'],
    [['bind', '--session', session], 2, 'missing --book'],
    [['serve', '--book', bookFile, '--unknown'], 2, 'invalid flags'],
  ] as const) {
    const result = run(...args, '--json')
    assert.deepEqual([result.status, result.stdout, result.stderr],
      [status, '', `${JSON.stringify({ error: { message } })}\n`])
  }
})

test('CLI bind validates arguments and the book without waiting for stdin', async (t) => {
  const { bookFile } = paths(t)
  for (const [args, status, message] of [
    [['--book', bookFile, '--session', 'x'], 2, 'invalid session id'],
    [['--session', session], 2, 'missing --book'],
    [['--book', dirname(bookFile), '--session', session], 1, 'unsafe book file'],
  ] as const) {
    const child = spawn(process.execPath, [...cli, 'bind', ...args], { cwd, timeout: 2_000 })
    const closed = once(child, 'close')
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
    child.stdin.on('error', () => {})
    child.stdin.write('not-a-capability') // No newline or EOF: a read would block.
    const [code, signal] = await closed
    assert.deepEqual([code, signal, stderr.trim()], [status, null, `error: ${message}`])
  }
})
