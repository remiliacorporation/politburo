import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { isOutcomeKind, OUTCOME_KINDS } from './kinds.ts'

export type DeclaredOutcome = { kind: string; location?: string; required_sections?: string[] }
export type EvidenceObject = { work_id: string; kind: string; path: string; sha256: string }
export type OutcomeResult = 'valid' | 'invalid' | 'unverifiable'
export type EvidenceValidation = {
  workId: string | null
  result: OutcomeResult
  reasons: string[]
  path: string | null
  sha256: string | null
}

type EvidenceInput = { workId: string; outcome: DeclaredOutcome; evidence: EvidenceObject; root: string }

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function ticketMatches(value: unknown, workId: unknown): boolean {
  return nonblank(value) && nonblank(workId) && value.toLowerCase() === workId.toLowerCase()
}

function relativePath(path: string): boolean {
  return !path.includes('\0') && !isAbsolute(path) && !win32.isAbsolute(path) &&
    !/^[a-z]:/i.test(path) && !path.split(/[\\/]/).includes('..')
}

function inside(root: string, file: string): boolean {
  const fromRoot = relative(root, file)
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

function frontMatter(lines: string[]) {
  const end = /^---[ \t]*$/.test(lines[0] ?? '')
    ? lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line))
    : -1
  if (end < 0) return { workId: undefined, body: lines }

  // Only a single top-level, scalar work_id binds the artifact to a ticket.
  const ids = lines.slice(1, end).filter((line) => /^[ \t]*(?:work_id|"work_id"|'work_id')[ \t]*:/.test(line))
  const match = ids.length === 1
    ? /^work_id[ \t]*:[ \t]*(?:"([^"\s]+)"|'([^'\s]+)'|([^\s'"#]+))(?:[ \t]+#.*)?[ \t]*$/.exec(ids[0]!)
    : null
  return { workId: match?.[1] ?? match?.[2] ?? match?.[3], body: lines.slice(end + 1) }
}

function filledSections(lines: string[]): Set<string> {
  const filled = new Set<string>()
  const headings: { level: number; name: string }[] = []
  let fence: string | undefined
  let comment = false

  for (let line of lines) {
    if (!fence) {
      // Ignore HTML comments, including multiline comments around headings.
      if (comment) line = `<!--${line}`
      line = line.replace(/<!--.*?-->/g, '')
      const start = line.indexOf('<!--')
      comment = start !== -1
      if (comment) line = line.slice(0, start)
    }

    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) {
        fence = undefined
        continue
      }
    } else {
      if (marker && (marker[1]![0] === '~' || !marker[2]!.includes('`'))) {
        fence = marker[1]
        continue
      }
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line)
      if (heading) {
        const level = heading[1]!.length
        const name = (heading[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim().toLowerCase()
        while (headings.length && headings.at(-1)!.level >= level) headings.pop()
        headings.push({ level, name })
        continue
      }
    }
    if (line.trim()) for (const { name } of headings) filled.add(name)
  }
  return filled
}

/** Check the bytes of a local artifact. The returned path is the submitted path. */
export async function validateEvidence(input: EvidenceInput): Promise<EvidenceValidation> {
  const reasons: string[] = []
  let path: string | null = null
  let sha256: string | null = null
  let workId: string | null = null
  const finish = (result: OutcomeResult): EvidenceValidation => ({ workId, result, reasons, path, sha256 })

  try {
    const { workId: inputWorkId, outcome, evidence, root } = input
    workId = nonblank(inputWorkId) ? inputWorkId.toLowerCase() : null
    const submittedPath = evidence?.path
    path = typeof submittedPath === 'string' ? submittedPath : null
    const kind = outcome?.kind
    const knownKind = isOutcomeKind(kind)
    if (!knownKind) reasons.push('unknown declared outcome kind')
    if (!ticketMatches(evidence?.work_id, workId)) reasons.push('evidence work_id does not match work id')
    if (typeof evidence?.kind !== 'string' || evidence.kind !== kind) {
      reasons.push('evidence kind does not match declared kind')
    }
    if (outcome?.location !== undefined && (!nonblank(outcome.location) || path !== outcome.location)) {
      reasons.push('evidence path does not match declared location')
    }

    const submittedHash = evidence?.sha256
    const hashWellFormed = typeof submittedHash === 'string' && /^[a-f\d]{64}$/i.test(submittedHash)
    if (!hashWellFormed) reasons.push('evidence sha256 must be a hex SHA-256 digest')

    const sections = outcome?.required_sections
    let required: readonly string[] = knownKind ? OUTCOME_KINDS[kind].required_sections : []
    if (sections !== undefined) {
      if (!Array.isArray(sections) || !Array.from(sections).every(nonblank)) {
        reasons.push('required_sections must be an array of non-empty strings')
      } else {
        required = [...required, ...sections]
      }
    }

    const safePath = nonblank(submittedPath) && relativePath(submittedPath)
    const usableRoot = nonblank(root) && !root.includes('\0')
    if (!safePath) reasons.push('evidence path must be relative and must not contain ..')
    if (!usableRoot) reasons.push('invalid evidence root')
    if (!safePath || !usableRoot) return finish('invalid')

    let bytes: Buffer
    try {
      const directory = await realpath(root)
      const file = await realpath(resolve(directory, submittedPath))
      if (!inside(directory, file)) {
        reasons.push(file === directory ? 'evidence path names root itself' : 'evidence path resolves outside root')
        return finish('invalid')
      }
      const observed = await lstat(file)
      if (!observed.isFile()) {
        reasons.push('evidence path must name a regular file')
        return finish('invalid')
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino ||
            await realpath(file) !== file) {
          reasons.push('evidence path changed during validation')
          return finish('invalid')
        }
        bytes = await handle.readFile()
        const submitted = resolve(root, submittedPath)
        const current = await realpath(submitted).catch(() => null)
        const linked = current === file && inside(directory, current) ? await stat(submitted).catch(() => null) : null
        if (!linked || linked.dev !== opened.dev || linked.ino !== opened.ino) {
          reasons.push('evidence path changed during validation')
          return finish('invalid')
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'ENAMETOOLONG' || code === 'EINVAL') {
        reasons.push('invalid evidence path')
        return finish('invalid')
      }
      const result = reasons.length ? 'invalid' : 'unverifiable'
      reasons.push('evidence file is missing or unreadable')
      return finish(result)
    }

    sha256 = createHash('sha256').update(bytes).digest('hex')
    if (hashWellFormed && sha256 !== submittedHash.toLowerCase()) {
      reasons.push('evidence sha256 does not match file bytes')
    }
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
    if (!text.trim()) reasons.push('evidence file is empty')
    const { workId: fileWorkId, body } = frontMatter(text.split(/\r\n?|\n/))
    if (!ticketMatches(fileWorkId, workId)) reasons.push('front matter work_id does not match work id')
    const filled = filledSections(body)
    const checked = new Set<string>()
    for (const section of required) {
      const name = section.trim().toLowerCase()
      if (checked.has(name)) continue
      checked.add(name)
      if (!filled.has(name)) reasons.push(`missing or empty section: ${section}`)
    }
    return finish(reasons.length ? 'invalid' : 'valid')
  } catch {
    reasons.push('malformed evidence validation input')
    return finish('invalid')
  }
}
