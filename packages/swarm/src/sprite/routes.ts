import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig, parseConfigText } from '../config/load.ts'

function readLayer(path: string | undefined): unknown {
  if (path === undefined) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${path}`)
  }
  return parseConfigText(text)
}

export async function run(argv: string[]): Promise<number> {
  const [action, ...args] = argv
  try {
    if (action !== 'routes') throw new Error('usage: swarm sprite routes [--party FILE] [--repo FILE]')
    const { values } = parseArgs({
      args,
      options: { party: { type: 'string' }, repo: { type: 'string' } },
    })
    const tree = loadConfig({ party: readLayer(values.party), repo: readLayer(values.repo) })
    console.log(JSON.stringify(tree.tiers.models.sprite.routes))
    return 0
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const message = error instanceof ConfigError && error.field ? `${error.field}: ${error.message}` : error.message
    const safe = message.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    })
    console.error(`error: ${safe}`)
    return 1
  }
}
