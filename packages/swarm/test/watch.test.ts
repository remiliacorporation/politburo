import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { jsonlSink, type ShadowAlert } from '../src/watch/alerts.ts'
import { diffAlerts, parseScriptLog, parseShadowLog } from '../src/watch/diff.ts'
import { prLog, type PrSource } from '../src/watch/prlog.ts'
import { replay, type Frame } from '../src/watch/replay.ts'
import { watchService } from '../src/watch/service.ts'
import { slowdownDetector } from '../src/watch/slowdown.ts'

const start = Date.parse('2026-01-01T00:00:00Z')
const time = (minutes: number) => start + minutes * 60_000
const iso = (minutes: number) => new Date(time(minutes)).toISOString()
const agent = (id: string, lastBeat: number) => ({ id, role: 'worker', status: 'enabled' as const, heartbeatAt: iso(lastBeat) })
const draft = { number: 7, head: 'a'.repeat(40), state: 'draft', checks: 'pending' } as const
const collect = (alerts: ShadowAlert[]) => (alert: ShadowAlert) => { alerts.push(alert) }

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-watch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function runDiff(script: string, service: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    "import { run } from './src/watch/cli.ts'; process.exitCode = await run(process.argv.slice(1))",
    '--', 'diff', '--script', script, '--service', service, ...flags], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

test('the watch never alerts less than the script: a dropped alert slips past the shadow gate', async (t) => {
  // Recorded board feed and heartbeats drive replay's fake board and clock.
  const frames: Frame[] = Array.from({ length: 288 }, (_, i) => {
    const m = i * 5
    return { t: time(m), paused: false,
      events: Array.from({ length: m > 240 && m <= 300 ? 0 : 4 }, () => ({ createdAt: iso(m) })),
      agents: [agent('stalled', m > 60 && m < 360 ? 60 : m), agent('late', m > 480 && m < 550 ? 480 : m)],
    }
  })
  const scriptLog = [
    '2026-01-01T02:05:00.000Z\tstall\tstall:missed:work:stalled\tstalled stopped sending heartbeats',
    '2026-01-01T04:30:00.000Z\tslowdown\tslowdown:board\tboard event rate collapsed',
    '2026-01-01T09:05:00.000Z\tstall\tstall:missed:work:late\tlate missed its heartbeat deadline',
  ].join('\n') + '\n'
  const script = parseScriptLog(scriptLog)
  const alerts = await replay(frames)
  assert.deepEqual(diffAlerts(script, alerts).missing, [])

  const withoutStalls = await replay(frames, { periodMinutes: 24 * 60 })
  assert.deepEqual(diffAlerts(script, withoutStalls).missing.map(({ line }) => line), [1, 3])
  const dir = tempDir(t)
  const scriptPath = join(dir, 'script.log'), servicePath = join(dir, 'service.jsonl')
  writeFileSync(scriptPath, scriptLog)
  writeFileSync(servicePath, withoutStalls.map((alert) => JSON.stringify(alert)).join('\n'))
  const missing = runDiff(scriptPath, servicePath)
  assert.equal(missing.status, 1, missing.stderr)
  assert.match(missing.stdout, /^missing  2026-01-01T02:05:00.000Z stall \(script line 1\)$/m)

  writeFileSync(servicePath, alerts.map((alert) => JSON.stringify(alert)).join('\n') + '\n')
  await jsonlSink(servicePath)({ at: iso(720), kind: 'pr', key: 'pr:9:opened:open', text: 'pr #9 opened' })
  const extras = runDiff(scriptPath, servicePath)
  assert.equal(extras.status, 0, extras.stderr)
  assert.match(extras.stdout, /\b[1-9]\d* extra\b/)
})

test('diff pairs occurrences once, in timestamp order within each kind and key', () => {
  const a = (m: number) => ({ at: iso(m), kind: 'stall' as const, key: 'a', text: '' })
  const dup = diffAlerts([a(0), a(0)], [a(0)], { toleranceMinutes: 0 })
  assert.deepEqual(dup.missing.map(({ line }) => line), [2])
  const result = diffAlerts([a(5), a(1)], [a(0), a(10), a(8), { ...a(1), kind: 'pr' }, { ...a(1), key: 'b' }],
    { toleranceMinutes: 5 })
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.extra.map(({ line }) => line), [2, 4, 5])
})

test('diff CLI never republishes raw fields from missing, matched, or extra alerts', (t) => {
  const dir = tempDir(t), script = join(dir, 'script'), service = join(dir, 'service')
  const key = randomUUID(), text = `https://example:${randomUUID()}@example.invalid/`
  writeFileSync(script, `${iso(0)}\tstall\t${key}\t${text}\n${iso(5)}\tpr\t${key}\t${text}\n`)
  writeFileSync(service, ['stall', 'slowdown'].map((kind) => JSON.stringify({ at: iso(0), kind, key, text })).join('\n'))
  const plain = runDiff(script, service), json = runDiff(script, service, '--json')
  for (const result of [plain, json]) {
    assert.equal(result.status, 1)
    assert.equal([key, text].some((value) => result.stdout.includes(value) || result.stderr.includes(value)), false)
  }
  assert.equal(plain.stdout, `missing  ${iso(5)} pr (script line 2)\n`)
  assert.deepEqual(JSON.parse(json.stdout), { missing: [{ at: iso(5), kind: 'pr', line: 2 }],
    matched: [{ at: iso(0), kind: 'stall', line: 1 }], extra: [{ at: iso(0), kind: 'slowdown', line: 2 }] })
  writeFileSync(service, JSON.stringify({ at: '2026-02-30T00:00:00Z', kind: 'stall', key, text }))
  assert.equal(runDiff(script, service, '--json').stdout, '{"error":"invalid shadow alert at line 1"}\n')
})

test('PR transitions: opening, passing checks, or changing head gets lost or is logged twice', async () => {
  // Fake the GitHub PR feed and clock.
  let prs: Awaited<ReturnType<PrSource['list']>> = [draft]
  const alerts: ShadowAlert[] = [], head = 'b'.repeat(40)
  const log = prLog({ async list() { return prs } }, collect(alerts), { now: () => start })
  await log.poll()
  prs = [{ ...draft, state: 'open', checks: 'pass', head }, { ...draft, number: 8, state: 'open' }]
  await log.poll()
  const expected = ['pr:7:state:open', 'pr:7:checks:pass', `pr:7:head:${head}`, 'pr:8:opened:open'].sort()
  assert.deepEqual(alerts.map(({ key }) => key).sort(), expected)
  await log.poll()
  assert.deepEqual(alerts.map(({ key }) => key).sort(), expected)
})

test('PR restart: an omitted PR is forgotten, persisted changes are missed, or a closed PR stays tracked', async (t) => {
  // Fake GitHub responses; use a real checkpoint across instances.
  const other = { ...draft, number: 8 }
  let prs: Awaited<ReturnType<PrSource['list']>> = [draft, other]
  const source = { async list() { return prs } }, alerts: ShadowAlert[] = []
  const options = { statePath: join(tempDir(t), 'prs.json'), now: () => start }
  const log = prLog(source, collect(alerts), options)
  await log.poll()
  prs = [{ ...other, state: 'closed' }]
  await log.poll() // PR 7 fell out of the snapshot, but only PR 8 explicitly closed.
  prs = [{ ...draft, checks: 'pass' }, { ...other, state: 'open' }]
  const restarted = prLog(source, collect(alerts), options)
  await restarted.poll()
  await restarted.poll()
  assert.deepEqual(alerts.map(({ key }) => key), ['pr:8:state:closed', 'pr:7:checks:pass', 'pr:8:opened:open'])
})

test('service error isolation: a failed board read prevents recovery or leaks a response or stack', async () => {
  const canary = randomUUID()
  const stop = new AbortController(), alerts: ShadowAlert[] = []
  let minute = 0
  // Fake board/GitHub I/O, clock and sleep; the board fails only at the first tick.
  await watchService({ signal: stop.signal, sink: collect(alerts), now: () => time(minute),
    async sleep() { if ((minute += 5) >= 10) stop.abort() },
    board: {
      async status() {
        if (minute === 0) {
          const error = new Error(`board response echoed ${canary}`)
          error.stack += '\n    at fakeBoardStackFrame (board.ts:1:1)'
          throw error
        }
        return { paused: false }
      },
      async poll() { return { cursor: String(minute), events: [] } },
      agents: { async list() { return { agents: [agent('late', -60)] } } },
    },
    prs: { async list() { return [{ ...draft, state: minute === 0 ? 'draft' : 'open' }] } },
  })
  const output = JSON.stringify(alerts)
  assert.equal(output.includes(canary), false, 'an alert includes remote response text')
  assert.equal(/fakeBoardStackFrame|"stack":/.test(output), false, 'an alert includes a stack')
  assert.deepEqual(alerts.map(({ key, at }) => [key, at]), [
    ['watch:error:stall', iso(0)], ['stall:missed:work:late', iso(5)], ['pr:7:state:open', iso(5)],
  ])
})

test('hung watch parts time out independently, and shutdown interrupts an in-flight read', { timeout: 2000 }, async () => {
  const stop = new AbortController(), alerts: ShadowAlert[] = [], signals: (AbortSignal | undefined)[] = []
  const hang = (signal?: AbortSignal) => { signals.push(signal); return new Promise<never>(() => {}) }
  let tick = 0
  await watchService({ signal: stop.signal, deadlineMs: 10, sink: collect(alerts), now: () => time(tick),
    async sleep() { tick++ },
    board: {
      async status(signal) {
        if (tick === 1) return { paused: false }
        if (tick === 2) setTimeout(() => stop.abort(), 0)
        return hang(signal)
      },
      async poll(_query, signal) {
        if (tick === 0) return hang(signal)
        return { cursor: 'next', events: [] }
      },
      agents: { async list() { return { agents: [agent('late', -60)] } } },
    },
    prs: { async list(signal) { return tick === 0 ? [draft] : hang(signal) } },
  })
  assert.deepEqual(alerts.map(({ key, at }) => [key, at]), [
    ['watch:error:stall', iso(0)], ['watch:error:slowdown', iso(0)],
    ['stall:missed:work:late', iso(1)], ['watch:error:pr', iso(1)],
  ])
  assert.equal(new Set(signals).size, 4)
  assert.ok(signals.every((signal) => signal?.aborted))
  assert.equal(signals[3]?.reason, stop.signal.reason)
})

for (const reason of ['deadline', 'SIGTERM']) {
  test(`configured watch CLI closes a hung board socket on ${reason} and exits cleanly`, async (t) => {
    const home = tempDir(t)
    let accepted!: (request: { closed: Promise<unknown> }) => void
    const requested = new Promise<{ closed: Promise<unknown> }>((resolve) => { accepted = resolve })
    const server = createServer((req, res) => {
      if (req.url === '/') return res.end(JSON.stringify({ audience: url }))
      if (req.url !== '/control') return res.writeHead(404).end()
      // The real SDK has connected; never answer this request.
      accepted({ closed: once(req.socket, 'close') })
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Shorten only the child CLI's 30s deadline; don't mock the SDK or its network.
    const clock = reason === 'deadline' ? `const timer = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 30_000 ? 400 : ms, ...args);` : ''
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `${clock}
      const { run } = await import('./dist/watch/cli.js');
      process.exitCode = await run(['run', '--shadow', '--out', process.argv[1]]);`, join(home, 'watch.jsonl')], {
      cwd: new URL('../', import.meta.url), env: { BOARD_URL: url, HOME: home }, stdio: 'ignore',
    })
    const exited = once(child, 'exit')
    try {
      const request = await Promise.race([requested, exited.then(() => null), delay(3000, null, { ref: false })])
      assert.ok(request, 'CLI did not reach the board control request')
      const closed = Promise.race([request.closed.then(() => true), delay(1500, false, { ref: false })])
      if (reason === 'deadline') assert.equal(await closed, true, 'part deadline left the board socket open')
      child.kill('SIGTERM')
      assert.deepEqual(await Promise.race([exited, delay(1500, 'still running', { ref: false })]), [0, null])
      assert.equal(await closed, true, 'shutdown left the board socket open')
    } finally {
      child.kill('SIGKILL')
      server.closeAllConnections()
      server.close()
      await exited
    }
  })
}

test('JSONL sink: appending an alert overwrites history or writes unreadable lines', async (t) => {
  const path = join(tempDir(t), 'logs', 'watch.jsonl')
  const sink = jsonlSink(path)
  const alerts: ShadowAlert[] = [
    { at: iso(0), kind: 'stall', key: 'stall:quiet:work', text: 'first\nalert' },
    { at: iso(5), kind: 'slowdown', key: 'slowdown:board', text: 'second alert' },
  ]
  for (const alert of alerts) await sink(alert)
  assert.deepEqual(parseShadowLog(readFileSync(path, 'utf8')), alerts)
})

test('script parsing rejects unknown kinds, bare CR, local times and impossible dates without echoing rows', () => {
  const row = `${iso(0)}\tstall\tquiet\tquiet`, canary = randomUUID()
  for (const bad of [`${iso(5)}\tbogus\tkey\t${canary}`, `${row}\r${row}`,
    ...['2026-01-01T00:00:00', '2026-02-30T00:00:00Z'].map((at) => `${at}\tstall\tkey\t${canary}`)]) {
    assert.throws(() => parseScriptLog(`${row}\r\n${bad}\n`), { message: 'invalid script alert at line 2' })
  }
  const offset = parseScriptLog(`${row.replace(iso(0), '2025-12-31T19:00:00-05:00')}\r\n`)
  assert.equal(diffAlerts(offset, parseScriptLog(row), { toleranceMinutes: 0 }).matched.length, 1)
})

test('paused board: silence or a stale heartbeat raises a stall alert during a pause', async () => {
  // Replay supplies synthetic board status, heartbeats and time.
  const alerts = await replay([0, 65, 70].map((m) => ({ t: time(m), paused: m === 65,
    events: [], agents: [agent('worker', 0)],
  })))
  assert.deepEqual(alerts.filter(({ kind }) => kind === 'stall').map(({ key, at }) => [key, at]).sort(),
    [['stall:missed:work:worker', iso(70)], ['stall:quiet:work', iso(70)]])
})

test('watch diff matches a replayed stall by the token of the original ID, not the escaped ID', async (t) => {
  const [alert] = await replay([{ t: time(65), paused: false, events: [],
    agents: [{ ...agent('example:agent', 0), role: 'example:role' }],
  }])
  const dir = tempDir(t), script = join(dir, 'script.tsv'), service = join(dir, 'service.jsonl')
  writeFileSync(script, `${iso(65)}\tstall\tstall:missed:work:agent-07897adc7946\tmissed heartbeat\n`)
  writeFileSync(service, `${JSON.stringify(alert)}\n`)
  const diff = runDiff(script, service)
  assert.equal(diff.status, 0, diff.stdout || diff.stderr)
  assert.match(alert!.text, /^Agent agent-07897adc7946 \(agent-619badd8e8e0\) /)
})

test('stall replay redacts unsafe fields and gives both colliding IDs distinct keys in original ID order', async () => {
  const id = `agent/${randomUUID()}`, role = `${randomUUID()} ) ${randomUUID()}`
  const opaque = (value: string) => `agent-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
  const alias = opaque(id)
  const alerts = await replay([{ t: time(65), paused: false, events: [],
    agents: [{ ...agent(id, 0), role }, { ...agent(alias, 0), role: 'checker' }],
  }])
  assert.equal(alerts.length, 2)
  assert.equal([id, role].some((value) => JSON.stringify(alerts).includes(value)), false)
  assert.deepEqual(alerts.map(({ key, text }) => [key, text]).sort(), [[alias, 'checker'], [`${alias}-2`, opaque(role)]].map(([label, role]) => [
    `stall:missed:work:${label}`, `Agent ${label} (${role}) last sent a heartbeat 3900000 ms ago. The limit is 3600000 ms.`,
  ]))
})

test('slowdown episodes: sustained low activity spams alerts or recovery never re-arms them', () => {
  // Fake the clock and feed counts: two low windows, recovery, then another pair of low windows.
  const detector = slowdownDetector()
  const counts = [0, ...Array<number>(6).fill(20), 0, 0, ...Array<number>(6).fill(20), 0, 0]
  const alerts = counts.flatMap((count, i) => detector.observe(time(i * 30), count) ?? [])
  assert.deepEqual(alerts.map(({ key, at }) => [key, at]), [['slowdown:board', iso(210)], ['slowdown:board', iso(450)]])
})

test('swarm watch reaches its area: a bad subcommand reports the exact watch misuse', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'watch', 'bogus'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  assert.equal(result.status, 2)
  assert.equal(result.stderr, 'error: expected watch diff, replay, or run\n')
})
