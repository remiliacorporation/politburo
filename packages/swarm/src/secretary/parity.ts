import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareJournal, jsonLines, liveFormat, liveLines, readJournal } from './diff.ts'
import { materialize, type RecordedFile } from './replay.ts'
import { runShadow } from './shadow.ts'

export const parityDir = fileURLToPath(new URL('../../parity', import.meta.url))
type Case = { name: string; row?: unknown; files: RecordedFile[]; now: string | number; expected: unknown[] }

async function matches(path: string) {
  const fixture = JSON.parse(await readFile(path, 'utf8')) as Case
  const now = typeof fixture.now === 'string' ? Date.parse(fixture.now) : fixture.now
  if (!fixture.name || !Number.isFinite(now) || !Array.isArray(fixture.files) || !Array.isArray(fixture.expected)) {
    throw new Error('invalid parity case')
  }
  const expected = fixture.expected.flatMap((line) => typeof line !== 'string' || line === liveFormat ? [line] : jsonLines(line))
  if (expected[0] === liveFormat) expected.shift()
  const dir = await mkdtemp('/tmp/swarm-parity-')
  try {
    const mailDir = join(dir, 'mail'), outDir = join(dir, 'shadow'), tag = 'pb'
    const inbox = join(mailDir, tag, 'inbox')
    await mkdir(inbox, { recursive: true })
    for (const file of fixture.files) await materialize(inbox, file)
    await runShadow({ mailDir, outDir, tag }, now)
    const records = await readJournal(join(outDir, tag, 'decisions.jsonl'), true)
    return compareJournal(records, liveLines(expected)).length === 0
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export async function parity(dir: string) {
  const behaviours = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  let cases = 0, failed = 0
  for (const behaviour of behaviours.filter((entry) => entry.isDirectory())) {
    const root = join(dir, behaviour.name)
    for (const file of await readdir(root, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      cases++
      if (!await matches(join(root, file.name)).catch(() => false)) failed++
    }
  }
  return { cases, failed }
}
