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
  const contains = async (git: ReturnType<typeof gitAt>, sha: string) => {
    const refs = await git('for-each-ref', '--format=%(refname) %(symref)', '--contains', sha, 'refs/remotes/origin/')
      .catch(() => null)
    return refs === null ? null : refs.split('\n').some((ref) => ref.endsWith(' '))
  }
  const inventory = async (git: ReturnType<typeof gitAt>, repo: string) => {
    await git('fetch', '--prune', '--no-tags', '--', 'origin', '+refs/heads/*:refs/remotes/origin/*')
    const refs = await git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
    const rows = []
    for (const ref of refs.trim().split('\n').filter(Boolean)) {
      const [name, sha] = ref.split(' ')
      rows.push({ repo, name: name!.slice('refs/heads/'.length), onOrigin: await contains(git, sha!) })
    }
    return rows
  }
  const repos = new Map<string, Awaited<ReturnType<typeof inventory>>>()
  const evidence = []
  for (const path of worktrees) {
    const git = gitAt(path, exec)
    const repo = (await git('rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => '')).replace(/\n$/, '')
    if (repo && !repos.has(repo)) repos.set(repo, await inventory(git, repo).catch(() => []))
    const head = await readHead(git).catch(() => null)
    const clean = await isClean(git).catch(() => null)
    const onOrigin = head && repos.get(repo)?.length ? await contains(git, head) : null
    evidence.push({ path, head, onOrigin, clean })
  }
  const branches = [...repos.values()].flat()
  const clean = evidence.some((row) => row.clean === false) ? false :
    evidence.length > 0 && evidence.every((row) => row.clean === true) ? true : null
  const sprites = await Promise.resolve().then(runningSprites).catch(() => ['unknown'])
  const ok = clean === true && evidence.every((row) => row.onOrigin === true) &&
    branches.every((row) => row.onOrigin === true) && sprites.length === 0
  return { ok, branches, worktrees: evidence, clean, sprites, checkedAt: now().toISOString() }
}
