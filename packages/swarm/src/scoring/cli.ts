import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig, parseConfigText } from '../config/load.ts'
import { drill, history, leaderboard, parseScoreInput, scorecard, scoreRules, ScoringInputError, type ItemScore } from './index.ts'

const usage = 'usage: swarm score <leaderboard|card|history|drill> --input FILE --as-of ISO\n' +
  '       [--party ID] [--work ID] [--as-ofs A,B,C] [--rules FILE] [--json]'

class ReadError extends Error {}

function readLayer(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ReadError(`cannot read ${path}`)
  }
  return parseConfigText(text)
}

function unicodeEscape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
}

function escapeControls(text: string): string {
  return text.replace(/[\\\x00-\x1f\x7f-\x9f]/g, char => char === '\\' ? '\\\\' : unicodeEscape(char))
}

function printError(headline: string) {
  console.error(`error: ${escapeControls(headline)}`)
}

function misuse(message: string): number {
  printError(message)
  console.error(usage)
  return 2
}

function isISO(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  const day = value.slice(0, 10)
  return Number.isFinite(Date.parse(value)) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)
}

function columns(rows: (string | number)[][], indent = ''): string {
  const widths: number[] = []
  const cells = rows.map(row => row.map((value, i) => {
    const cell = escapeControls(String(value))
    widths[i] = Math.max(widths[i] ?? 0, cell.length)
    return cell
  }))
  return cells.map(row => indent + row.map((cell, i) =>
    i === row.length - 1 ? cell : cell.padEnd(widths[i]!)).join('  ')).join('\n')
}

function formatItem({ work_id, total, contributions }: ItemScore, unknown?: number): string {
  return `${escapeControls(work_id ?? 'overhead')}  ${total}\n` +
    (unknown === undefined ? '' : `unknown  ${unknown}\n`) + columns(contributions.map(({ rule, points, refs }) =>
    [rule, points, refs.map(({ kind, id }) => `${kind}:${id}`).join(', ')]), '  ')
}

export function runScore(args: string[]): number {
  const [action, ...flags] = args
  if (action === undefined) return misuse('missing score command')
  if (action !== 'leaderboard' && action !== 'card' && action !== 'history' && action !== 'drill') {
    return misuse(`unknown score command ${action}`)
  }

  let values
  try {
    const parsed = parseArgs({
      args: flags, strict: true,
      options: {
        input: { type: 'string' }, 'as-of': { type: 'string' }, party: { type: 'string' },
        work: { type: 'string' }, 'as-ofs': { type: 'string' }, rules: { type: 'string' },
        json: { type: 'boolean' },
      },
    })
    values = parsed.values
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return misuse(error.message.replace(/^./, letter => letter.toLowerCase()))
  }

  for (const [flag, value] of Object.entries(values)) {
    if (value === '') return misuse(`--${flag} must not be empty`)
  }
  const { input: path, 'as-of': asOf, party = '', work = '' } = values
  if (!path) return misuse('missing --input')
  if (!asOf) return misuse('missing --as-of')
  if (!isISO(asOf)) return misuse('invalid ISO date for --as-of')
  if (action !== 'leaderboard' && !party) return misuse('missing --party')
  if (action === 'drill' && !work) return misuse('missing --work')
  const asOfs = values['as-ofs']?.split(',').map(date => date.trim()) ?? []
  if (action === 'history' && !values['as-ofs']) return misuse('missing --as-ofs')
  if (!asOfs.every(isISO)) return misuse('invalid ISO date for --as-ofs')

  try {
    const input = parseScoreInput(readLayer(path))
    const rules = scoreRules(loadConfig({ party: values.rules === undefined ? undefined : readLayer(values.rules) }))
    const output = (data: object, text: () => string) => {
      console.log(values.json
        ? JSON.stringify({ state: rules.state, ...data }).replace(/[\x7f-\x9f\u2028\u2029]/g, unicodeEscape)
        : text())
      return 0
    }
    if (action === 'leaderboard') {
      const rows = leaderboard(input, rules, { asOf })
      return output({ leaderboard: rows }, () => columns([
        ['rank', 'party', 'score', 'level', 'milestones', 'unknown'],
        ...rows.map(row => [row.rank, row.party, row.total, row.level, row.milestones_reached, row.unknown]),
      ]))
    }
    if (action === 'history') {
      const rows = history(input, rules, { party, asOfs })
      return output({ history: rows }, () => columns([
        ['as-of', 'score', 'level', 'unknown'], ...rows.map(row => [row.asOf, row.total, row.level, row.unknown]),
      ]))
    }
    if (action === 'drill') {
      const result = drill(input, rules, { party, asOf, work_id: work })
      return output(result, () => `${formatItem(result.item, result.unknown)}\n\n` +
        columns(result.records.map(({ ref }) => [ref.kind, ref.id])))
    }
    const card = scorecard(input, rules, { party, asOf })
    return output({ scorecard: card }, () => [columns([
      ['party', card.party], ['score', card.total], ['level', card.level.name],
      ['unknown', card.unknown.items], ['state', card.state],
      ...card.milestones.map(m => ['milestone', `${m.id}  ${m.reached_at ?? 'not reached'}`]),
    ]), ...card.items.map(item => formatItem(item))].join('\n\n'))
  } catch (error) {
    if (error instanceof ConfigError) printError(error.field ? `${error.field}: ${error.message}` : error.message)
    else if (error instanceof ReadError || error instanceof ScoringInputError || error instanceof RangeError) printError(error.message)
    else throw error
    return 1
  }
}
