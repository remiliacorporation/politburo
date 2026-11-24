import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const usage = 'usage: swarm setup build [--out FILE]'

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'setup', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env,
  })
  if (result.error) throw result.error
  return result
}

function build() {
  const result = run(['build'])
  assert.equal(result.status, 0, 'setup build failed')
  return result.stdout
}

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-setup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const mode = (path: string) => statSync(path).mode & 0o777

test('setup build omits the v11 pin or hashes the wrong bytes', () => {
  const [shebang, pin = '', ...body] = build().split('\n')
  assert.equal(shebang, '#!/bin/bash')
  assert.match(pin, /^# politburo-setup v11 sha256:[0-9a-f]{64}$/)
  const hash = createHash('sha256').update(body.join('\n')).digest('hex')
  assert.equal(pin, `# politburo-setup v11 sha256:${hash}`)
})

test('setup build changes bytes between runs', () => {
  assert.ok(build() === build(), 'builds differ')
})

test('setup build --out writes different bytes or misreports the pin', (t) => {
  const text = build()
  const hash = text.split('\n')[1]?.split(':')[1]?.slice(0, 12)
  const out = join(tempDir(t), 'setup.sh')
  const result = run(['build', '--out', out])
  assert.equal(result.status, 0)
  assert.ok(readFileSync(out).equals(Buffer.from(text)), '--out differs from stdout')
  assert.equal(result.stdout, `wrote ${out} (v11 sha256:${hash})\n`)
})

test('setup build --out does not write through a symlink at the target', (t) => {
  const dir = tempDir(t)
  const victim = join(dir, 'victim')
  const out = join(dir, 'setup.sh')
  writeFileSync(victim, 'unchanged\n', { mode: 0o600 })
  symlinkSync(victim, out)

  const result = run(['build', '--out', out])
  assert.equal(result.status, 0)
  assert.ok(readFileSync(victim, 'utf8') === 'unchanged\n', 'symlink target was overwritten')
  assert.equal(mode(victim), 0o600)
  assert.ok(lstatSync(out).isFile(), '--out did not replace the symlink with a regular file')
  assert.ok(readFileSync(out, 'utf8') === build(), '--out differs from stdout')
})

test('setup build refuses a marker outside its allowlist', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'src/sprite'), { recursive: true })
  mkdirSync(join(dir, 'sprite'))
  for (const file of ['build.ts', 'cli.ts']) {
    copyFileSync(new URL(`../src/sprite/${file}`, import.meta.url), join(dir, 'src/sprite', file))
  }
  writeFileSync(join(dir, 'sprite/models-store.json'), '{}\n')
  writeFileSync(join(dir, 'sprite/pi-task'), 'fixture\n')
  for (const marker of ['@@file:models-store.json@@', '@@gz:pi-task@@', '@@gz:setup.sh.in@@']) {
    writeFileSync(join(dir, 'sprite/setup.sh.in'), `#!/bin/bash\n${marker}\n`)
    const result = spawnSync(process.execPath, [
      '--input-type=module', '--eval',
      "import { runSetup } from './src/sprite/cli.ts'; process.exitCode = runSetup(['build'])",
    ], { cwd: dir, encoding: 'utf8', env: {} })
    if (result.error) throw result.error
    assert.equal(result.status, 1, `${marker} was not refused`)
    assert.equal(result.stderr, `error: unknown setup template marker ${marker}\n`)
  }
})

test('setup misuse loses its exit code or stderr usage', () => {
  for (const args of [[], ['bogus'], ['build', '--nope']]) {
    const result = run(args)
    assert.equal(result.status, 2, `setup ${args.join(' ')}`)
    const [error = '', hint] = result.stderr.split('\n')
    assert.match(error, /^error: /)
    assert.equal(hint, usage)
  }
})

test('setup --help exits as misuse', () => {
  assert.equal(run(['--help']).status, 0)
})

test('setup build embeds a secret from the caller environment', () => {
  const env = {
    PI_CODEX_AUTH: 'FAKE-ONLY-codex-77e469',
    PI_CURSOR: 'FAKE-ONLY-cursor-4791d2',
    PI_CODEX_PERSONAL_AUTH: 'FAKE-ONLY-personal-6c5d89',
  }
  const result = run(['build'], env)
  assert.equal(result.status, 0)
  for (const [name, fake] of Object.entries(env)) {
    assert.ok(!(result.stdout + result.stderr).includes(fake), `build leaks ${name}`)
  }
})

function sandbox(t: TestContext, hasPi = true) {
  const dir = tempDir(t)
  const home = join(dir, 'home'), bin = join(dir, 'bin'), tools = join(dir, 'tools')
  const root = join(dir, 'npm'), log = join(dir, 'installs')
  const bundle = join(root, '@earendil-works/pi-coding-agent/dist/bundle')
  for (const path of [home, bin, tools, bundle]) mkdirSync(path, { recursive: true })
  // Whitelist shell utilities so neither real Pi nor network commands can run.
  for (const cmd of ['base64', 'cat', 'chmod', 'cp', 'dirname', 'find', 'grep', 'gunzip', 'gzip', 'head', 'mkdir', 'rm']) {
    const path = ['/usr/bin', '/bin'].map((d) => join(d, cmd)).find(existsSync)
    assert.ok(path, `missing ${cmd}`)
    symlinkSync(path, join(tools, cmd))
  }
  symlinkSync(process.execPath, join(tools, 'node'))
  const stub = (path: string, body: string) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  stub(join(bin, 'bun'), 'exit 0')
  stub(join(dir, 'pi-stub'), '[ "$1" != install ] || printf "%s\\0" pi "$@" >> "$INSTALL_LOG"')
  if (hasPi) writeFileSync(join(bin, 'pi'), readFileSync(join(dir, 'pi-stub')), { mode: 0o755 })
  stub(join(bin, 'npm'), `
case "$1" in
  root) [ "$2" = -g ] && printf '%s\\n' "$NPM_ROOT";;
  install) printf '%s\\0' npm "$@" >> "$INSTALL_LOG"; cp -p "$PI_STUB" "$BIN/pi";;
  *) exit 1;;
esac`)
  writeFileSync(join(bundle, 'cli.js'), '')
  const script = join(dir, 'setup.sh')
  writeFileSync(script, build())
  function setup() {
    const result = spawnSync('/bin/bash', [script], {
      cwd: dir, timeout: 10_000, env: {
        HOME: home, PATH: `${bin}:${tools}`, NPM_ROOT: root, INSTALL_LOG: log,
        BIN: bin, PI_STUB: join(dir, 'pi-stub'),
        PI_CODEX_AUTH: Buffer.from('{"openai-codex":{"access":"fake","expires":1}}').toString('base64'),
      },
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'setup script failed')
  }
  return { home, bin, log, setup, agent: join(home, '.pi/agent') }
}

test('setup installs unpinned packages or reinstalls Pi already on PATH', (t) => {
  for (const hasPi of [true, false]) {
    const { log, setup } = sandbox(t, hasPi)
    setup()
    const npm = hasPi ? [] : ['npm', 'install', '-g', '@earendil-works/pi-coding-agent@1.4.0']
    assert.deepEqual(readFileSync(log, 'utf8').split('\0'), [...npm, 'pi', 'install', 'npm:@ifi/pi-provider-cursor@0.5.1', ''])
  }
})

test('setup installs incorrect helpers, wrapper, or Pi agent files', (t) => {
  const { bin, agent, setup } = sandbox(t)
  setup()
  function matches(path: string, source: string) {
    assert.ok(readFileSync(path).equals(readFileSync(new URL(`../sprite/${source}`, import.meta.url))), `${source} bytes differ`)
  }
  for (const helper of ['pi-auth-ensure', 'pi-task', 'sprite-start', 'sprite-watch', 'sprite-stop']) {
    const path = join(bin, helper)
    assert.equal(mode(path), 0o755, helper)
    matches(path, helper)
  }
  const pi = readFileSync(join(bin, 'pi'), 'utf8')
  assert.ok(pi.startsWith('#!/bin/sh\n') && pi.includes('pi-auth-ensure') && pi.includes('exec node'), 'Pi wrapper missing')
  matches(join(agent, 'extensions/codex-cursor-fallback.ts'), 'codex-cursor-fallback.ts')
  matches(join(agent, 'models-store.json'), 'models-store.json')
  const settings = JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8'))
  assert.ok(settings.defaultProvider === 'fallback' && settings.defaultModel === 'codex-cursor', 'wrong Pi defaults')
  assert.equal(mode(join(agent, 'auth.json')), 0o600)
})

test('setup exits nonzero if it cannot write Pi settings', (t) => {
  const { agent, setup } = sandbox(t)
  mkdirSync(join(agent, 'settings.json'), { recursive: true })
  setup()
})

test('rerunning setup duplicates or omits the startup auth hook', (t) => {
  const { home, setup } = sandbox(t)
  setup()
  setup()
  for (const file of ['.bashrc', '.profile']) {
    const hooks = readFileSync(join(home, file), 'utf8').split('\n').filter((line) => line.includes('pi-auth-ensure'))
    assert.equal(hooks.length, 1, file)
  }
})
