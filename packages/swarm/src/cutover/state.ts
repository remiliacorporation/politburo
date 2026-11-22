import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Gate } from './gate.ts'
import { currentTag, CutoverError, hasOnly, newTag } from './ports.ts'

export interface State {
  tag: string
  mode: 'files' | 'service'
  pending?: 'applying' | 'rolling_back'
  renameTo?: string
  gate?: Gate
  history: { at: string; event: string; detail?: string }[]
}

function statePath(stateDir: string, tag: string) {
  if (!currentTag.test(tag)) throw new CutoverError('invalid_tag', 'invalid cutover tag')
  return join(stateDir, `${tag}.json`)
}

export async function withStateLock<T>(stateDir: string, tag: string, run: () => Promise<T>): Promise<T> {
  if (!currentTag.test(tag)) throw new CutoverError('invalid_tag', 'invalid cutover tag')
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  return withLock(join(stateDir, `${tag}.lock`), new CutoverError('locked', `another cutover for ${tag} is running`), run)
}

async function withLock<T>(file: string, locked: CutoverError, run: () => Promise<T>): Promise<T> {
  let handle
  for (;;) {
    try { handle = await open(file, 'wx', 0o600); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!await staleLock(file, locked)) continue
    // Serialize stale cleanup so a contender cannot unlink a new owner's lock.
    await withLock(`${file}.reap`, locked, async () => {
      if (await staleLock(file, locked)) await rm(file)
    })
  }
  try {
    try { await handle.writeFile(`${process.pid}\n`) } finally { await handle.close() }
    return await run()
  } finally { await rm(file) }
}

async function staleLock(file: string, locked: CutoverError): Promise<boolean> {
  let text: string
  try { text = (await readFile(file, 'utf8')).trim() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const pid = Number(text)
  // An empty file may be an owner still writing its PID. Fail closed.
  if (!/^[1-9]\d*$/.test(text) || pid > 0x7fffffff) throw locked
  try { process.kill(pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
  }
  throw locked
}

export async function readState(stateDir: string, tag: string): Promise<State> {
  const file = statePath(stateDir, tag)
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tag, mode: 'files', history: [] }
    throw new CutoverError('state_invalid', 'cannot read cutover state')
  }
  let s: unknown
  try { s = JSON.parse(text) } catch { throw new CutoverError('state_invalid', 'invalid cutover state JSON') }
  if (!hasOnly(s, 'tag mode pending renameTo gate history') || s.tag !== tag ||
      (s.mode !== 'files' && s.mode !== 'service') ||
      (s.pending !== undefined && s.pending !== 'applying' && s.pending !== 'rolling_back') ||
      (s.renameTo !== undefined && (typeof s.renameTo !== 'string' || !newTag.test(s.renameTo))) ||
      (s.gate !== undefined && (!hasOnly(s.gate, 'file sha256 by at') ||
        [s.gate.file, s.gate.sha256, s.gate.by, s.gate.at].some((field) => typeof field !== 'string'))) ||
      !Array.isArray(s.history) || !s.history.every((h: unknown) => hasOnly(h, 'at event detail') &&
        typeof h.at === 'string' && typeof h.event === 'string' && (h.detail === undefined || typeof h.detail === 'string'))) {
    throw new CutoverError('state_invalid', 'cutover state has invalid or unknown fields')
  }
  return s as unknown as State
}

export async function writeState(stateDir: string, state: State): Promise<void> {
  const file = statePath(stateDir, state.tag)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await writeFile(temp, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
  } catch {
    await rm(temp, { force: true }).catch(() => {})
    throw new CutoverError('state_write_failed', 'cannot write cutover state')
  }
}
