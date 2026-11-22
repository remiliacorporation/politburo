import { spawnSync as spawnSwarm } from 'node:child_process'
import { test as routingTest } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
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

function runDiff(script: string, service: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    "import { run } from './src/watch/cli.ts'; process.exitCode = await run(process.argv.slice(1))",
    '--', 'diff', '--script', script, '--service', service], {
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
  assert.deepEqual(diffAlerts(script, withoutStalls).missing.map(({ key }) => key),
    ['stall:missed:work:stalled', 'stall:missed:work:late'])
  const dir = tempDir(t)
  const scriptPath = join(dir, 'script.log'), servicePath = join(dir, 'service.jsonl')
  writeFileSync(scriptPath, scriptLog)
  writeFileSync(servicePath, withoutStalls.map((alert) => JSON.stringify(alert)).join('\n'))
  const missing = runDiff(scriptPath, servicePath)
  assert.equal(missing.status, 1, missing.stderr)
  assert.match(missing.stdout, /^missing  .*"key":"stall:missed:work:stalled"/m)

  writeFileSync(servicePath, alerts.map((alert) => JSON.stringify(alert)).join('\n') + '\n')
  await jsonlSink(servicePath)({ at: iso(720), kind: 'pr', key: 'pr:9:opened:open', text: 'pr #9 opened' })
  const extras = runDiff(scriptPath, servicePath)
  assert.equal(extras.status, 0, extras.stderr)
  assert.match(extras.stdout, /\b[1-9]\d* extra\b/)
})

test('PR transitions: opening, passing checks, or changing head gets lost or is logged twice', async () => {
  // Fake the GitHub PR feed and clock.
  let prs: Awaited<ReturnType<PrSource['list']>> = [draft]
  const alerts: ShadowAlert[] = [], head = 'b'.repeat(40)
  const log = prLog({ async list() { return prs } }, collect(alerts), { now: () => start })
  await log.poll()
  prs = [{ ...draft, state: 'open', checks: 'pass', head }]
  await log.poll()
  const expected = ['pr:7:state:open', 'pr:7:checks:pass', `pr:7:head:${head}`].sort()
  assert.deepEqual(alerts.map(({ key }) => key).sort(), expected)
  await log.poll()
  assert.deepEqual(alerts.map(({ key }) => key).sort(), expected)
})

test('PR restart: a known PR is re-announced or a new PR is silently baselined', async (t) => {
  // Fake the GitHub PR feed and clock; use a real state file across instances.
  let prs: Awaited<ReturnType<PrSource['list']>> = [draft]
  const source = { async list() { return prs } }
  const options = { statePath: join(tempDir(t), 'prs.json'), now: () => start }
  await prLog(source, collect([]), options).poll()
  prs = [draft, { ...draft, number: 8, state: 'open' }]
  const alerts: ShadowAlert[] = []
  await prLog(source, collect(alerts), options).poll()
  assert.deepEqual(alerts.map(({ key }) => key), ['pr:8:opened:open'])
})

test('service error isolation: a failed board read stops later polls or leaks an env value or stack', async (t) => {
  const previous = process.env.FAKE_SECRET_VALUE
  const canary = 'synthetic-watch-canary'
  process.env.FAKE_SECRET_VALUE = canary
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_SECRET_VALUE
    else process.env.FAKE_SECRET_VALUE = previous
  })
  const stop = new AbortController(), alerts: ShadowAlert[] = []
  let minute = 0
  // Fake board/GitHub I/O, clock and sleep; the board fails only at the first tick.
  await watchService({ signal: stop.signal, sink: collect(alerts), now: () => time(minute),
    async sleep() { if ((minute += 5) >= 10) stop.abort() },
    board: {
      async status() {
        if (minute === 0) {
          const error = new Error(`board response echoed ${process.env.FAKE_SECRET_VALUE}`)
          error.stack += '\n    at fakeBoardStackFrame (board.ts:1:1)'
          throw error
        }
        return { paused: false }
      },
      async poll() { return { cursor: String(minute), events: [] } },
      agents: { async list() { return { agents: [] } } },
    },
    prs: { async list() { return [{ ...draft, state: minute === 0 ? 'draft' : 'open' }] } },
  })
  const output = JSON.stringify(alerts)
  assert.equal(output.includes(canary), false, 'an alert includes the fake env value')
  assert.equal(/fakeBoardStackFrame|"stack":/.test(output), false, 'an alert includes a stack')
  assert.deepEqual(alerts.map(({ key, at }) => [key, at]), [['watch:error:stall', iso(0)], ['pr:7:state:open', iso(5)]])
})

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

test('script log parsing: an unknown kind is accepted or its line number is lost', () => {
  const log = `${iso(0)}\tstall\tstall:quiet:work\tquiet\n${iso(5)}\tbogus\tunknown\tbad kind\n`
  assert.throws(() => parseScriptLog(log), /invalid script alert at line 2\b/)
})

test('paused board: silence or a stale heartbeat raises a stall alert during a pause', async () => {
  // Replay supplies synthetic board status, heartbeats and time.
  const alerts = await replay([0, 65, 70].map((m) => ({ t: time(m), paused: m === 65,
    events: [], agents: [agent('worker', 0)],
  })))
  assert.deepEqual(alerts.filter(({ kind }) => kind === 'stall').map(({ key, at }) => [key, at]).sort(),
    [['stall:missed:work:worker', iso(70)], ['stall:quiet:work', iso(70)]])
})

test('slowdown episodes: sustained low activity spams alerts or recovery never re-arms them', () => {
  // Fake the clock and feed counts: two low windows, recovery, then another pair of low windows.
  const detector = slowdownDetector()
  const counts = [0, ...Array<number>(6).fill(20), 0, 0, ...Array<number>(6).fill(20), 0, 0]
  const alerts = counts.flatMap((count, i) => detector.observe(time(i * 30), count) ?? [])
  assert.deepEqual(alerts.map(({ key, at }) => [key, at]), [['slowdown:board', iso(210)], ['slowdown:board', iso(450)]])
})

routingTest('swarm watch reaches its area: a bad subcommand is the area\'s misuse, not an unknown command', () => {
  const result = spawnSwarm(process.execPath, ['src/cli.ts', 'watch', 'bogus'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 2 || /unknown command/.test(result.stderr)) {
    throw new Error(`not routed to watch: ${result.status} ${result.stderr}`)
  }
})
