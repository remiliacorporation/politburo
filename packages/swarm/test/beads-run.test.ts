import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test, type TestContext } from 'node:test'
import { bdRunner } from '../src/trackers/beads/index.ts'

function fakeBd(t: TestContext, body = 'printf "[]\\n"', timeoutMs?: number) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-fake-bd-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.beads'))
  const bin = join(dir, 'bd')
  const log = join(dir, 'calls')
  writeFileSync(log, '')
  writeFileSync(bin, `#!/bin/sh
log="\${0%/*}/calls"
printf 'start\\n' >> "$log"
printf 'arg:%s\\n' "$@" >> "$log"
printf 'cwd:%s\\nhome:%s\\n' "$(pwd -P)" "$HOME" >> "$log"
# On Linux inspect the original env, before the shell adds PWD and friends.
if [ -r /proc/$$/environ ]; then
  tr '\\000' '\\n' < /proc/$$/environ | cut -d= -f1
else
  (unset PWD SHLVL _; env) | cut -d= -f1
fi | while IFS= read -r name; do printf 'env:%s\\n' "$name"; done >> "$log"
${body}
printf 'end\\n' >> "$log"
`, { mode: 0o700 })
  function runner(store = dir) {
    const run = bdRunner({ dir: store, bin, timeoutMs })
    t.after(() => run.close())
    return run
  }
  return { dir, runner, log: () => readFileSync(log, 'utf8') }
}

test('refused verbs, flags and ids cannot spawn bd', async (t) => {
  const fake = fakeBd(t)
  const run = fake.runner()
  const refused = [
    ...['create', 'show', 'update', 'sync'].map((verb) => [verb, '--json']),
    ...['--claim', '-C', '--db'].map((flag) => ['list', flag]),
    ...['-rw-1', 'rw has-space', 'rw;id'].map((id) => ['list', '--id', id]),
    ['ready', '--id', 'rw-1'], ['blocked', '--all'],
  ]
  for (const argv of refused) {
    const label = argv.join(' ')
    await assert.rejects(run(argv), { message: `bd call refused: ${argv[0]}` }, label)
    assert.equal(fake.log(), '', `spawned bd for ${label}`)
  }
})

test('bd cannot lose read-only flags, run in the wrong cwd or inherit the parent environment', async (t) => {
  const fake = fakeBd(t)
  for (const name of ['BEADS_DOLT_PASSWORD', 'BEADS_DIR', 'GITHUB_TOKEN', 'NODE_V8_COVERAGE']) {
    const before = process.env[name]
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before })
    process.env[name] = join(fake.dir, 'not-for-bd')
  }
  const run = fake.runner()
  const verbs = ['list', 'ready', 'blocked']
  for (const verb of verbs) assert.equal(await run([verb, '--json']), '[]\n')
  const calls = fake.log().split(/^end\n/m).slice(0, -1)
  assert.equal(calls.length, 3)
  const homes = calls.map((call, i) => {
    assert.deepEqual(call.match(/^arg:.+$/gm), ['arg:--readonly', 'arg:--sandbox', `arg:${verbs[i]}`, 'arg:--json'])
    assert.equal(/^cwd:(.+)$/m.exec(call)?.[1], fake.dir)
    assert.deepEqual(call.match(/^env:.+$/gm)?.sort(), ['env:BD_NON_INTERACTIVE', 'env:HOME', 'env:NO_COLOR', 'env:PATH'])
    const home = /^home:(.+)$/m.exec(call)?.[1]
    assert.ok(home && existsSync(home), 'bd did not get an existing HOME')
    assert.notEqual(home, process.env.HOME)
    return home
  })
  await run.close()
  for (const home of homes) assert.equal(existsSync(home), false, 'close left bd HOME behind')
})

test('concurrent calls cannot overlap bd processes', async (t) => {
  const fake = fakeBd(t, 'sleep 0.15')
  const run = fake.runner()
  await Promise.all([run(['list']), run(['ready']), run(['blocked'])])
  assert.deepEqual(fake.log().match(/^(start|end)$/gm), ['start', 'end', 'start', 'end', 'start', 'end'])
})

test('bd cannot discover a parent store or accept a relative store', async (t) => {
  const fake = fakeBd(t)
  const child = join(fake.dir, 'child')
  mkdirSync(child)
  for (const dir of [child, relative(process.cwd(), fake.dir)]) {
    await assert.rejects(fake.runner(dir)(['list']), { message: 'no .beads in the store directory' })
  }
  assert.equal(fake.log(), '')
})

test('bd failures cannot leak stdout or stderr, and a hung bd times out', async (t) => {
  const failure = fakeBd(t, 'echo token_fake_stdout; echo token_fake_stderr >&2; exit 3')
  await assert.rejects(failure.runner()(['list']), { message: 'bd list failed with exit code 3' })
  const slow = fakeBd(t, 'exec sleep 2', 100)
  await assert.rejects(slow.runner()(['list']), { message: 'bd list timed out' })
})
