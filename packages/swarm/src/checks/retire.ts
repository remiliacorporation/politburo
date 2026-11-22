import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { gitAt, isClean, readHead, type Exec } from './exec.ts'

const code = (error: unknown) => (error as NodeJS.ErrnoException).code

export async function liveSprites(dir = '/tmp/sprites', probe = process.kill): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return []
    throw error
  })
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.pid')) continue
    const raw = entry.isFile() ? await readFile(join(dir, entry.name), 'utf8').catch(() => '') : ''
    const pid = Number(raw.trim())
    if (/^[0-9]+$/.test(raw.trim()) && pid > 0 && pid <= 0x7fffffff) {
      try {
        probe(pid, 0)
      } catch (error) {
        if (code(error) === 'ESRCH') continue
      }
    }
    names.push(entry.name.slice(0, -4))
  }
  return names.sort()
}

export async function retireCheck({ worktrees, exec, runningSprites = liveSprites }: {
  worktrees: string[]
  exec?: Exec
  runningSprites?: () => string[] | Promise<string[]>
}, { now = () => new Date() } = {}) {
  const first = worktrees[0]
  const commonDir = (git: ReturnType<typeof gitAt>) => git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const fetchedDir = first === undefined ? null : await (async () => {
    const git = gitAt(first, exec)
    await git('fetch', '--prune', '--no-tags', '--', 'origin', '+refs/heads/*:refs/remotes/origin/*')
    return commonDir(git)
  })().catch(() => null)

  const branches = new Set<string>()
  const evidence = []
  for (const path of worktrees) {
    const git = gitAt(path, exec)
    const head = await readHead(git).catch(() => null)
    const clean = await isClean(git).catch(() => null)
    let onOrigin: boolean | null = null
    if (head && fetchedDir && await commonDir(git).catch(() => null) === fetchedDir) {
      const refs = await git('branch', '-r', '--contains', head, '--no-color').catch(() => null)
      if (refs !== null) {
        const matches = refs.split('\n').map((ref) => ref.trim()).filter((ref) => /^origin\/\S+$/.test(ref))
        for (const match of matches) branches.add(match)
        onOrigin = matches.length > 0
      }
    }
    evidence.push({ path, head, onOrigin, clean })
  }
  const clean = evidence.some((row) => row.clean === false) ? false :
    evidence.length > 0 && evidence.every((row) => row.clean === true) ? true : null
  const sprites = await Promise.resolve().then(runningSprites).catch(() => ['unknown'])
  const ok = clean === true && evidence.every((row) => row.onOrigin === true) && sprites.length === 0
  return { ok, branches: [...branches].sort(), worktrees: evidence, clean, sprites, checkedAt: now().toISOString() }
}
