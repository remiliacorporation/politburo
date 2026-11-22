import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { openLedger } from '../src/index.ts'

const cwd = new URL('../', import.meta.url)
const config = { subject: 'config', version: 'v2' }
const at = '2026-01-02T03:04:05.000Z'

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-rollout-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'rollout.jsonl')
  const ledger = openLedger(dir, { now: () => new Date(at) })
  return { dir, file, ledger, bytes: () => readFileSync(file) }
}

test('a dead owner pid blocks or delays a rollout write', async (t) => {
  const { dir, ledger } = fixture(t)
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.ok(child.pid)
  const lock = join(dir, '.rollout.lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), String(child.pid), { flag: 'wx' })
  assert.deepEqual(await once(child, 'close'), [0, null])
  const started = performance.now()
  ledger.addEntry({ ...config, audience: ['pb'] })
  assert.ok(performance.now() - started < 1_000, 'recovering a dead owner took more than 1 s')
  assert.deepEqual(ledger.show().map(({ version }) => version), ['v2'])
})

async function holdWrite(t: TestContext, dir: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeSync } from 'node:fs'
    import { openLedger } from './src/rollout/ledger.ts'
    openLedger(process.argv[1], { now: () => {
      writeSync(1, 'locked\\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
      return new Date()
    } }).addEntry({ subject: 'config', version: 'v2', audience: ['pb'] })
  `, dir], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => { child.kill('SIGKILL') })
  const closed = once(child, 'close')
  await Promise.race([
    once(child.stdout, 'data'),
    closed.then(() => assert.fail('writer exited before reaching the append')),
  ])
  return { child, closed }
}

test('a writer SIGKILLed while holding the lock blocks the next write', { timeout: 15_000 }, async (t) => {
  const { dir, ledger } = fixture(t)
  const { child, closed } = await holdWrite(t, dir)
  assert.ok(child.kill('SIGKILL'))
  assert.deepEqual(await closed, [null, 'SIGKILL'])
  assert.ok(existsSync(join(dir, '.rollout.lock')), 'killed writer did not leave a lock to recover')
  assert.deepEqual(ledger.show(), [])
  ledger.addEntry({ ...config, audience: ['ty'] })
  assert.deepEqual(ledger.show().map(({ audience }) => audience), [['ty']])
})

test('a live writer lets a second CLI write through or fails without waiting or explaining why', { timeout: 20_000 }, async (t) => {
  const { dir, ledger } = fixture(t)
  const { child, closed } = await holdWrite(t, dir)
  const started = performance.now()
  const result = spawnSync(process.execPath, [
    'src/cli.ts', 'rollout', 'add', '--dir', dir, '--subject', 'config', '--version', 'v2', '--audience', 'ty',
  ], { cwd, encoding: 'utf8', timeout: 15_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'error: rollout ledger is locked\n')
  assert.ok(performance.now() - started >= 10_000, 'CLI did not wait 10 s for the lock')
  assert.deepEqual(ledger.show(), [])
  child.kill('SIGKILL')
  assert.deepEqual(await closed, [null, 'SIGKILL'])
})

test('concurrent ack writers lose, tear, or duplicate records or leave the lock behind', { timeout: 30_000 }, async (t) => {
  const { dir, ledger, bytes } = fixture(t)
  const distinct = Array.from({ length: 20 }, (_, i) => `tier-${i}`)
  const acked = [...distinct, 'shared']
  ledger.addEntry({ ...config, audience: [...acked, 'pb', 'ty'] })
  ledger.notify({ ...config, recipient: 'pb' })
  async function race(recipients: string[]) {
    const children = recipients.map((recipient) => spawn(process.execPath, ['--input-type=module', '-e', `
      import { openLedger } from './src/rollout/ledger.ts'
      const [dir, recipient] = process.argv.slice(1)
      process.stdout.write('ready\\n')
      for await (const _ of process.stdin) {}
      const ledger = openLedger(dir, { now: () => {
        if (recipient === 'shared') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
        return new Date()
      } })
      ledger.ack({ subject: 'config', version: 'v2', recipient })
    `, dir, recipient], { cwd, stdio: ['pipe', 'pipe', 'inherit'] }))
    t.after(() => { for (const child of children) child.kill() })
    const exits = children.map((child) => once(child, 'close'))
    await Promise.all(children.map((child, i) => Promise.race([
      once(child.stdout, 'data'),
      exits[i]!.then(() => assert.fail('ack writer exited before gate opened')),
    ])))
    for (const child of children) child.stdin.end()
    for (const result of await Promise.all(exits)) assert.deepEqual(result, [0, null])
  }
  await race(distinct)
  await race(Array.from({ length: 20 }, () => 'shared'))

  const records = bytes().toString().trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(records.length, 23)
  assert.deepEqual(records.filter(({ type }) => type === 'ack').map(({ recipient }) => recipient).sort(), acked.sort())
  assert.deepEqual(ledger.stale().map(({ recipient, state }) => [recipient, state]), [['pb', 'waiting'], ['ty', 'not notified']])
  assert.equal(existsSync(join(dir, '.rollout.lock')), false, 'last writer left the lock directory behind')
})

test('a torn or garbage last line blocks reads or poisons the next append', (t) => {
  for (const garbage of ['{"type":"ack","at":', 'garbage\n']) {
    const { file, ledger, bytes } = fixture(t)
    ledger.addEntry({ ...config, audience: ['pb', 'ty'] })
    appendFileSync(file, garbage)
    const damaged = bytes()
    assert.deepEqual(ledger.stale().map(({ recipient }) => recipient), ['pb', 'ty'])
    assert.deepEqual(bytes(), damaged)
    ledger.ack({ ...config, recipient: 'pb' })
    assert.deepEqual(bytes().subarray(0, damaged.length), damaged)
    assert.deepEqual(ledger.stale().map(({ recipient }) => recipient), ['ty'])
    ledger.notify({ ...config, recipient: 'ty' })
    assert.equal(ledger.stale()[0]?.state, 'waiting')
  }
})

test('middle corruption is ignored or reported at the wrong line', (t) => {
  const invalidUtf8 = Buffer.from(`{"type":"entry","at":"${at}","subject":"setup","version":"1","audience":["pb"],"summary":"\xff"}\n`, 'latin1')
  for (const garbage of ['garbage\n', invalidUtf8]) {
    const { file, ledger, bytes } = fixture(t)
    ledger.addEntry({ ...config, audience: ['pb'] })
    appendFileSync(file, garbage)
    appendFileSync(file, JSON.stringify({ type: 'ack', at, ...config, recipient: 'pb' }) + '\n')
    const before = bytes()
    assert.throws(() => ledger.show(), /line 2\b/)
    assert.throws(() => ledger.ack({ ...config, recipient: 'pb' }), /line 2\b/)
    assert.deepEqual(bytes(), before)
  }
})

test('identical add or ack appends again, or an entry conflict is accepted', (t) => {
  const { dir, ledger, bytes } = fixture(t)
  const input = { ...config, audience: ['pb', 'ty'], summary: 'config change' }
  const entry = ledger.addEntry(input)
  const delivery = { ...config, recipient: 'pb' }
  const ack = ledger.ack(delivery)
  const before = bytes()
  const reopened = openLedger(dir, { now: () => new Date('2026-02-01T00:00:00Z') })
  assert.deepEqual(reopened.addEntry(input), entry)
  assert.deepEqual(reopened.ack(delivery), ack)
  for (const change of [{ audience: ['ty', 'pb'] }, { summary: 'different change' }]) {
    assert.throws(() => reopened.addEntry({ ...input, ...change }), /conflicting entry/)
  }
  assert.deepEqual(bytes(), before)
})

test('superseding a version conflates recipient states or makes stale reports select the wrong entry', (t) => {
  const { ledger } = fixture(t)
  const current = { ...config, version: 'v1' }
  const audience = ['pb', 'ty', 'rw', 'core']
  ledger.addEntry({ ...config, audience })
  ledger.addEntry({ ...current, audience })
  ledger.addEntry({ subject: 'setup', version: 'v1', audience: ['pb'] })
  ledger.notify({ ...config, recipient: 'pb' })
  ledger.ack({ ...config, recipient: 'core' }) // late ack of the earlier entry
  ledger.notify({ ...current, recipient: 'ty' })
  ledger.ack({ ...current, recipient: 'rw' }) // ack does not require a notice
  assert.deepEqual(ledger.show({ subject: 'config' }), [{ ...current, audience, recipients: [
    { recipient: 'pb', state: 'not notified', notifiedAt: null, ackedAt: null },
    { recipient: 'ty', state: 'waiting', notifiedAt: at, ackedAt: null },
    { recipient: 'rw', state: 'acked', notifiedAt: null, ackedAt: at },
    { recipient: 'core', state: 'behind', notifiedAt: null, ackedAt: null },
  ] }])
  assert.deepEqual(ledger.stale().map(({ subject, recipient }) => [subject, recipient]), [
    ['config', 'pb'], ['config', 'ty'], ['config', 'core'], ['setup', 'pb'],
  ])
  assert.deepEqual(ledger.stale(config).map(({ recipient, state }) => [recipient, state]), [
    ['pb', 'waiting'], ['ty', 'not notified'], ['rw', 'not notified'],
  ])
  assert.deepEqual(ledger.stale({ subject: 'setup' }).map(({ subject, recipient }) => [subject, recipient]), [['setup', 'pb']])
  assert.equal(ledger.stale({ version: 'v1' }).length, 4)
  assert.throws(() => ledger.stale({ subject: 'setup', version: 'v2' }), /unknown version v2/)
})

test('notify or ack accepts an unknown entry or outsider, or changes bytes on failure', (t) => {
  const { ledger, bytes } = fixture(t)
  ledger.addEntry({ ...config, audience: ['pb'] })
  const before = bytes()
  for (const write of [ledger.notify, ledger.ack]) {
    assert.throws(() => write({ ...config, version: 'other', recipient: 'pb' }), /unknown entry/)
    assert.throws(() => write({ ...config, recipient: 'ty' }), /outside the audience/)
  }
  assert.deepEqual(bytes(), before)
})

test('invalid fields or overlarge records reach the ledger, or a valid Unicode summary is rejected', (t) => {
  const { ledger, bytes } = fixture(t)
  ledger.addEntry({ ...config, audience: ['pb'] })
  const summary = '😀'.repeat(500)
  assert.equal(ledger.addEntry({ subject: 'setup', version: 'unicode', audience: ['pb'], summary }).summary, summary)
  const before = bytes()
  for (const [change, error] of [
    [{ subject: '' }, /invalid subject/],
    [{ version: 'v'.repeat(65) }, /invalid version/],
    [{ audience: ['bad\n'] }, /invalid recipient/],
    [{ summary: 'line\x1b' }, /invalid summary/],
    [{ summary: 's'.repeat(501) }, /invalid summary/],
    [{ audience: [] }, /invalid audience/],
    [{ audience: Array.from({ length: 65 }, (_, i) => `${i}`) }, /invalid audience/],
    [{ audience: ['pb', 'pb'] }, /duplicate audience/],
    [{ audience: Array.from({ length: 64 }, (_, i) => `${i}`.padStart(64, 'r')) }, /under 4000 bytes/],
  ] as const) {
    assert.throws(() => ledger.addEntry({ subject: 'setup', version: '1', audience: ['pb'], ...change }), error)
  }
  assert.deepEqual(bytes(), before)
})

test('the rollout CLI misreports writes, reports stale as failure, or breaks JSON and error exits', (t) => {
  const { dir } = fixture(t)
  const run = (action: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'rollout', action, ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, SWARM_ROLLOUT_DIR: dir },
    })
    if (result.error) throw result.error
    return result
  }
  const key = ['--subject', 'config', '--version', 'v2']
  function success(result: ReturnType<typeof run>) {
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    return result.stdout
  }
  assert.equal(success(run('add', '--dir', join(dir, 'explicit'), ...key, '--audience', 'pb,ty')), 'added config v2\n')
  assert.equal(success(run('add', ...key, '--audience', 'pb,ty')), 'added config v2\n')
  assert.equal(success(run('add', ...key, '--audience', 'pb,ty')), 'exists config v2\n')
  assert.equal(success(run('notify', ...key, '--recipient', 'pb')), 'notified config v2 pb\n')
  assert.equal(success(run('ack', ...key, '--recipient', 'pb')), 'acked config v2 pb\n')
  assert.equal(success(run('stale', ...key)), 'config  v2  ty  not notified\n')
  assert.deepEqual(JSON.parse(success(run('stale', '--json'))), { stale: [
    { ...config, recipient: 'ty', state: 'not notified', notifiedAt: null, ackedAt: null },
  ] })
  const show = JSON.parse(success(run('show', '--json')))
  assert.deepEqual(Object.keys(show), ['entries'])
  assert.deepEqual(show.entries[0].audience, ['pb', 'ty'])
  const failure = run('ack', ...key, '--recipient', 'rw')
  assert.equal(failure.status, 1)
  assert.equal(failure.stdout, '')
  assert.equal(failure.stderr, 'error: recipient rw is outside the audience\n')
  const jsonFailure = run('stale', '--version', 'v99', '--json')
  assert.equal(jsonFailure.status, 1)
  assert.deepEqual(JSON.parse(jsonFailure.stderr), { status: 'error', reason: 'rollout_failed', message: 'unknown version v99' })
  const misuse = run('ack', ...key)
  assert.equal(misuse.status, 2)
  assert.match(misuse.stderr, /^error: missing --recipient\nusage:/)
  assert.match(success(run('--help')), /stale exits 0/)
})
