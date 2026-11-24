import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { jsonlLedger } from '../src/capture/ledger.ts'
import { recordSprite, SpriteLaunchFailed, supervise, type SuperviseOptions } from '../src/capture/supervise.ts'
import type { Envelope } from '../src/capture/types.ts'

const envelope: Envelope = {
  party: 'default', repo: 'plb', work_id: 'plb-482', attempt: 'att-42', tier: 'sprite',
  parent: 'exec-70', session: 'sess-91', trace: { id: 'tr-42', execution_id: 'exec-91' },
}
const usage = { input: 12, output: 4, cacheRead: 7, reasoning: 2 }
const unknown = {
  input_uncached: null, input_total: null, output: null, cache_read: null, cache_write: null, reasoning: null,
}

function turn(provider: string, model: string, counts: typeof usage, stopReason = 'stop') {
  return { type: 'message_end', message: {
    role: 'assistant', provider, model, stopReason, usage: counts, timestamp: '2025-01-01T00:00:02Z',
  } }
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-supervise-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledgerDir = join(dir, 'ledger')
  const opts = {
    name: 'sprite-91', taskFile: 'task.md', cwd: dir, dir, ledger: jsonlLedger(ledgerDir), envelope,
    newExecutionId: () => 'exec-92', requested_route: 'fallback/codex-cursor', pollMs: 1,
  } satisfies SuperviseOptions
  async function finish(name: string, rc: number | null, turns = [turn('openai', 'codex', usage)]) {
    const session = { type: 'session', timestamp: '2025-01-01T00:00:00Z' }
    await writeFile(join(dir, `${name}.jsonl`), [session, ...turns].map(e => JSON.stringify(e)).join('\n') + '\n')
    if (rc !== null) await writeFile(join(dir, `${name}.rc`), `${rc}\n`)
  }
  const readRows = async (file: string) => (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  return { dir, ledgerDir, opts, finish, readRows, spend: join(ledgerDir, 'spend.jsonl'), envelopes: join(ledgerDir, 'envelopes.jsonl') }
}

for (const [attempt, suffix] of [[0, '.pid'], [0, '.rc'], [1, '.jsonl'], [2, '']] as const) {
  test(`existing ${suffix || 'directory'} for attempt ${attempt} prevents any registration or launch`, async t => {
    const { dir, opts, finish, envelopes } = await fixture(t)
    const sprite = attempt === 0 ? opts.name : `${opts.name}.r${attempt}`
    const evidence = join(dir, sprite + suffix)
    if (suffix) await writeFile(evidence, 'old evidence')
    else await mkdir(evidence)
    const launched: string[] = []
    await assert.rejects(supervise({ ...opts, restarts: 2, launch: async name => {
      launched.push(name)
      await finish(name, 0)
    } }), { message: 'sprite name already used' })
    assert.deepEqual(launched, [])
    await assert.rejects(readFile(envelopes), { code: 'ENOENT' })
    if (suffix) assert.equal(await readFile(evidence, 'utf8'), 'old evidence')
    else assert.ok((await stat(evidence)).isDirectory())
  })
}

test('a restart refuses evidence that appeared after preflight instead of overwriting it', async t => {
  const { dir, opts, finish } = await fixture(t)
  const evidence = join(dir, `${opts.name}.r1.jsonl`)
  const launched: string[] = []
  await assert.rejects(supervise({ ...opts, restarts: 1, launch: async name => {
    launched.push(name)
    if (name === opts.name) await writeFile(evidence, 'other run')
    await finish(name, name === opts.name ? 1 : 0)
  } }), { message: 'sprite name already used' })
  assert.deepEqual(launched, [opts.name])
  assert.equal(await readFile(evidence, 'utf8'), 'other run')
})

test('the default launcher does not leak PI_MODEL to sprite-start', async t => {
  const { dir, opts } = await fixture(t)
  await writeFile(join(dir, 'sprite-start'), `#!/bin/sh
if [ "\${PI_MODEL+x}" = x ]; then
  printf 'true\\n' > model-visible
else
  printf 'false\\n' > model-visible
fi
exit 1
`, { mode: 0o700 })
  const { PATH, PI_MODEL } = process.env
  t.after(() => {
    if (PATH === undefined) delete process.env.PATH
    else process.env.PATH = PATH
    if (PI_MODEL === undefined) delete process.env.PI_MODEL
    else process.env.PI_MODEL = PI_MODEL
  })
  process.env.PATH = `${dir}:${PATH ?? ''}`
  process.env.PI_MODEL = 'not-the-router-default'
  await assert.rejects(supervise(opts), SpriteLaunchFailed)
  assert.equal(await readFile(join(dir, 'model-visible'), 'utf8'), 'false\n')
  assert.ok(process.env.PI_MODEL === 'not-the-router-default')
})

test('launch never races ahead of durable envelope registration', async t => {
  const { dir, opts, finish, readRows, envelopes } = await fixture(t)
  let launchArgs: unknown
  let registered: unknown
  const { attempts } = await supervise({ ...opts, launch: async (...args) => {
    launchArgs = args
    registered = await readRows(envelopes).catch(() => null)
    await finish(args[0], 0)
  } })
  assert.deepEqual(launchArgs, [opts.name, opts.taskFile, dir, 2400])
  assert.deepEqual(registered, [envelope])
  assert.deepEqual(attempts.map(a => [a.name, a.execution_id, a.rc, a.written]), [[opts.name, 'exec-91', 0, 1]])
})

test('failed registration does not write an envelope or reach launch', async t => {
  const { opts, ledgerDir, spend, envelopes } = await fixture(t)
  await writeFile(ledgerDir, '') // A real filesystem failure before registration can write.
  let launched = false
  await assert.rejects(supervise({ ...opts, launch: async () => { launched = true } }), { code: 'EEXIST' })
  assert.equal(launched, false)
  await assert.rejects(readFile(envelopes), { code: 'ENOTDIR' })
  await assert.rejects(readFile(spend), { code: 'ENOTDIR' })
})

test('restart after exit 1 cannot reuse a log, execution ID, or ledger record', async t => {
  const { opts, finish, readRows, spend, envelopes } = await fixture(t)
  const { attempts } = await supervise({ ...opts, restarts: 1, launch: name => finish(name, name === opts.name ? 1 : 0) })
  assert.deepEqual(attempts.map(a => [a.name, a.execution_id, a.rc, a.written]), [
    [opts.name, 'exec-91', 1, 1], [`${opts.name}.r1`, 'exec-92', 0, 1],
  ])
  const retry = { ...envelope, trace: { ...envelope.trace, execution_id: 'exec-92' } }
  assert.deepEqual(await readRows(envelopes), [envelope, retry])
  const records = attempts.flatMap(a => a.records)
  assert.deepEqual(await readRows(spend), records)
  assert.equal(new Set(records.map(r => r.record_id)).size, 2)
  assert.deepEqual(records.map(r => r.envelope), [envelope, retry])
})

test('stop exit 137 does not launch a restart even with retries left', async t => {
  const { opts, finish, readRows, envelopes } = await fixture(t)
  const { attempts } = await supervise({ ...opts, restarts: 1, launch: name => finish(name, 137) })
  assert.deepEqual(attempts.map(a => a.rc), [137])
  assert.equal(attempts[0]?.records[0]?.status, 'canceled')
  assert.deepEqual(await readRows(envelopes), [envelope])
})

test('collecting the same log later does not append again or change the first receipt', async t => {
  const { dir, opts, finish, spend } = await fixture(t)
  const { attempts } = await supervise({ ...opts, now: () => 0, launch: name => finish(name, 0) })
  const before = await readFile(spend, 'utf8')
  const replay = await recordSprite({ ...opts, ledger: jsonlLedger(join(dir, 'ledger')), now: () => 1000 }, { dir })
  assert.deepEqual([attempts[0]?.written, replay.written], [1, 0])
  assert.equal(await readFile(spend, 'utf8'), before)
})

test('after Codex errors, Cursor zero placeholders stay unknown in a separate record', async t => {
  const { opts, finish, readRows, spend } = await fixture(t)
  const { attempts } = await supervise({ ...opts, launch: name => finish(name, 0, [
    turn('openai', 'codex', usage, 'error'),
    turn('cursor', 'fallback', { input: 0, output: 0, cacheRead: 0, reasoning: 0 }),
  ]) })
  assert.equal(attempts.length, 1)
  const records = attempts[0]?.records ?? []
  assert.deepEqual(records.map(r => [r.provider, r.actual_model, r.tokens, r.requested_route]), [
    ['openai', 'codex', { ...unknown, input_uncached: 12, output: 4, cache_read: 7, reasoning: 2 }, opts.requested_route],
    ['cursor', 'fallback', unknown, opts.requested_route],
  ])
  assert.ok(Object.values(records[1]?.coverage.field_quality ?? { missing: false }).every(v => v === 'unknown'))
  assert.deepEqual(await readRows(spend), records)
})

test('a sidecar written during the 120-second grace period is not treated as unfinished', async t => {
  const { dir, opts, finish } = await fixture(t)
  let time = 0
  const { attempts } = await supervise({ ...opts, maxSeconds: 1, now: () => {
    // The first poll misses the sidecar; it arrives in the grace period before the next poll.
    if (time === 120_000) writeFileSync(join(dir, `${opts.name}.rc`), '0\n')
    return time++
  }, launch: async name => {
    await finish(name, null)
    time = 119_999
  } })
  assert.deepEqual(attempts.map(a => a.rc), [0])
})

test('a missing .rc times out without writing any spend or losing the envelope', async t => {
  const { opts, finish, readRows, envelopes, spend } = await fixture(t)
  let time = -60_500
  await assert.rejects(supervise({ ...opts, maxSeconds: 1, now: () => time += 60_500,
    launch: name => finish(name, null),
  }), { message: 'sprite did not finish' })
  assert.deepEqual(await readRows(envelopes), [envelope])
  await assert.rejects(readFile(spend), { code: 'ENOENT' })
})
