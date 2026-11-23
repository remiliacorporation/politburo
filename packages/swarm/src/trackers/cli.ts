import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig, parseConfigText } from '../config/load.ts'
import { githubAdapter, linearAdapter, parseSourceId, scanTrackers, TrackerError } from './index.ts'

class ReadError extends Error {}

function readLayer(path: string | undefined): unknown {
  if (path === undefined) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ReadError(`cannot read ${path}`)
  }
  return parseConfigText(text)
}

function escapeControls(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function misuse(headline: string): number {
  console.error(`error: ${escapeControls(headline)}`)
  return 2
}

export async function run(args: string[]): Promise<number> {
  const [action, repo, ...flags] = args
  if (action === undefined) return misuse('missing trackers command')
  if (action !== 'scan') return misuse(`unknown trackers command ${action}`)
  if (!repo || repo.startsWith('-')) return misuse('missing repo key')

  let values
  try {
    ;({ values } = parseArgs({
      args: flags,
      strict: true,
      options: {
        json: { type: 'boolean' },
        party: { type: 'string' },
        repo: { type: 'string' },
      },
    }))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, (letter) => letter.toLowerCase()))
  }

  try {
    const tree = loadConfig({ party: readLayer(values.party), repo: readLayer(values.repo) })
    if (!Object.hasOwn(tree.trackers, repo)) return misuse('unknown repo key')
    const { sources, precedence }: { sources: string[]; precedence: string[] } = tree.trackers[repo]
    for (const source of precedence) parseSourceId(source)
    const result = await scanTrackers({ precedence, sources: sources.map((source) => ({
      adapter: parseSourceId(source).kind === 'github'
        ? githubAdapter({ source, token: () => process.env.GITHUB_TOKEN, baseUrl: process.env.SWARM_GITHUB_API_URL })
        : linearAdapter({ source, token: () => process.env.LINEAR_API_KEY, baseUrl: process.env.SWARM_LINEAR_API_URL }),
    })) })
    const statuses = Object.entries(result.sources)
    if (values.json) {
      const items = result.items.map(({ key, workId, title, badges, state, stateSource, disagreements, stale }) => ({
        key, workId, title, badges, state, stateSource, disagreements, stale,
      }))
      console.log(JSON.stringify({ items, sources: result.sources }))
    } else {
      for (const { state, badges, title, stale, disagreements } of result.items) {
        const row = `${state}  ${badges.join(' ')}  ${title}${stale ? '  stale' : ''}`
        const differs = disagreements.map(({ source, state }) => `${source}=${state}`).join(', ')
        console.log(escapeControls(row + (differs ? `  disagrees: ${differs}` : '')))
      }
      console.log('')
      for (const [source, { status, pages, reason }] of statuses) {
        console.log(`${source}  ${status}  ${pages} pages${status === 'complete' ? '' : `  ${reason ?? 'page_limit'}`}`)
      }
    }
    return statuses.every(([, { status }]) => status === 'complete') ? 0 : 1
  } catch (error) {
    if (error instanceof ConfigError) return misuse(error.field ? `${error.field}: ${error.message}` : error.message)
    if (error instanceof ReadError) return misuse(error.message)
    if (error instanceof TrackerError && error.reason === 'bad_source') return misuse('bad source id')
    throw error
  }
}
