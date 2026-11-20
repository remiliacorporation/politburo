import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ResumePacket = Readonly<{
  task: string
  summary: string
  nextSteps: string | readonly string[]
  files: readonly string[]
}>

export type Attempt = Readonly<{
  task: string
  at: string
  outcome: string
  note: string
}>

function checkTask(task: string) {
  if (typeof task !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(task)) {
    throw new RangeError('invalid task id')
  }
}

async function readText(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function bullets(items: readonly string[]) {
  return items.map((item) => `- ${item.replaceAll('\n', '\n  ')}`).join('\n')
}

/** Replace the task's Markdown packet under a caller-controlled directory. Do not include credentials. */
export async function writeResumePacket(dir: string, { task, summary, nextSteps, files }: ResumePacket): Promise<void> {
  checkTask(task)
  const resume = join(dir, 'resume')
  const path = join(resume, `${task}.md`)
  const draft = join(resume, `.${randomUUID()}.tmp`)
  const steps = typeof nextSteps === 'string' ? nextSteps : bullets(nextSteps)
  const markdown = `# Resume: ${task}\n\n## Summary\n\n${summary}\n\n## Next steps\n\n${steps}\n\n## Files\n\n${bullets(files)}\n`
  await mkdir(resume, { recursive: true, mode: 0o700 })
  try {
    await writeFile(draft, markdown, { flag: 'wx', mode: 0o600 })
    await rename(draft, path)
  } finally {
    await rm(draft, { force: true })
  }
}

/** Return the Markdown text, or undefined if there is no packet. */
export async function readResumePacket(dir: string, task: string): Promise<string | undefined> {
  checkTask(task)
  return readText(join(dir, 'resume', `${task}.md`))
}

/** Append one JSON line to the local attempt log. Do not include credentials. */
export async function appendAttempt(dir: string, { task, at, outcome, note }: Attempt): Promise<void> {
  checkTask(task)
  const line = Buffer.from(`${JSON.stringify({ task, at, outcome, note })}\n`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = await open(join(dir, 'attempts.jsonl'), 'a', 0o600)
  try {
    // Issue a single append write per record so concurrent writers don't interleave chunks.
    const { bytesWritten } = await file.write(line)
    if (bytesWritten !== line.length) throw new Error('short write to attempt log')
  } finally {
    await file.close()
  }
}

/** Return attempts in file order, optionally restricted to one task. A missing log is empty. */
export async function readAttempts(dir: string, task?: string): Promise<Attempt[]> {
  if (task !== undefined) checkTask(task)
  const text = await readText(join(dir, 'attempts.jsonl'))
  return (text ?? '').split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Attempt)
    .filter((entry) => task === undefined || entry.task === task)
}
