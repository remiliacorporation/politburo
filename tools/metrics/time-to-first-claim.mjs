#!/usr/bin/env node
// Usage: node tools/metrics/time-to-first-claim.mjs [checkout]
// Times a fresh clone through independent verification, with pnpm on PATH.
// TTFC_PNPM_STORE_DIR can reuse an existing store; a cold store needs registry access.
// TTFC_TIMEOUT_SECONDS bounds the run before the separate cleanup budget.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs'
import { readdir, readFile, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const metric = 'time-to-first-claim'
const maxOutput = 64 * 1024
const networkEnvKeys = [
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  'npm_config_cafile', 'npm_config_registry', 'NPM_CONFIG_CAFILE', 'NPM_CONFIG_REGISTRY',
]
const seconds = (ms) => Number((ms / 1000).toFixed(2))
class JudgeError extends Error {}

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

const linux = process.platform === 'linux'
const gone = (error) => error.code === 'ENOENT' || error.code === 'ESRCH'
const inside = (path, parent) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

async function reapMarkedProcesses(runId) {
  const marker = Buffer.from(`\0TTFC_RUN_ID=${runId}\0`)
  // Wait for killed processes to stop (zombies have no environment), then scan
  // again for helpers forked or detached while their parents were being killed.
  while (true) {
    let found = false
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      const data = await readFile(`/proc/${pid}/environ`).catch((error) => {
        if (!gone(error) && error.code !== 'EACCES' && error.code !== 'EPERM') throw error
      })
      if (!data || !Buffer.concat([Buffer.from([0]), data]).includes(marker)) continue
      found = true
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch (error) {
        if (!gone(error)) throw error
      }
    }
    if (!found) return
    await delay(20)
  }
}

async function linuxListener(pid, port) {
  const proc = `/proc/${pid}`
  const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`
  const sockets = (await readFile(`${proc}/net/tcp`, 'utf8')).split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === address && fields[3] === '0A')
    .map((fields) => `socket:[${fields[9]}]`)
  for (const fd of await readdir(`${proc}/fd`)) {
    const target = await readlink(`${proc}/fd/${fd}`).catch((error) => {
      if (!gone(error)) throw error
    })
    if (sockets.includes(target)) return true
  }
  return false
}

async function verifyTask(url, config, board, id, result, signal) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 32)
  const login = join(config, 'board', 'local', `${hash}.json`)
  let response
  try {
    if (await realpath(login) === login) {
      const saved = JSON.parse(await readFile(login, { encoding: 'utf8', signal }))
      if (saved.url === url && typeof saved.token === 'string' && saved.token) {
        response = await fetch(`${url}/messages/${id}`, {
          headers: { authorization: `Bearer ${saved.token}` },
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        })
      }
    }
  } catch {
    // An unavailable login or transport permits a read of the local store instead.
    signal.throwIfAborted()
  }
  const completed = (message) => String(message?.id) === id &&
    message?.task?.state === 'completed' && message.task.result === result
  if (response?.ok) {
    const view = await response.json().catch(() => null)
    signal.throwIfAborted()
    if (completed(view?.message)) return 'http'
    throw new JudgeError('independent HTTP read did not verify the completed task')
  }
  await response?.body?.cancel()
  if (response && ![401, 403, 405, 501].includes(response.status)) {
    throw new JudgeError('independent HTTP read failed')
  }
  // No usable HTTP read. Read only the default board's own disposable database.
  // A contradictory HTTP answer above must never be overridden by this fallback.
  try {
    const path = join(board, 'local.db')
    if (await realpath(path) === path) {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const row = db.prepare('select data from board_messages where id = ? and deleted = 0').get(id)
        if (row && completed(JSON.parse(row.data))) return 'sqlite'
      } finally {
        db.close()
      }
    }
  } catch {
    // Never include an HTTP body, filesystem contents, or credentials in errors.
  }
  throw new JudgeError('independent verification could not confirm the completed task')
}

async function measure(checkout, timeoutMs) {
  const children = new Set()
  const controller = new AbortController()
  const { signal } = controller
  const interrupt = () => controller.abort(new JudgeError('interrupted by SIGINT'))
  const terminate = () => controller.abort(new JudgeError('interrupted by SIGTERM'))
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  const deadlineAt = performance.now() + timeoutMs
  const deadline = setTimeout(() => controller.abort(new JudgeError('measurement timed out')), timeoutMs)
  const stopped = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  const runId = randomUUID()
  let dir
  let commands = 0
  let boardCommands = 0
  let cloneStart
  let groupKillFailed = false
  if (!linux) process.stderr.write(`${metric}: containment is process-group only on this platform\n`)

  function killGroup(child) {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') {
        groupKillFailed = true
        controller.abort(new JudgeError('could not kill a child process group'))
      }
    }
  }

  function start(label, executable, args, env, capture = false, cwd = dir) {
    signal.throwIfAborted()
    if (cloneStart !== undefined) commands++
    if (label.startsWith('vb ')) boardCommands++
    const child = spawn(executable, args, {
      cwd, env, detached: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
    })
    // Child output can contain local credentials. Never forward it or include it in an error.
    const run = { child, output: '', exited: false, closed: undefined }
    children.add(run)
    child.stdout?.setEncoding('utf8').on('data', (chunk) => {
      if (run.output.length + chunk.length > maxOutput) {
        controller.abort(new JudgeError(`${label} produced too much output`))
      } else {
        run.output += chunk
      }
    })
    let failedToSpawn = false
    child.once('error', () => { failedToSpawn = true; run.exited = true })
    child.once('exit', () => {
      run.exited = true
      killGroup(child) // Also stop descendants after their leader exits.
    })
    run.closed = new Promise((done) => child.once('close', (code) => {
      children.delete(run)
      done(failedToSpawn ? `${label} could not start` : code === 0 ? null : `${label} failed (${code ?? 'signal'})`)
    }))
    return run
  }

  async function command(label, executable, args, env, capture, cwd) {
    const run = start(label, executable, args, env, capture, cwd)
    const error = await run.closed
    if (error) throw new JudgeError(error)
    signal.throwIfAborted()
    return run.output.trim()
  }

  async function run() {
    try {
      checkout = realpathSync(checkout)
    } catch {
      throw new JudgeError('checkout is not a board workspace')
    }
    const temp = realpathSync(tmpdir())
    if (inside(temp, checkout)) throw new JudgeError('temporary directory must be outside the checkout')
    dir = mkdtempSync(join(temp, 'time-to-first-claim-'))
    const env = {
      PATH: process.env.PATH,
      CI: 'true',
      HOME: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data-home'),
      XDG_CACHE_HOME: join(dir, 'cache'),
      XDG_STATE_HOME: join(dir, 'state'),
      TMPDIR: join(dir, 'tmp'),
      TTFC_RUN_ID: runId,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    }
    mkdirSync(env.HOME)
    mkdirSync(env.TMPDIR)
    const root = await command('git rev-parse', 'git', ['-C', checkout, 'rev-parse', '--show-toplevel'], env, true)
      .catch(() => { throw new JudgeError('checkout is not a board workspace') })
    if (root !== checkout) throw new JudgeError('checkout is not a board workspace')
    const sourceHead = await command('git rev-parse', 'git', ['-C', checkout, 'rev-parse', '--verify', 'HEAD'], env, true)
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceHead)) throw new JudgeError('checkout has no valid HEAD')
    const dirty = Boolean(await command('git status', 'git',
      ['--no-optional-locks', '-C', checkout, 'status', '--porcelain=v1', '--untracked-files=no'], env, true))

    let store = join(dir, 'pnpm-store')
    const requestedStore = process.env.TTFC_PNPM_STORE_DIR
    if (requestedStore && statSync(requestedStore, { throwIfNoEntry: false })?.isDirectory()) {
      store = realpathSync(requestedStore)
      if (inside(store, checkout) || inside(checkout, store)) {
        throw new JudgeError('TTFC_PNPM_STORE_DIR must be separate from the checkout')
      }
    }
    const clone = join(dir, 'clone')
    cloneStart = performance.now()
    await command('git clone', 'git', ['clone', '--no-local', '--template=', '--', checkout, clone], env)
    const cloneMs = performance.now() - cloneStart
    if (!isFile(join(clone, 'pnpm-workspace.yaml')) || !isFile(join(clone, 'packages/board/package.json'))) {
      throw new JudgeError('checkout is not a board workspace')
    }
    const cloneHead = () => command('git rev-parse', 'git', ['rev-parse', '--verify', 'HEAD'], env, true, clone)
    if (await cloneHead() !== sourceHead) throw new JudgeError('clone HEAD does not match the checkout HEAD')
    // Only pnpm needs registry access. Its version manager uses the binary on
    // PATH if it matches the pin, or bootstraps the pin inside the disposable HOME.
    const pnpmEnv = { ...env }
    for (const key of networkEnvKeys) {
      const value = process.env[key]
      if (value !== undefined) pnpmEnv[key] = value
    }
    const installStart = performance.now()
    await command('pnpm install', 'pnpm', ['install', '--frozen-lockfile', '--store-dir', store], pnpmEnv, false, clone)
    const installMs = performance.now() - installStart
    const buildStart = performance.now()
    await command('pnpm build', 'pnpm', ['build'], pnpmEnv, false, clone)
    const buildMs = performance.now() - buildStart
    const cli = join(clone, 'packages/board/dist/cli.mjs')
    if (!isFile(cli) || await realpath(cli) !== cli) throw new JudgeError('pnpm build did not produce the clone board CLI')
    const head = await cloneHead()
    if (head !== sourceHead) throw new JudgeError('clone HEAD changed during install or build')

    const serveStart = performance.now()
    const board = join(dir, 'board')
    // Local-login mode binds 127.0.0.1; --host is only for team mode. Port 0
    // lets serve itself reserve a free port, without a find-then-bind race.
    const server = start('vb serve', process.execPath,
      [cli, 'serve', '--agent-ops', '--port', '0', '--dir', board, '--no-inspect'], env, true, clone)
    let url
    while (!url) {
      if (server.exited) throw new JudgeError('vb serve exited before readiness')
      // serve announces only after the listener, log, and disposable login are ready.
      url = /^serving a local board at (http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/api\/board) as [^\r\n]+\r?\n/m.exec(server.output)?.[1]
      if (!url) await delay(25, undefined, { signal })
    }
    async function assertServeProcess() {
      const pid = server.child.pid
      const port = Number(new URL(url).port || 80)
      let owned
      try {
        if (linux) {
          const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
          owned = args[1] === cli && args[2] === 'serve' &&
            await readlink(`/proc/${pid}/exe`) === await readlink('/proc/self/exe') &&
            await readlink(`/proc/${pid}/cwd`) === clone && await linuxListener(pid, port)
        } else {
          // With no procfs, lsof checks the spawned PID's cwd and listener.
          const files = await command('lsof', 'lsof', ['-nP', '-p', String(pid), '-FfnT'], env, true)
          const records = files.split(/\nf/)
          owned = records.some((record) => record.startsWith('cwd\n') && record.split('\n').includes(`n${clone}`)) &&
            records.some((record) => record.split('\n').includes(`n127.0.0.1:${port}`) && record.split('\n').includes('TST=LISTEN'))
        }
      } catch {
        signal.throwIfAborted()
      }
      if (!owned || server.exited) throw new JudgeError('vb serve PID does not own the clone board listener')
    }
    await assertServeProcess()
    const vb = (label, args, capture = false) => {
      if (server.exited) throw new JudgeError('vb serve exited before verification')
      return command(label, process.execPath, [cli, '--url', url, ...args], env, capture, clone)
    }
    const json = async (label, args) => {
      const output = await vb(label, [...args, '--json'], true)
      try {
        return JSON.parse(output)
      } catch {
        throw new JudgeError(`${label} did not return valid JSON`)
      }
    }
    // Separate profile identities use the same disposable local login. vb alone
    // manages that login and the claim receipt inside the isolated config dir.
    const created = await json('vb tasks create',
      ['--as', 'creator', 'tasks', 'create', 'work', 'Measure a local task handoff', '--no-sync'])
    const id = String(created?.task?.id)
    const author = created?.task?.by
    if (!/^\d+$/.test(id) || author?.profile !== 'creator' || !author.principal) {
      throw new JudgeError('vb tasks create did not verify the creator and task ID')
    }
    const claimed = await json('vb tasks claim', ['--as', 'worker', 'tasks', 'claim', id])
    if (String(claimed?.task?.id) !== id || claimed?.task?.task?.claim?.actor !== `${author.principal}+worker`) {
      throw new JudgeError('vb tasks claim did not verify a claim by the worker')
    }
    const result = 'Local handoff verified'
    await vb('vb tasks complete', ['--as', 'worker', 'tasks', 'complete', id, result])
    const message = (await json('vb read', ['--as', 'creator', 'read', id]))?.message
    if (String(message?.id) !== id || message?.task?.state !== 'completed' || message.task.result !== result) {
      throw new JudgeError('vb read did not verify the completed task')
    }
    const verifiedBy = await verifyTask(url, env.XDG_CONFIG_HOME, board, id, result, signal)
    await assertServeProcess()
    const finished = performance.now()
    return {
      metric, seconds: seconds(finished - cloneStart), commands,
      clone_seconds: seconds(cloneMs), install_seconds: seconds(installMs), build_seconds: seconds(buildMs),
      board_seconds: seconds(finished - serveStart), board_commands: boardCommands,
      head, dirty, node: process.version, task_final_state: 'done', verified_by: verifiedBy,
    }
  }

  try {
    const result = await Promise.race([run(), stopped])
    signal.throwIfAborted()
    if (performance.now() >= deadlineAt) throw new JudgeError('measurement timed out')
    return result
  } finally {
    clearTimeout(deadline)
    // Give reaping and deletion a separate short budget, even after a timeout.
    // Force exit only if cleanup itself cannot finish, with no metric output.
    const cleanupDeadline = setTimeout(() => {
      process.stderr.write(`${metric}: cleanup timed out\n`)
      process.exit(1)
    }, 3000)
    try {
      const active = [...children]
      for (const { child } of active) killGroup(child)
      if (linux) await reapMarkedProcesses(runId)
      await Promise.all(active.map(({ closed }) => closed))
      if (linux) await reapMarkedProcesses(runId)
      if (groupKillFailed) throw new JudgeError('could not kill a child process group')
      if (dir) await rm(dir, { recursive: true, force: true })
    } catch (error) {
      throw error instanceof JudgeError ? error : new JudgeError('could not clean up disposable run')
    } finally {
      clearTimeout(cleanupDeadline)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
    signal.throwIfAborted()
  }
}

try {
  if (process.argv.length > 3) throw new JudgeError('usage: time-to-first-claim.mjs [checkout]')
  if (process.platform === 'win32') throw new JudgeError('POSIX process groups are required')
  const timeoutMs = Number(process.env.TTFC_TIMEOUT_SECONDS ?? '300') * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
    throw new JudgeError('TTFC_TIMEOUT_SECONDS must specify a valid positive timeout')
  }
  const result = await measure(resolve(process.argv[2] ?? repo), timeoutMs)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${metric}: ${error instanceof JudgeError ? error.message : 'judge failed'}\n`)
  process.exitCode = 1
}
