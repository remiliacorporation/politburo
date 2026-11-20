import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Failure } from '@vercel/board/cli'

const launcher = `#!/bin/sh
set -eu
CDPATH= cd -- "$(dirname -- "$0")"
exec vb serve --dir .board --no-open "$@"
`

const readme = `# politburo instance

On a POSIX host with Node.js 22.18 or later, install the board CLI and start it:

\`\`\`sh
npm install --global @vercel/board
./run.sh
\`\`\`

The board listens on loopback at http://127.0.0.1:4100 by default. Its state
lives in \`.board/\` next to this file. To run another instance on the same
host, choose a different port with \`./run.sh --port 4101\`.

\`politburo.config.json\` records the instance name. \`.env.example\` lists
optional client settings; the launcher does not load it. Use the board URL
printed at startup with \`vb --url\`. Local clients pick up the local board's
token automatically; no token needs to be added here.
`

class ScaffoldError extends Error {
  readonly failure: Failure

  constructor(failure: Failure) {
    super(failure.message)
    this.failure = failure
  }
}

const nonEmpty = (): ScaffoldError => new ScaffoldError({
  class: 'conflict', reason: 'directory_not_empty',
  message: 'cannot create instance: the directory is not empty',
  next: [{ instruction: 'use an empty or new directory' }],
})

/** Write a starter instance into a new or empty directory. Never replace a file. */
export async function createInstance(dir: string, { name }: { name: string }): Promise<void> {
  if (!dir || dir.includes('\0')) throw new ScaffoldError({
    class: 'usage', reason: 'invalid_directory', message: 'cannot create instance: invalid directory path',
  })
  if (!name.trim()) throw new ScaffoldError({
    class: 'usage', reason: 'missing_name', message: 'cannot create instance: pass a non-empty --name',
  })

  const root = resolve(dir)
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length) throw nonEmpty()

  // Claim the config name first so two creators of the same directory can't both proceed.
  const files = [
    ['politburo.config.json', `${JSON.stringify({ name }, null, 2)}\n`],
    ['.env.example', 'BOARD_URL=\nBOARD_TOKEN=\n'],
    ['run.sh', launcher, 0o755],
    ['README.md', readme],
  ] as const
  for (const [file, text, mode] of files) {
    try {
      await writeFile(join(root, file), text, { flag: 'wx', mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw nonEmpty()
      throw error
    }
  }
}

type CreateInstanceResult =
  | { exitCode: 0; lines: string[] }
  | { exitCode: 1 | 2; lines: string[]; error: Failure }

function failed(error: Failure): CreateInstanceResult {
  const lines = [`error: ${error.message}`]
  if (error.next?.length) lines.push('', ...error.next.map(({ instruction }) => `  ${instruction}`))
  return { exitCode: error.class === 'usage' ? 2 : 1, lines, error }
}

/** Command arguments after `create an instance`: `<dir> --name <name>`. */
export async function runCreateInstance(argv: readonly string[]): Promise<CreateInstanceResult> {
  const usage = () => failed({
    class: 'usage', reason: 'invalid_arguments', message: 'cannot create instance: pass <dir> --name <name>',
  })
  let args
  try {
    args = parseArgs({ args: [...argv], options: { name: { type: 'string' } }, allowPositionals: true })
  } catch {
    return usage()
  }
  const [dir] = args.positionals
  if (dir === undefined || args.positionals.length !== 1 || args.values.name === undefined) return usage()
  try {
    await createInstance(dir, { name: args.values.name })
    const path = dir.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    return { exitCode: 0, lines: [`created instance  ${path}`] }
  } catch (error) {
    if (error instanceof ScaffoldError) return failed(error.failure)
    if (['EEXIST', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return failed({ class: 'conflict', reason: 'not_a_directory', message: 'cannot create instance: the path is not a directory' })
    }
    return failed({ class: 'unknown', reason: 'write_failed', message: 'cannot create instance: could not write the scaffold' })
  }
}
