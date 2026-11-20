import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execCli, isSha } from './cli.ts'

export type RefFile = Readonly<{ head: string | null; text: string | null }>

export interface RefStore {
  /** A consistent snapshot. `text: null` means the file is absent at `head`. */
  read(branch: string, path: string): Promise<RefFile>
  /** Return the new head. `expectedHead: null` creates a branch from an empty tree. */
  write(branch: string, path: string, text: string, expectedHead: string | null): Promise<string>
}

const messages = {
  invalid_branch: 'exchange branch must be remote/<agent>/{brief,control,inbox,status}',
  invalid_path: 'exchange file path must use portable relative path segments',
  invalid_head: 'expected head must be a full commit sha or null',
  not_a_file: 'exchange path is not a regular file',
  file_too_large: 'exchange file exceeds 64 KiB',
  git_failed: 'git could not access the exchange branch',
  head_moved: 'exchange branch head moved',
} as const

export class RefStoreError extends Error {
  override name = 'RefStoreError'
  readonly reason: keyof typeof messages
  constructor(reason: keyof typeof messages) {
    super(messages[reason])
    this.reason = reason
  }
}

export class RefConflict extends RefStoreError {
  override name = 'RefConflict'
  readonly expectedHead: string | null
  readonly actualHead: string | null
  readonly hint = 'Read the branch again before retrying the write.'
  constructor(expectedHead: string | null, actualHead: string | null) {
    super('head_moved')
    this.expectedHead = expectedHead
    this.actualHead = actualHead
  }
}

const maxBytes = 64 * 1024

function refName(branch: string, path: string) {
  if (!/^remote\/[A-Za-z0-9_-]+\/(brief|control|inbox|status)$/u.test(branch)) throw new RefStoreError('invalid_branch')
  if (!path.split('/').every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(part))) throw new RefStoreError('invalid_path')
  return `refs/heads/${branch}`
}

export type LocalGitOptions = { repoDir: string; identity: { name: string; email: string } }

/** Local refs only. Use ordinary fast-forward Git sync outside the store. */
export function localGit({ repoDir, identity }: LocalGitOptions): RefStore {
  const cwd = resolve(repoDir)
  const config = [
    '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`,
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
  ]
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '',
  }
  const git = (args: string[], index?: string, input?: string) => execCli('git', [...config, ...args], {
    cwd, env: index === undefined ? env : { ...env, GIT_INDEX_FILE: index }, input,
  })
  async function output(args: string[], index?: string, input?: string) {
    const result = await git(args, index, input)
    if (result.code !== 0) throw new RefStoreError('git_failed')
    return result.stdout
  }
  async function head(ref: string) {
    const entries = await output(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)', ref])
    for (const entry of entries.split('\n')) {
      const [name, sha, symref] = entry.split('\t')
      if (name !== ref) continue
      if (symref || !isSha(sha)) throw new RefStoreError('git_failed')
      return sha
    }
    return null
  }

  return {
    async read(branch, path) {
      const ref = refName(branch, path)
      const sha = await head(ref)
      if (sha === null) return { head: null, text: null }
      const entry = await output(['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', sha, '--', path])
      if (entry === '') return { head: sha, text: null }
      const [mode, type, blob] = entry.split('\t', 1)[0]!.split(' ')
      if ((mode !== '100644' && mode !== '100755') || type !== 'blob' || !isSha(blob)) throw new RefStoreError('not_a_file')
      const size = Number(await output(['cat-file', '-s', blob]))
      if (size > maxBytes) throw new RefStoreError('file_too_large')
      return { head: sha, text: await output(['cat-file', 'blob', blob]) }
    },
    async write(branch, path, text, expectedHead) {
      const ref = refName(branch, path)
      if (expectedHead !== null && !isSha(expectedHead)) throw new RefStoreError('invalid_head')
      if (Buffer.byteLength(text) > maxBytes) throw new RefStoreError('file_too_large')
      const current = await head(ref)
      if (current !== expectedHead) throw new RefConflict(expectedHead, current)
      const dir = await mkdtemp(join(tmpdir(), 'politburo-ref-'))
      try {
        const index = join(dir, 'index')
        await output(['read-tree', expectedHead ?? '--empty'], index)
        const blob = (await output(['hash-object', '-w', '--stdin'], index, text)).trim()
        await output(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], index)
        const tree = (await output(['write-tree'], index)).trim()
        const parent = expectedHead === null ? [] : ['-p', expectedHead]
        const commit = (await output(['commit-tree', tree, ...parent, '-m', 'update exchange file'], index)).trim()
        // The preflight read is not a lock. Git compares and updates the ref atomically.
        const update = await git(['update-ref', '--no-deref', ref, commit, expectedHead ?? '0'.repeat(commit.length)])
        if (update.code !== 0) {
          const actual = await head(ref)
          if (actual !== expectedHead) throw new RefConflict(expectedHead, actual)
          throw new RefStoreError('git_failed')
        }
        return commit
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
