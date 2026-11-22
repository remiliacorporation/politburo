import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const helpers = fileURLToPath(new URL('../sprite/', import.meta.url))
const sprites = '/tmp/sprites'
const reply = 'fake assistant reply'
const event = JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', provider: 'fake', model: 'test', content: [{ type: 'text', text: reply }] },
})
const read = (path: string) => readFileSync(path, 'utf8')

async function until(check: () => boolean, message: string, ms = 8000) {
  const deadline = Date.now() + ms
  while (!check()) {
    assert.ok(Date.now() < deadline, message)
    await delay(25)
  }
}

function running(pid: number) {
  // An orphan can remain as a zombie if the container's PID 1 doesn't reap it.
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', env: {} })
  if (ps.error) throw ps.error
  return ps.status === 0 && !ps.stdout.trimStart().startsWith('Z')
}

function fixture(t: TestContext, behavior: 'success' | 'fail' | 'sleep' = 'success') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sprite-test-')))
  const name = `t${process.pid}-${basename(home).slice(-6)}`
  const state = join(sprites, name)
  const cwd = join(home, 'repo')
  const ready = join(home, 'pi-ready')
  const env = {
    HOME: home, PATH: [home, helpers, dirname(process.execPath), process.env.PATH].join(':'),
    GIT_CONFIG_NOSYSTEM: '1', PI_TASK_LOG: `${state}.jsonl`,
  }
  const pids = () => read(ready).trim().split(' ').map(Number)
  let started = false
  t.after(() => {
    try {
      // Also clean up if an assertion fails before a slow fake or its wrapper is stopped.
      const groups = started && existsSync(`${state}.pid`) ? [[Number(read(`${state}.pid`))]] : []
      if (existsSync(ready)) groups.push(pids())
      for (const group of groups) {
        const [leader] = group
        if (leader === undefined || leader <= 1 || !group.some(running)) continue
        try { process.kill(-leader, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    } finally {
      for (const entry of readdirSync(sprites)) {
        if (entry === name || entry.startsWith(`${name}.`)) rmSync(join(sprites, entry), { recursive: true, force: true })
      }
      rmSync(home, { recursive: true, force: true })
    }
  })
  mkdirSync(sprites, { recursive: true })
  mkdirSync(cwd)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd, env }).status, 0)
  writeFileSync(join(cwd, 'task'), 'fake task\n')
  writeFileSync(join(cwd, 'empty'), '')
  const script = behavior === 'sleep'
    ? `trap '' TERM\nsleep 60 &\nprintf '%s %s\\n' "$$" "$!" > "$HOME/pi-ready.tmp"\nmv "$HOME/pi-ready.tmp" "$HOME/pi-ready"\nexec sleep 60`
    : behavior === 'fail' ? 'exit 7' : `printf '%s\\n' '${event}'`
  writeFileSync(join(home, 'pi'), `#!/bin/sh\n${script}\n`, { mode: 0o700 })

  function run(helper: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
    if (helper === 'sprite-start' && args[1] === 'task') started = true
    return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(join(helpers, helper), args, {
        cwd, env: { ...env, ...overrides }, timeout: 22000, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        if (!error) resolve({ status: 0, stdout, stderr })
        else if (typeof error.code === 'number') resolve({ status: error.code, stdout, stderr })
        else reject(error)
      })
    })
  }
  return { home, name, state, cwd, run, ready, pids }
}

describe('sprite helpers', { concurrency: true }, () => {
  test('pi-task exits 2 with usage for an omitted, missing, or empty task file', async (t) => {
    const { run } = fixture(t)
    for (const args of [[], ['missing'], ['empty']]) {
      const result = await run('pi-task', args)
      assert.equal(result.status, 2)
      assert.match(result.stderr, /^usage: pi-task /)
    }
  })

  test('pi-task passes through 0 and prints the status, model, and assistant reply', async (t) => {
    const result = await fixture(t).run('pi-task', ['task'])
    assert.equal(result.status, 0)
    assert.match(result.stdout, new RegExp(`^pi-task: rc=0 secs=\\d+\npi-task: model fake/test\n${reply}\n$`))
  })

  test('pi-task passes through 7 and prints the failing status', async (t) => {
    const result = await fixture(t, 'fail').run('pi-task', ['task'])
    assert.equal(result.status, 7)
    assert.match(result.stdout, /^pi-task: rc=7\b/m)
  })

  for (const [code, reason, max, idle] of [[124, 'timeout', '1', '180'], [125, 'idle', '180', '1']] as const) {
    test(`pi-task exits ${code} and kills the pi process group on ${reason}`, async (t) => {
      const { run, pids } = fixture(t, 'sleep')
      const result = await run('pi-task', ['task', max], { PI_IDLE_SECONDS: idle })
      assert.equal(result.status, code)
      assert.match(result.stdout, new RegExp(`^pi-task: rc=${code} secs=\\d+ \\(${reason}`, 'm'))
      const group = pids()
      await until(() => group.every(pid => !running(pid)), 'pi process group is still running', 1000)
    })
  }

  test('sprite-start exits 2 with usage for too few arguments or a missing or empty task file', async (t) => {
    const { run, name } = fixture(t)
    for (const args of [[], [name], [name, 'missing'], [name, 'empty']]) {
      const result = await run('sprite-start', args)
      assert.equal(result.status, 2)
      assert.match(result.stderr, /^usage: sprite-start /)
    }
  })

  test('sprite-start exits 0 with the three-line banner and the detached job writes rc and out', async (t) => {
    const { run, name, state, cwd } = fixture(t)
    const result = await run('sprite-start', [name, 'task'])
    await until(() => existsSync(`${state}.rc`) && statSync(`${state}.rc`).size > 0, 'detached job did not write rc')
    assert.equal(result.status, 0)
    assert.equal(result.stdout, `sprite ${name} started in ${cwd}\n`
      + `  live log: ${state}.jsonl   session: ${state}/   result: ${state}.out   exit code: ${state}.rc\n`
      + `  watch: sprite-watch ${name}   stop: sprite-stop ${name}\n`)
    assert.equal(read(`${state}.rc`).trim(), '0')
    assert.match(read(`${state}.out`), /^pi-task: pid /m)
  })

  test('sprite-watch exits 2 and reports no sprite named on stderr for an unknown name', async (t) => {
    const { run, name } = fixture(t)
    const result = await run('sprite-watch', [name])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /^no sprite named /)
  })

  for (const [status, scenario, rc] of [
    [0, 'rc is 0', '0'], [1, 'rc is 125', '125'], [3, 'the log is idle'], [10, 'the window ends while running'],
  ] as const) {
    test(`sprite-watch exits ${status} when ${scenario}`, async (t) => {
      const { run, state, name } = fixture(t)
      writeFileSync(`${state}.pid`, '1\n')
      writeFileSync(`${state}.jsonl`, `${event}\n`)
      if (rc !== undefined) {
        writeFileSync(`${state}.rc`, `${rc}\n`)
        writeFileSync(`${state}.out`, `${reply}\n`)
      }
      if (status === 3) utimesSync(`${state}.jsonl`, 1, 1)
      const result = await run('sprite-watch', [name, '1'], { SPRITE_IDLE_SECONDS: status === 3 ? '1' : '180' })
      assert.equal(result.status, status)
    })
  }

  test('sprite-stop exits 0, prints stopped, and records 137 for an unknown name', async (t) => {
    const { run, state, name } = fixture(t)
    const result = await run('sprite-stop', [name])
    assert.equal(result.status, 0)
    assert.equal(result.stdout, `sprite ${name} stopped\n`)
    assert.equal(read(`${state}.rc`).trim(), '137')
  })

  test('sprite-stop leaves an existing rc unchanged', async (t) => {
    const { run, state, name } = fixture(t)
    writeFileSync(`${state}.rc`, '7\n')
    assert.equal((await run('sprite-stop', [name])).status, 0)
    assert.equal(read(`${state}.rc`), '7\n')
  })

  test('sprite-stop exits 0 and kills a running pi started by sprite-start', async (t) => {
    const { run, name, state, ready, pids } = fixture(t, 'sleep')
    await run('sprite-start', [name, 'task'])
    const pidFile = `${state}.jsonl.pid`
    await until(() => existsSync(ready) && existsSync(pidFile) && statSync(pidFile).size > 0, 'fake pi did not start')
    const group = pids()
    assert.ok(group.every(running), 'fake pi process group was not running')
    assert.equal((await run('sprite-stop', [name])).status, 0)
    await until(() => group.every(pid => !running(pid)), 'pi process group is still running', 1000)
  })

  test('sprite-stop exits nonzero without a name', async (t) => {
    assert.notEqual((await fixture(t).run('sprite-stop')).status, 0)
  })

  test('pi-auth-ensure exits 0 without creating .pi when auth is unset', async (t) => {
    const { home, run } = fixture(t)
    assert.equal((await run('pi-auth-ensure')).status, 0)
    assert.ok(!existsSync(join(home, '.pi')))
  })

  test('pi-auth-ensure exits 0 without writing auth.json for malformed auth', async (t) => {
    const { home, run } = fixture(t)
    assert.equal((await run('pi-auth-ensure', [], { PI_CODEX_AUTH: 'not valid base64 or JSON!' })).status, 0)
    assert.ok(!existsSync(join(home, '.pi/agent/auth.json')))
  })

  test('pi-auth-ensure exits 0, writes mode 600 auth, and does not replace newer auth', async (t) => {
    const { home, run } = fixture(t)
    const path = join(home, '.pi/agent/auth.json')
    const provider = (expires: number) => ({ 'openai-codex': { access: 'x', expires } })
    for (const expires of [10, 5]) {
      const encoded = Buffer.from(JSON.stringify(provider(expires))).toString('base64')
      assert.equal((await run('pi-auth-ensure', [], { PI_CODEX_AUTH: encoded })).status, 0)
      assert.equal(statSync(path).mode & 0o777, 0o600)
      assert.ok(isDeepStrictEqual(JSON.parse(read(path)), provider(10)), 'expected the newer fake provider')
    }
  })
})
