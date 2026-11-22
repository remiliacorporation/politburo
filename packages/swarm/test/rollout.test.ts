import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs'
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

async function race(t: TestContext, values: string[], operation: string) {
  const { dir: gate } = fixture(t)
  const children = values.map((value) => spawn(process.execPath, ['--input-type=module', '-e', `
    import { existsSync, writeSync } from 'node:fs'
    import { openLedger } from './src/rollout/ledger.ts'
    const [gate, value] = process.argv.slice(1)
    const open = (dir, at) => openLedger(dir, { now: () => {
      writeSync(1, 'ready\\n')
      const pause = new Int32Array(new SharedArrayBuffer(4))
      while (!existsSync(gate + '/go')) Atomics.wait(pause, 0, 0, 5)
      return new Date(at)
    } })
    try { console.log(JSON.stringify(${operation})) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  `, gate, value], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }))
  t.after(() => { for (const child of children) child.kill() })
  const exits = children.map((child) => once(child, 'close'))
  const results = children.map(() => ({ stdout: '', stderr: '' }))
  await Promise.all(children.map((child, i) => {
    child.stdout.setEncoding('utf8').on('data', (chunk) => { results[i]!.stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { results[i]!.stderr += chunk })
    return Promise.race([once(child.stdout, 'data'), exits[i]!.then(() => assert.fail(results[i]!.stderr))])
  }))
  writeFileSync(join(gate, 'go'), '')
  return (await Promise.all(exits)).map(([status, signal], i) => ({ status, signal, ...results[i]! }))
}

function records(bytes: Buffer) {
  return bytes.toString().trimEnd().split('\n').map((line) => JSON.parse(line))
}

test('20+20 concurrent ack writers lose or replace effective receipts, tear records, or create a lock', { timeout: 30_000 }, async (t) => {
  const { dir, ledger, bytes } = fixture(t)
  const seen: (string | null)[] = []
  const watcher = watch(dir, (_, name) => { seen.push(name) })
  t.after(() => watcher.close())
  const distinct = Array.from({ length: 20 }, (_, i) => `tier-${i}`)
  ledger.addEntry({ ...config, audience: [...distinct, 'shared', 'pb', 'ty'] })
  ledger.notify({ ...config, recipient: 'pb' })
  for (const recipients of [distinct, distinct.map(() => 'shared')]) {
    const results = await race(t, recipients.map((r, i) => `${r},${i}`),
      `open(${JSON.stringify(dir)}, Date.UTC(2026, 0, 2) + Number(value.split(',')[1])).ack({
        ...${JSON.stringify(config)}, recipient: value.split(',')[0]
      })`)
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const first = new Map(records(bytes()).reverse().filter(({ type }) => type === 'ack')
      .map(({ recipient, at }) => [recipient, at]))
    for (const { stdout } of results) {
      const { recipient, at } = JSON.parse(stdout.split('\n')[1]!)
      assert.equal(at, first.get(recipient), 'writer returned a non-effective ack')
    }
    assert.deepEqual(ledger.show()[0]?.recipients.filter(({ ackedAt }) => ackedAt !== null)
      .map(({ recipient, ackedAt }) => [recipient, ackedAt]), [...new Set([...distinct, ...recipients])]
      .map((recipient) => [recipient, first.get(recipient)]))
  }
  assert.deepEqual(ledger.stale().map(({ recipient, state }) => [recipient, state]), [['pb', 'waiting'], ['ty', 'not notified']])
  assert.ok(!seen.includes('.rollout.lock') && !existsSync(join(dir, '.rollout.lock')), 'a lock directory was created')
})

test('racing adds with different audiences both succeed, or identical adds are not idempotent', { timeout: 15_000 }, async (t) => {
  const { dir, ledger, bytes } = fixture(t)
  for (const [version, audiences, expected] of [['v2', ['pb', 'ty'], [0, 1]], ['v1', ['pb', 'pb'], [0, 0]]] as const) {
    const results = await race(t, [...audiences], `open(${JSON.stringify(dir)}, ${JSON.stringify(at)})
      .addEntryWithOutcome({ subject: 'config', version: '${version}', audience: [value] })`)
    assert.deepEqual(results.map(({ status }) => status).sort(), expected)
    const winner = records(bytes()).find((record) => record.version === version)
    assert.deepEqual(ledger.show()[0]?.audience, winner.audience)
    const successes = results.filter(({ status }) => status === 0).map(({ stdout }) => JSON.parse(stdout.split('\n')[1]!))
    assert.equal(successes.filter(({ added }) => added).length, 1)
    for (const { entry } of successes) assert.deepEqual(entry.audience, winner.audience)
    for (const { stderr } of results.filter(({ status }) => status === 1)) assert.equal(stderr, 'conflicting entry config v2\n')
  }
})

test('a torn final line is folded or concurrent recovery rewrites bytes or poisons appends', async (t) => {
  const { dir, file, ledger, bytes } = fixture(t)
  ledger.addEntry({ ...config, audience: ['pb', 'ty'] })
  appendFileSync(file, JSON.stringify({ type: 'ack', at, ...config, recipient: 'pb' }))
  const damaged = bytes()
  assert.deepEqual(ledger.stale().map(({ recipient }) => recipient), ['pb', 'ty'])
  assert.deepEqual(bytes(), damaged)
  const results = await race(t, ['pb', 'ty'], `open(${JSON.stringify(dir)}, ${JSON.stringify(at)})
    .notify({ ...${JSON.stringify(config)}, recipient: value })`)
  for (const result of results) assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(bytes().subarray(0, damaged.length), damaged)
  assert.deepEqual(ledger.stale().map(({ state }) => state), ['waiting', 'waiting'])
  ledger.ack({ ...config, recipient: 'pb' })
  assert.deepEqual(ledger.stale().map(({ recipient }) => recipient), ['ty'])
})

test('a corrupt newline-terminated last line is ignored or a writer appends after it', (t) => {
  for (const garbage of ['garbage\n', '{}\n']) {
    const { file, ledger, bytes } = fixture(t)
    ledger.addEntry({ ...config, audience: ['pb'] })
    appendFileSync(file, garbage)
    const damaged = bytes()
    assert.throws(() => ledger.show(), /corrupt rollout ledger at line 2$/)
    assert.throws(() => ledger.ack({ ...config, recipient: 'pb' }), /corrupt rollout ledger at line 2$/)
    assert.deepEqual(bytes(), damaged)
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

test('a later duplicate notice replaces the first notice timestamp', (t) => {
  const { file, ledger, bytes } = fixture(t)
  ledger.addEntry({ ...config, audience: ['pb'] })
  const delivery = { ...config, recipient: 'pb' }
  const notice = ledger.notify(delivery)
  appendFileSync(file, JSON.stringify({ ...notice, at: new Date(0).toISOString() }) + '\n')
  const before = bytes()
  assert.equal(ledger.show()[0]?.recipients[0]?.notifiedAt, at)
  assert.deepEqual(ledger.notify(delivery), notice)
  assert.deepEqual(bytes(), before)
})

test('superseding a version conflates recipient states or makes stale reports select the wrong entry', (t) => {
  const { file, ledger } = fixture(t)
  const current = { ...config, version: 'v1' }
  const audience = ['pb', 'ty', 'rw', 'core']
  const earlier = ledger.addEntry({ ...config, audience })
  ledger.addEntry({ ...current, audience })
  appendFileSync(file, JSON.stringify(earlier) + '\n')
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
    [{ subject: '' }, /invalid subject/], [{ version: 'v'.repeat(65) }, /invalid version/],
    [{ audience: ['bad\n'] }, /invalid recipient/], [{ summary: 'line\x1b' }, /invalid summary/],
    [{ summary: 's'.repeat(501) }, /invalid summary/], [{ audience: [] }, /invalid audience/],
    [{ audience: Array.from({ length: 65 }, (_, i) => `${i}`) }, /invalid audience/],
    [{ audience: ['pb', 'pb'] }, /duplicate audience/],
    [{ audience: Array.from({ length: 64 }, (_, i) => `${i}`.padStart(64, 'r')) }, /under 4000 bytes/],
  ] as const) {
    assert.throws(() => ledger.addEntry({ subject: 'setup', version: '1', audience: ['pb'], ...change }), error)
  }
  assert.deepEqual(bytes(), before)
})

function cli(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'rollout', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, SWARM_ROLLOUT_DIR: dir },
  })
  if (result.error) throw result.error
  return result
}

test('a symlink ledger or file directory is accepted, or new paths have broad permissions', (t) => {
  const { dir, file, ledger } = fixture(t)
  const path = join(dir, 'nested')
  openLedger(path).addEntry({ ...config, audience: ['pb'] })
  const target = join(path, 'rollout.jsonl')
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o700)
    assert.equal(statSync(target).mode & 0o777, 0o600)
  }
  assert.throws(() => openLedger(target).show(), /not a rollout directory/)
  assert.throws(() => openLedger(target).addEntry({ ...config, audience: ['pb'] }), /not a rollout directory/)
  try { symlinkSync(target, file, 'file') } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return
    throw error
  }
  const before = readFileSync(target)
  assert.throws(() => ledger.show(), /symlinked rollout ledger/)
  assert.throws(() => ledger.addEntry({ ...config, audience: ['ty'] }), /symlinked rollout ledger/)
  assert.deepEqual(readFileSync(target), before)
})

test('read commands report missing directories or unknown filters as healthy, or create directories', (t) => {
  const { dir, file, ledger } = fixture(t)
  const missing = join(dir, 'missing')
  writeFileSync(file, '')
  const expectFailure = (path: string, headline: RegExp, ...args: string[]) => {
    const result = cli(path, ...args)
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, headline)
  }
  for (const action of ['stale', 'show']) {
    expectFailure('', /^error: missing --dir/, action)
    expectFailure(missing, /^error: missing rollout directory .*missing\n$/, action)
    expectFailure(dir, /^error: unknown subject away\n$/, action, '--subject', 'away')
  }
  assert.ok(!existsSync(missing))
  ledger.addEntry({ ...config, audience: ['pb'] })
  expectFailure(dir, /^error: unknown subject away\n$/, 'stale', '--subject', 'away')
  expectFailure(dir, /^error: unknown version v9\n$/, 'show', '--version', 'v9')
  ledger.ack({ ...config, recipient: 'pb' })
  const healthy = cli(dir, 'stale', '--subject', 'config', '--json')
  assert.equal(healthy.status, 0, healthy.stderr)
  assert.deepEqual(JSON.parse(healthy.stdout), { stale: [] })
})

test('JSON error stderr emits a raw C1 control character', () => {
  const result = cli('', 'bad\u009bcommand', '--json')
  assert.equal(result.status, 2)
  assert.ok(!result.stderr.includes('\u009b'), 'stderr contains a raw U+009B')
  assert.match(result.stderr, /bad\\u009bcommand/)
  assert.equal(JSON.parse(result.stderr).message, 'unknown rollout command bad\u009bcommand')
})

test('the rollout CLI misreports writes, reports stale as failure, or breaks JSON and error exits', (t) => {
  const { dir } = fixture(t)
  const run = (...args: string[]) => cli(dir, ...args)
  const key = ['--subject', 'config', '--version', 'v2']
  function success(result: ReturnType<typeof run>) {
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    return result.stdout
  }
  const add = ['add', ...key, '--audience', 'pb,ty']
  assert.equal(success(run(...add, '--dir', join(dir, 'explicit'))), 'added config v2\n')
  assert.equal(success(run(...add)), 'added config v2\n')
  assert.equal(success(run(...add)), 'exists config v2\n')
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
  const help = success(run('--help'))
  assert.match(help, /stale exits 0/)
  assert.match(help, /current means the latest added version, not the highest/)
  assert.match(help, /own statement and does not require a notice[\s\S]*null notifiedAt/)
})
