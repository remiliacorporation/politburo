import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  return { dir, bin, runner, log: () => readFileSync(log, 'utf8') }
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

test('bd cannot lose read-only flags, run in the wrong cwd or inherit the parent environment', (t) => {
  const fake = fakeBd(t, '[ -d "$HOME" ] || exit 4\nprintf "[]\\n"')
  const verbs = ['list', 'ready', 'blocked']
  const module = new URL('../src/trackers/beads/run.ts', import.meta.url).href
  const sentinel = join(fake.dir, 'not-for-bd')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { bdRunner } from ${JSON.stringify(module)}
    const run = bdRunner({ dir: process.argv[1], bin: process.argv[2] })
    try {
      const outputs = []
      for (const verb of process.argv.slice(3)) outputs.push(await run([verb, '--json']))
      console.log(JSON.stringify(outputs))
    } finally {
      await run.close()
    }
  `, fake.dir, fake.bin, ...verbs], {
    encoding: 'utf8', timeout: 30_000,
    env: {
      PATH: '/usr/bin:/bin', HOME: sentinel, BEADS_DOLT_PASSWORD: sentinel,
      BEADS_DIR: sentinel, GITHUB_TOKEN: sentinel, NODE_V8_COVERAGE: sentinel,
    },
  })
  if (child.error) throw child.error
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), ['[]\n', '[]\n', '[]\n'])
  const calls = fake.log().split(/^end\n/m).slice(0, -1)
  assert.equal(calls.length, 3)
  for (const [i, call] of calls.entries()) {
    assert.deepEqual(call.match(/^arg:.+$/gm), ['arg:--readonly', 'arg:--sandbox', `arg:${verbs[i]}`, 'arg:--json'])
    assert.equal(/^cwd:(.+)$/m.exec(call)?.[1], fake.dir)
    assert.deepEqual(call.match(/^env:.+$/gm)?.sort(), ['env:BD_NON_INTERACTIVE', 'env:HOME', 'env:NO_COLOR', 'env:PATH'])
    const home = /^home:(.+)$/m.exec(call)?.[1]
    assert.ok(home, 'bd did not get a HOME')
    assert.notEqual(home, sentinel)
    assert.equal(existsSync(home), false, 'close left bd HOME behind')
  }
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

test('bd cannot spawn when the store redirects to another store', async (t) => {
  const fake = fakeBd(t)
  writeFileSync(join(fake.dir, '.beads', 'redirect'), '../other/.beads\n')
  await assert.rejects(fake.runner()(['list']), { message: 'the store directory redirects to another store' })
  assert.equal(fake.log(), '')
})

test('a redirect written while bd runs cannot be accepted after it is removed', async (t) => {
  const fake = fakeBd(t, `printf '../other/.beads\\n' > .beads/redirect
rm -f .beads/redirect
printf '[]\\n'`)
  await assert.rejects(fake.runner()(['list']), { message: 'the store directory redirects to another store' })
})

test('bd failures cannot leak stdout or stderr, and a hung bd times out', async (t) => {
  const failure = fakeBd(t, 'echo token_fake_stdout; echo token_fake_stderr >&2; exit 3')
  await assert.rejects(failure.runner()(['list']), { message: 'bd list failed with exit code 3' })
  const slow = fakeBd(t, 'exec sleep 2', 100)
  await assert.rejects(slow.runner()(['list']), { message: 'bd list timed out' })
})
