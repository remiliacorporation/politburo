import { execFile, type ExecFileException } from 'node:child_process'
import { lstat, mkdtemp, rm, watch } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { promisify } from 'node:util'
import type { BdRunner } from './types.ts'

const exec = promisify(execFile)
export const beadId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function checkArgs(args: readonly string[]) {
  const [verb] = args
  const refused = () => new Error(`bd call refused: ${verb ?? '(missing)'}`)
  if (verb !== 'list' && verb !== 'ready' && verb !== 'blocked') throw refused()
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--json' || (verb === 'list' && flag === '--all')) continue
    if (flag === '-n') {
      if (args[++i] === '0') continue
    } else if (flag === '--parent' || (verb === 'list' && flag === '--id')) {
      if (beadId.test(args[++i] ?? '')) continue
    }
    throw refused()
  }
  return verb
}

export function bdRunner({ dir, bin = 'bd', timeoutMs = 30_000 }: {
  dir: string; bin?: string; timeoutMs?: number
}): BdRunner & { close(): Promise<void> } {
  let home: string | undefined
  let tail = Promise.resolve()
  let closing: Promise<void> | undefined

  const run: BdRunner = async (args) => {
    if (closing) throw new Error('bd runner is closed')
    // Validate the same snapshot that will be passed to execFile after waiting.
    const argv = [...args]
    const verb = checkArgs(argv)
    const call = tail.then(async () => {
      // Preserve cwd's path semantics (e.g. a symlink followed by '..').
      const path = `${dir}${dir.endsWith(sep) ? '' : sep}.beads`
      const store = isAbsolute(dir) && await lstat(path).catch(() => undefined)
      if (!store || !store.isDirectory()) throw new Error('no .beads in the store directory')
      const ac = new AbortController()
      let redirected = false
      const watching = (async () => {
        try {
          for await (const event of watch(path, { signal: ac.signal, persistent: false })) {
            if (event.filename == null || String(event.filename) === 'redirect') redirected = true
          }
        } catch (error) {
          if ((error as Error).name !== 'AbortError') redirected = true
        }
      })()
      const redirectPresent = async () => {
        const redirect = await lstat(`${path}${sep}redirect`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw new Error('cannot check for a store redirect')
        })
        if (redirect || redirected) throw new Error('the store directory redirects to another store')
      }
      try {
        await new Promise((resolve) => setImmediate(resolve))
        await redirectPresent()
        home ??= await mkdtemp(join(tmpdir(), 'swarm-bd-')).catch(() => {
          throw new Error('cannot create temporary bd home')
        })
        const env = {
          PATH: process.env.PATH, HOME: home, BD_NON_INTERACTIVE: '1', NO_COLOR: '1',
          // Node otherwise forwards this variable even with an explicit env.
          NODE_V8_COVERAGE: undefined,
        }
        Object.setPrototypeOf(env, null)
        let stdout: string
        try {
          stdout = (await exec(bin, ['--readonly', '--sandbox', ...argv], {
            cwd: dir, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
          })).stdout
        } catch (failure) {
          const { code, killed } = failure as ExecFileException
          if (code === 'ENOENT') throw new Error('bd not found')
          if (typeof code === 'number') throw new Error(`bd ${verb} failed with exit code ${code}`)
          if (killed && code === null) throw new Error(`bd ${verb} timed out`)
          throw new Error(`bd ${verb} failed`)
        }
        await new Promise((resolve) => setImmediate(resolve))
        await redirectPresent()
        return stdout
      } finally {
        ac.abort()
        await watching
      }
    })
    tail = call.then(() => {}, () => {})
    return call
  }

  const close = () => closing ??= tail.then(async () => {
    if (home === undefined) return
    await rm(home, { recursive: true, force: true }).catch(() => {
      throw new Error('cannot remove temporary bd home')
    })
  })
  return Object.assign(run, { close })
}
