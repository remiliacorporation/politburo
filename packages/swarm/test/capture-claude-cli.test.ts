import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { readJsonl } from '../src/capture-claude/index.ts'

const cwd = new URL('../', import.meta.url)
const cli = ['src/cli.ts', 'capture-claude']
const session = 'native:session-1'
const secret = 'private-transcript-content-5cf27'

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [...cli, ...args], { cwd, encoding: 'utf8', timeout: 5000 })
  if (result.error) throw result.error
  return result
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-capture-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'transcript.jsonl')
  return {
    dir, file, ledger: join(dir, 'ledger.jsonl'), quarantine: join(dir, 'quarantine.jsonl'),
    bind: (...flags: string[]) => run('bind', '--dir', dir, '--session', session, '--party', 'local',
      '--tier', 'mob', '--trace', 'trace-1', '--execution', 'exec-1', ...flags),
    check: (...flags: string[]) => run('check', '--dir', dir, '--session', session, '--transcript', file, ...flags),
    transcript: (...rows: { id?: string; output?: number; cacheWrite?: number; sessionId?: string }[]) => writeFileSync(file,
      rows.map(({ id = 'req:1', output = 91, cacheWrite, sessionId = session }) => JSON.stringify({
        type: 'assistant', sessionId, requestId: id, message: {
          id: `msg-${id}`, content: [{ type: 'text', text: secret }],
          usage: { input_tokens: 240, output_tokens: output, cache_read_input_tokens: 0,
            cache_creation_input_tokens: cacheWrite },
        },
      })).join('\n') + '\n'),
  }
}

function log(nativeSession: string, requestId: string, cacheWrite?: number) {
  return { attributes: Object.entries({
    'event.name': { stringValue: 'claude_code.api_request' },
    'session.id': { stringValue: nativeSession },
    request_id: { stringValue: requestId },
    input_tokens: { intValue: '240' }, output_tokens: { intValue: 91 }, cache_read_tokens: { intValue: 0 },
    ...(cacheWrite === undefined ? {} : { cache_creation_tokens: { intValue: cacheWrite } }),
  }).map(([key, value]) => ({ key, value })) }
}

async function start(t: TestContext, dir: string) {
  const child = spawn(process.execPath, [...cli, 'serve', '--dir', dir, '--port', '0'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  t.after(async () => { child.kill('SIGKILL'); await closed })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('receiver did not announce its settings')), 5000)
    const ready = () => {
      if (!/^ +OTEL_LOGS_EXPORT_INTERVAL=\d+\n/m.test(stdout)) return
      clearTimeout(timeout)
      child.stdout.off('data', ready)
      resolve()
    }
    child.stdout.on('data', ready)
    void closed.then(() => { clearTimeout(timeout); reject(new Error(`receiver stopped: ${stderr}`)) }, reject)
  })
  const url = /^listening  (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout)?.[1]
  assert.ok(url, stdout)
  return {
    stdout, url,
    async post(...logRecords: ReturnType<typeof log>[]) {
      const response = await fetch(`${url}/v1/logs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] }),
      })
      assert.equal(response.status, 200, await response.text())
    },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      const stopping = once(child, 'close', { signal: AbortSignal.timeout(3000) })
      child.kill(signal)
      assert.deepEqual(await stopping, [signal === 'SIGINT' ? 130 : 0, null], stderr)
      assert.equal(stderr, '')
    },
  }
}

test('serve announces a loopback URL that accepts OTLP into the bound ledger and closes on interrupt', async (t) => {
  const f = fixture(t)
  assert.equal(f.bind().status, 0)
  const server = await start(t, f.dir)
  for (const line of ['CLAUDE_CODE_ENABLE_TELEMETRY=1', 'OTEL_LOGS_EXPORTER=otlp',
    'OTEL_EXPORTER_OTLP_PROTOCOL=http/json', `OTEL_EXPORTER_OTLP_ENDPOINT=${server.url}`, 'OTEL_LOGS_EXPORT_INTERVAL=1000']) {
    assert.ok(server.stdout.includes(`    ${line}\n`), line)
  }
  await server.post(log(session, 'req:1'))
  await server.stop('SIGINT')
  assert.deepEqual(readJsonl(f.ledger).map((row) => [row.envelope?.session, row.tokens.output]), [['exec-1', 91]])
  assert.deepEqual(readJsonl(f.quarantine), [])
})

test('bind releases only the named session and refuses to change its envelope', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'), log('other', 'req:2'))
  await server.stop()
  const original = readJsonl(f.quarantine)[0]
  assert.ok(original)
  assert.deepEqual(readJsonl(f.quarantine).map((row) => row.envelope), [null, null])
  assert.deepEqual(readJsonl(f.ledger), [])
  const bound = f.bind('--ref', 'internal-1', '--json')
  assert.equal(bound.status, 0, bound.stderr)
  assert.deepEqual(JSON.parse(bound.stdout), { bound: session, released: 1 })
  const rows = readJsonl(f.ledger)
  assert.deepEqual(rows.map((row) => [row.envelope?.session, row.revises]), [['internal-1', original.record_id]])
  const persisted = readFileSync(f.ledger, 'utf8')
  const replay = f.bind('--ref', 'internal-1', '--json')
  assert.equal(replay.status, 0, replay.stderr)
  assert.deepEqual(JSON.parse(replay.stdout), { bound: session, released: 0 })
  assert.equal(readFileSync(f.ledger, 'utf8'), persisted)
  const changed = f.bind('--ref', 'different')
  assert.equal(changed.status, 1)
  assert.match(changed.stderr, /^error: native session already bound\n$/)
  assert.deepEqual(readJsonl(f.ledger), rows)
})

test('a POST replay across live bind leaves the released ledger and quarantine unchanged', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  const request = log(session, 'req:1')
  await server.post(request)
  const [original, ...extra] = readJsonl(f.quarantine)
  assert.ok(original)
  assert.deepEqual(extra, [])
  assert.deepEqual(readJsonl(f.ledger), [])
  const bind = f.bind('--json')
  assert.equal(bind.status, 0, bind.stderr)
  assert.equal(JSON.parse(bind.stdout).released, 1)
  assert.deepEqual(readJsonl(f.ledger).map((row) => row.revises), [original.record_id])
  const before = [f.ledger, f.quarantine].map((path) => readFileSync(path, 'utf8'))
  await server.post(request)
  assert.deepEqual([f.ledger, f.quarantine].map((path) => readFileSync(path, 'utf8')), before)
  await server.stop()
})

test('check --write excludes and reports foreign transcript rows even when all local rows match', async (t) => {
  const f = fixture(t)
  assert.equal(f.bind().status, 0)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'))
  await server.stop()
  f.transcript({}, { id: 'req-foreign', sessionId: 'another-session' })
  const check = f.check('--write')
  assert.equal(check.status, 1, check.stdout)
  assert.match(check.stdout, /^foreign rows  1$/m)
  assert.match(check.stdout, /^matched +1$/m)
  assert.match(check.stdout, /\ndiffers\n$/)
  assert.deepEqual(readJsonl(f.ledger).map((row) => row.source), ['claude_local_request', 'claude_local_request'])
  assert.deepEqual(readJsonl(f.quarantine), [])
  const replay = f.check('--write', '--json')
  assert.equal(replay.status, 1)
  assert.equal(JSON.parse(replay.stdout).foreign, 1)
  assert.equal(readJsonl(f.ledger).length, 2)
})

test('check distinguishes a match from changed or missing counts without summing unknown buckets', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'), log('other', 'req:1'))
  await server.stop()
  assert.equal(f.bind().status, 0)
  f.transcript({})
  const match = f.check()
  assert.equal(match.status, 0, match.stderr)
  assert.match(match.stdout, /^matched +1$/m)
  assert.match(match.stdout, /^cache_read +0 +0$/m)
  assert.match(match.stdout, /^cache_write +unknown \(1\) +unknown \(1\)$/m)
  assert.match(match.stdout, /\nmatch\n$/)
  f.transcript({ output: 92 })
  const differs = f.check('--json')
  assert.equal(differs.status, 1)
  const report = JSON.parse(differs.stdout)
  assert.equal(report.result, 'differs')
  assert.deepEqual(report.counters, { matched: 0, mismatched: 1, transcriptOnly: 0, otlpOnly: 0 })
  assert.deepEqual(report.totals.otlp.cache_write, { unknown: 1 })
  f.transcript({ cacheWrite: 0 })
  assert.equal(f.check().status, 1, 'unknown does not equal a reported zero')
})

test('check --write never prints or stores transcript content, even on a malformed line', (t) => {
  const f = fixture(t)
  f.transcript({})
  assert.equal(f.bind().status, 0)
  const result = f.check('--write')
  assert.equal(result.status, 1)
  assert.match(result.stdout, /^transcript only +1$/m)
  assert.ok(!(result.stdout + result.stderr + readFileSync(f.ledger, 'utf8')).includes(secret))
  writeFileSync(f.file, `{"private":"${secret}"`)
  const malformed = f.check('--write', '--json')
  assert.equal(malformed.status, 1)
  assert.equal(JSON.parse(malformed.stdout).badTranscriptLines, 1)
  assert.ok(!(malformed.stdout + malformed.stderr + readFileSync(f.ledger, 'utf8')).includes(secret))
  writeFileSync(f.file, JSON.stringify({ type: 'assistant', requestId: '../unsafe' }))
  const noId = f.check('--write', '--json')
  assert.equal(noId.status, 1)
  assert.equal(JSON.parse(noId.stdout).noId, 1)
  assert.equal(readJsonl(f.ledger).length, 1)
})

test('check --write appends one reconciled successor and replay leaves the ledger byte-for-byte unchanged', async (t) => {
  const f = fixture(t)
  assert.equal(f.bind().status, 0)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'))
  await server.stop()
  f.transcript({})
  assert.equal(f.check('--write').status, 0)
  const [original, successor, ...extra] = readJsonl(f.ledger)
  assert.ok(original && successor)
  assert.deepEqual(extra, [])
  assert.equal(successor.revises, original.record_id)
  assert.equal(successor.coverage.state, 'closed_reconciled')
  const persisted = readFileSync(f.ledger, 'utf8')
  assert.equal(f.check('--write').status, 0)
  assert.equal(readFileSync(f.ledger, 'utf8'), persisted)
})

test('check --write supersedes transcript backfill after matching late OTLP without counting twice', async (t) => {
  const f = fixture(t)
  assert.equal(f.bind().status, 0)
  f.transcript({ cacheWrite: 17 })
  assert.equal(f.check('--write').status, 1)
  const [backfill, ...extra] = readJsonl(f.ledger)
  assert.ok(backfill)
  assert.deepEqual(extra, [])
  assert.equal(backfill.source, 'claude_local_transcript')
  assert.equal(backfill.tokens.output, 91)
  const server = await start(t, f.dir)
  const request = log(session, 'req:1', 17)
  await server.post(request)
  assert.equal(f.check('--write').status, 0)
  const rows = readJsonl(f.ledger)
  const superseded = rows.find((row) => row.revises === backfill.record_id)
  assert.ok(superseded, 'the prior transcript row must have a successor')
  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.coverage.state, 'closed_reconciled')
  assert.deepEqual(superseded.tokens, {
    input_uncached: null, input_total: null, output: null, cache_read: null, cache_write: null, reasoning: null,
  })
  for (const bucket of Object.keys(superseded.tokens)) {
    assert.equal(superseded.coverage.field_quality[`tokens.${bucket}`], 'unknown')
  }
  const heads = rows.filter((row) => !rows.some((next) => next.revises === row.record_id))
  assert.deepEqual(heads.filter((row) => row.status !== 'superseded').map((row) => row.tokens.output), [91])
  const before = readFileSync(f.ledger, 'utf8')
  await server.post(request)
  assert.equal(f.check('--write').status, 0)
  assert.equal(readFileSync(f.ledger, 'utf8'), before)
  await server.stop()
})

test('check --write revises the current request head across bind and does not fork or rewrite on replay', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'))
  await server.stop()
  f.transcript({})
  assert.equal(f.check('--write').status, 0)
  assert.equal(f.bind().status, 0)
  const heads = () => readJsonl(f.ledger).filter((row) => row.source === 'claude_local_request')
  let head = heads().at(-1)
  assert.equal(head?.coverage.state, 'closed_reconciled')
  for (const output of [92, 93, 91, 92]) {
    f.transcript({ output })
    const count = heads().length
    const matched = output === 91
    assert.equal(f.check('--write').status, matched ? 0 : 1)
    const rows = heads()
    assert.equal(rows.length, count + 1)
    const next = rows.at(-1)
    assert.equal(next?.revises, head?.record_id)
    assert.equal(next?.coverage.state, matched ? 'closed_reconciled' : 'conflict')
    head = next
    const before = readFileSync(f.ledger, 'utf8')
    assert.equal(f.check('--write').status, matched ? 0 : 1)
    assert.equal(readFileSync(f.ledger, 'utf8'), before)
  }
})

test('check --write quarantines both unbound conflict sides and transcript-only requests until bind', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'))
  await server.stop()
  f.transcript({ output: 92 }, { id: 'req-2' })
  assert.equal(f.check('--write').status, 1)
  assert.deepEqual(readJsonl(f.ledger), [], 'conflict evidence must not enter the ledger before bind')
  const [original, otlpConflict, transcriptConflict, transcriptOnly] = readJsonl(f.quarantine)
  assert.ok(original && otlpConflict && transcriptConflict && transcriptOnly)
  assert.deepEqual(readJsonl(f.quarantine).map((row) => [row.envelope, row.coverage.state, row.tokens.output]), [
    [null, 'unattributed', 91], [null, 'conflict', 91], [null, 'conflict', 92], [null, 'unattributed', 91],
  ])
  assert.equal(otlpConflict.revises, original.record_id)
  assert.equal(transcriptOnly.source, 'claude_local_transcript')
  const persisted = readFileSync(f.quarantine, 'utf8')
  assert.equal(f.check('--write').status, 1)
  assert.equal(readFileSync(f.quarantine, 'utf8'), persisted)
  assert.ok(!persisted.includes(secret))
  assert.equal(f.bind().status, 0)
  const rows = readJsonl(f.ledger)
  assert.deepEqual(rows.map((row) => [row.coverage.state, row.revises, row.envelope?.session]), [
    ['partial', original.record_id, 'exec-1'], ['conflict', rows[0]?.record_id, 'exec-1'],
    ['conflict', transcriptConflict.record_id, 'exec-1'], ['partial', transcriptOnly.record_id, 'exec-1'],
  ])
  const attributed = readFileSync(f.ledger, 'utf8')
  assert.equal(f.check('--write').status, 1)
  assert.equal(f.bind().status, 0)
  assert.equal(readFileSync(f.ledger, 'utf8'), attributed)
  assert.equal(readFileSync(f.quarantine, 'utf8'), persisted)
  f.transcript({ id: 'req-3' })
  assert.equal(f.check('--write').status, 1)
  const partial = readJsonl(f.ledger).at(-1)
  assert.equal(partial?.coverage.state, 'partial')
  assert.equal(partial?.envelope?.session, 'exec-1')
  assert.equal(partial?.revises, null)
})

test('help succeeds, but missing commands, required flags and unknown arguments are misuse', () => {
  const help = run('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^usage: swarm capture-claude serve/m)
  for (const flags of [[], ['unknown'], ['serve'], ['check', '--unknown']]) {
    const result = run(...flags)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /^error: .+\nusage: swarm capture-claude /)
  }
})

test('serve refuses both --host and --allow-remote', (t) => {
  const f = fixture(t)
  for (const [flag, ...values] of [['--host', '0.0.0.0'], ['--allow-remote']] as const) {
    const result = run('serve', '--dir', join(f.dir, 'missing'), flag, ...values)
    assert.equal(result.status, 2)
    assert.ok(result.stderr.startsWith('error: ') && result.stderr.includes(flag))
    assert.equal(result.stdout, '')
  }
})

test('missing state directory, missing transcript and directory transcript each give one error line', (t) => {
  const f = fixture(t)
  const missing = run('serve', '--dir', join(f.dir, 'missing'))
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /^error: state directory not found[^\n]*\n$/)
  for (const path of [f.file, f.dir]) {
    const unreadable = f.check('--transcript', path)
    assert.equal(unreadable.status, 1)
    assert.equal(unreadable.stdout, '')
    assert.equal(unreadable.stderr, `error: cannot read transcript ${path}\n`)
  }
})

test('check reports differs when the transcript has requests but capture has none', (t) => {
  const f = fixture(t)
  f.transcript({})
  const result = f.check('--json')
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.result, 'differs')
  assert.deepEqual(report.counters, { matched: 0, mismatched: 0, transcriptOnly: 1, otlpOnly: 0 })
})

test('check reports a partial match as differs and keeps known subtotals beside unknowns', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'), log(session, 'captured-only', 17))
  await server.stop()
  f.transcript({}, { id: 'transcript-only', cacheWrite: 23 })
  const result = f.check('--json')
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.result, 'differs')
  assert.deepEqual(report.counters, { matched: 1, mismatched: 0, transcriptOnly: 1, otlpOnly: 1 })
  const human = f.check()
  assert.match(human.stdout, /^cache_write +17 known, 1 unknown +23 known, 1 unknown$/m)
  assert.deepEqual([report.totals.otlp.cache_write, report.totals.transcript.cache_write], [
    { known: 17, unknown: 1 }, { known: 23, unknown: 1 },
  ])
  f.transcript({}, { id: 'transcript-only', cacheWrite: 0 })
  assert.match(f.check().stdout, /^cache_write +17 known, 1 unknown +0 known, 1 unknown$/m)
  f.transcript({})
  const missing = f.check()
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /^otlp only +1$/m)
  f.transcript({}, { id: 'captured-only', cacheWrite: 17 }, { id: 'transcript-only' })
  const extra = f.check()
  assert.equal(extra.status, 1)
  assert.match(extra.stdout, /^mismatched +0$/m)
  assert.match(extra.stdout, /^transcript only +1$/m)
})

test('check --write quarantines a matched successor until bind then attributes it only once', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'))
  await server.stop()
  f.transcript({})
  assert.equal(f.check('--write').status, 0)
  assert.deepEqual(readJsonl(f.ledger), [], 'the matched successor must stay quarantined until bind')
  const [original, successor] = readJsonl(f.quarantine)
  assert.ok(original && successor)
  assert.equal(successor.revises, original.record_id)
  assert.equal(successor.envelope, null)
  assert.equal(successor.coverage.state, 'closed_reconciled')
  assert.equal(f.bind().status, 0)
  const rows = readJsonl(f.ledger)
  assert.deepEqual(rows.map((row) => [row.revises, row.envelope?.session, row.coverage.state]), [
    [original.record_id, 'exec-1', 'partial'], [rows[0]?.record_id, 'exec-1', 'closed_reconciled'],
  ])
  const persisted = readFileSync(f.ledger, 'utf8')
  assert.equal(f.check('--write').status, 0)
  assert.equal(f.bind().status, 0)
  assert.equal(readFileSync(f.ledger, 'utf8'), persisted)
})

test('bind and check reject unsafe native session identifiers even with explicit assignment', (t) => {
  const f = fixture(t)
  for (const command of [f.bind, f.check]) {
    for (const flags of [['--session', '--write'], ['--session=../native%2F'], ['--session=--write']]) {
      const result = command(...flags)
      assert.equal(result.status, 2)
      assert.match(result.stderr, /^error: .*--session/)
    }
  }
})

test('bind rejects empty and whitespace-only session, party and internal session IDs without releasing spend', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.post(log(session, 'req:1'))
  await server.stop()
  for (const flag of ['session', 'party', 'ref']) {
    for (const value of ['', ' \t ']) {
      const result = f.bind(`--${flag}=${value}`)
      assert.equal(result.status, 2)
      assert.ok(result.stderr.startsWith(`error: missing --${flag}\n`))
      assert.equal(result.stdout, '')
    }
  }
  assert.deepEqual(readJsonl(f.ledger), [])
  assert.equal(f.bind().status, 0)
  assert.equal(readJsonl(f.ledger).length, 1)
})

test('serve exits cleanly with status 0 on SIGTERM', async (t) => {
  const f = fixture(t)
  const server = await start(t, f.dir)
  await server.stop('SIGTERM')
  await assert.rejects(fetch(server.url, { signal: AbortSignal.timeout(1000) }),
    (error: Error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED')
})
