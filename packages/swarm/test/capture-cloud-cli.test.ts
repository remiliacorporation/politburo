import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assert.equal((await post(line.trim().split(/\s+/)[1], capability)).status, 202)
  // Independent file read immediately after the child acknowledges append; it cannot observe fsync.
  const [row, ...rest] = records(ledgerFile)
  assert.ok(row && rest.length === 0, 'expected exactly one record')
  assert.deepEqual(row.envelope, envelope)
  assert.deepEqual(row.tokens, claim.tokens)
})

test('CLI serve rejects a ledger alias of the book', (t) => {
  const { bookFile, ledgerFile } = paths(t)
  writeFileSync(bookFile, '{\n}', { mode: 0o600 })
  for (const alias of [symlinkSync, linkSync]) {
    alias(bookFile, ledgerFile)
    const result = run('serve', '--book', bookFile, '--ledger', ledgerFile, '--port', '0')
    assert.deepEqual([result.status, result.stderr.trim()], [1, 'error: book and ledger must be different files'])
    rmSync(ledgerFile)
  }
})

// Catches minting a capability for an envelope with unexpected fields.
test('CLI rejects an envelope with an unknown field without printing a capability', (t) => {
  const { bookFile, envelopeFile } = paths(t)
  writeFileSync(envelopeFile, JSON.stringify({ ...envelope, extra: true }))
  const result = run('issue', '--book', bookFile, '--envelope', envelopeFile, '--ttl-hours', '1', '--json')
  assert.ok(result.status === 1 || result.status === 2, `exit status ${result.status}`)
  assert.match(result.stderr, /^error:/)
  assert.equal(result.stdout, '')
})
