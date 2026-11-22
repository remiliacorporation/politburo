import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PartyConfig } from '../config/load.ts'
import { generatedMarker, renderSkills } from './render.ts'

const blocked = /tigeryard/i

type FileAction = { path: string; action: 'written' | 'unchanged' | 'would write' }

// Resolve any symlinks in the existing prefix, even when the destination is new.
function destination(dir: string): { path: string; existing: string } {
  if (lstatSync(dir, { throwIfNoEntry: false })) {
    const path = realpathSync(dir)
    if (!statSync(path).isDirectory()) throw new Error(`not a directory: ${dir}`)
    return { path, existing: path }
  }
  const parent = dirname(dir)
  const { path, existing } = destination(parent)
  return { path: join(path, dir.slice(parent.length)), existing }
}

function checkRemotes(dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) delete env[key]
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
  const checkout = git('rev-parse', '--git-dir')
  if ((checkout.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    for (let parent = dir; ; parent = dirname(parent)) {
      if (lstatSync(join(parent, '.git'), { throwIfNoEntry: false })) {
        throw new Error('cannot check target git remotes')
      }
      if (dirname(parent) === parent) return
    }
  }
  if (checkout.status === 128 && checkout.stderr.startsWith('fatal: not a git repository')) return
  if (checkout.status !== 0) throw new Error('cannot check target git checkout')

  const configured = git('config', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$')
  if (configured.status !== 0 && configured.status !== 1) throw new Error('cannot check target git remotes')
  const effective = git('remote', '-v')
  if (effective.status !== 0) throw new Error('cannot check target git remotes')
  const urls = [
    ...configured.stdout.split('\0').map((entry) => entry.slice(entry.indexOf('\n') + 1)),
    ...effective.stdout.split('\n').map((line) => line.split('\t')[1] ?? ''),
  ]
  if (urls.some((url) => blocked.test(url))) {
    throw new Error('refusing to sync skills in a protected git checkout')
  }
}

export function syncSkills(config: PartyConfig, dir: string, dryRun = false, force = false): FileAction[] {
  if (blocked.test(dir) || blocked.test(resolve(dir))) {
    throw new Error('refusing to sync skills to a protected path')
  }
  const target = destination(resolve(dir))
  if (blocked.test(target.path)) throw new Error('refusing to sync skills to a protected path')
  checkRemotes(target.existing)

  const plan = Array.from(renderSkills(config), ([relative, text]) => {
    const path = join(dir, relative)
    const fullPath = join(target.path, relative)
    const parent = lstatSync(dirname(fullPath), { throwIfNoEntry: false })
    if (parent && !parent.isDirectory()) throw new Error(`not a directory: ${dirname(path)}`)
    const current = lstatSync(fullPath, { throwIfNoEntry: false })
    if (current && (!current.isFile() || current.nlink > 1)) {
      throw new Error(`not a regular file with one link: ${path}`)
    }
    const content = Buffer.from(text)
    const previous = current && readFileSync(fullPath)
    if (previous && !force && !previous.toString('utf8').split(/\r?\n/).includes(generatedMarker)) {
      throw new Error(`refusing to overwrite unmarked file: ${path} (use --force)`)
    }
    const unchanged = previous?.equals(content)
    return { path, fullPath, content, unchanged }
  })

  return plan.map(({ path, fullPath, content, unchanged }) => {
    if (unchanged) return { path, action: 'unchanged' }
    if (dryRun) return { path, action: 'would write' }
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
    return { path, action: 'written' }
  })
}
