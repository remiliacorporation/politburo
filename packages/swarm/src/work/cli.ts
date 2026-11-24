import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { usageBlock } from '../cli-usage.ts'
import { canonicalTag, openTagRegistry } from '../tags.ts'
import { parseOutcomesContract } from './contract.ts'
import { allocateWorkId } from './ids.ts'

export const workUsageLines = [
  'swarm work check FILE [--json]',
  'swarm work id TAG --after N [--registry FILE]',
]
export const workUsage = usageBlock(workUsageLines)

const phrase = (message: string) => message.replace(/^./, char => char.toLowerCase()).replace(/\.$/, '')

function error(headline: string, code = 1) {
  const safe = headline.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  console.error(`error: ${safe}`)
  if (code === 2) console.error(workUsage)
  return code
}

const maxFileBytes = 20_000 + 1_000
const tooLong = 'The description must be text of at most 20,000 characters.'

async function checkFile(path: string) {
  // Stat the opened file, then cap the read even if it grows after stat.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Not a regular file.')
    if (stat.size > maxFileBytes) return { valid: false as const, problems: [tooLong] }
    const buffer = Buffer.alloc(maxFileBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxFileBytes) return { valid: false as const, problems: [tooLong] }
    return parseOutcomesContract(buffer.toString('utf8', 0, length))
  } finally {
    await file.close()
  }
}

export async function workCommand(args: string[]): Promise<number> {
  const [action, target, flag, value] = args
  if (action === '--help' && args.length === 1) {
    console.log(workUsage)
    return 0
  }
  if (action === 'check') {
    if (!target || target.startsWith('-') || !(args.length === 2 || (args.length === 3 && flag === '--json'))) {
      return error('expected check FILE [--json]', 2)
    }
    let result: Awaited<ReturnType<typeof checkFile>>
    try {
      result = await checkFile(target)
    } catch {
      const problem = `cannot read ${target}`
      if (flag !== '--json') return error(problem)
      result = { valid: false, problems: [problem] }
    }
    const problems = result.valid ? [] : result.problems
    if (flag === '--json') console.log(JSON.stringify({ valid: result.valid, problems }))
    else if (result.valid) console.log('valid')
    else for (const problem of problems) console.log(phrase(problem))
    return result.valid ? 0 : 1
  }
  if (action === 'id') {
    let positionals: string[]
    let after: string | undefined
    let registryFile: string | undefined
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        strict: true,
        options: {
          after: { type: 'string' },
          registry: { type: 'string' },
        },
      })
      positionals = parsed.positionals
      after = parsed.values.after
      registryFile = parsed.values.registry
    } catch (err) {
      if (!(err instanceof Error)) throw err
      return error(phrase(err.message), 2)
    }
    const tag = positionals[0]
    if (positionals.length !== 1 || !tag || tag.startsWith('-') || !/^\d+$/.test(after ?? '')) {
      return error('expected id TAG --after N', 2)
    }
    const opened = openTagRegistry(registryFile)
    if (opened.status === 'unreadable') return error(opened.message)
    if (opened.status === 'invalid') return error('invalid tag registry')
    const tagName = canonicalTag(opened.tags, tag)
    if (!tagName) return error('unknown work tag')
    try {
      console.log(allocateWorkId(opened.tags.map(entry => entry.tag), tagName, Number(after)).id)
      return 0
    } catch (err) {
      if (!(err instanceof RangeError)) throw err
      return error(phrase(err.message))
    }
  }
  return error('expected work check or id', 2)
}
