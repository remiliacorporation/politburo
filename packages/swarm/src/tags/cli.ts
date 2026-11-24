import { parseArgs } from 'node:util'
import { readRegistry, tagProblems } from '../tags.ts'

const usage = 'usage: swarm tags check --registry FILE [--json]'

function escapeControls(text: string) {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function printError(headline: string) {
  console.error(`error: ${escapeControls(headline)}`)
}

function misuse(message: string): number {
  printError(message)
  console.error(usage)
  return 2
}

export async function run(argv: string[]): Promise<number> {
  const [action, ...flags] = argv
  if (action === undefined) return misuse('missing tags command')
  if (action !== 'check') return misuse(`unknown tags command ${action}`)

  let values
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
  if (!values.registry) return misuse('missing --registry')

  let registry: unknown
  try {
    registry = await readRegistry(values.registry)
  } catch {
    printError(`cannot read ${values.registry}`)
    return 1
  }

  const problems = tagProblems(registry).map((problem) => problem.toLowerCase())
  if (values.json) {
    console.log(JSON.stringify(problems.length ? { valid: false, problems } : { valid: true }))
  } else if (problems.length) {
    for (const problem of problems) console.log(escapeControls(problem))
  } else {
    console.log('valid')
  }
  return problems.length ? 1 : 0
}
