import { parseArgs } from 'node:util'
import { printError, usageBlock } from '../cli-usage.ts'
import { openTagRegistry } from '../tags.ts'

export const tagsUsageLines = ['swarm tags check [--registry FILE] [--json]']
export const tagsUsage = usageBlock(tagsUsageLines)

const phrase = (message: string) => message.replace(/^./, (char) => char.toLowerCase()).replace(/\.$/, '')

function escapeControls(text: string) {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function misuse(message: string): number {
  printError(message)
  console.error(tagsUsage)
  return 2
}

export async function tagsCommand(argv: string[]): Promise<number> {
  const [action, ...flags] = argv
  if (action === '--help' && flags.length === 0) {
    console.log(tagsUsage)
    return 0
  }
  if (action === undefined) return misuse('missing tags command')
  if (action !== 'check') return misuse(`unknown tags command ${action}`)

  let values: { registry?: string; json?: boolean }
  try {
    ;({ values } = parseArgs({
      args: flags,
      strict: true,
      options: {
        registry: { type: 'string' },
        json: { type: 'boolean' },
      },
    }))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
  }

  const opened = openTagRegistry(values.registry)
  if (opened.status === 'unreadable') {
    const problem = opened.message
    if (values.json) console.log(JSON.stringify({ valid: false, problems: [problem] }))
    else printError(problem)
    return 1
  }

  const problems = opened.status === 'invalid' ? opened.problems : []
  if (values.json) {
    console.log(JSON.stringify({ valid: problems.length === 0, problems }))
  } else if (problems.length) {
    for (const problem of problems) console.log(escapeControls(phrase(problem)))
  } else {
    console.log('valid')
  }
  return problems.length ? 1 : 0
}
