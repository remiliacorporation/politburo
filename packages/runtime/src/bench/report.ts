import type { BenchRun } from './record.ts'

type Group = {
  model: BenchRun['model']
  thinking: BenchRun['thinking']
  rating: NonNullable<BenchRun['complexity']['rating']>['score'] | 'unrated'
}

export type BenchRow = Group & {
  runs: number
  runIds: string[]
  checked: number
  passRate: number | null
  medianWallSeconds: number
  medianTokens: number | null
  p90Tokens: number | null
  tokensPerChangedLine: number | null
  runsWithTokens: number
  noTokens: number
}
export type BenchReport = { rows: BenchRow[] }

function median(sorted: number[]) {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]! / 2 + sorted[mid]! / 2
}

export function report(runs: BenchRun[]): BenchReport {
  const groups = new Map<string, { group: Group; samples: BenchRun[] }>()
  for (const run of runs) {
    if (run.level !== 'sprite') continue
    const { model, thinking } = run
    const rating = run.complexity.rating?.score ?? 'unrated'
    const key = JSON.stringify([model?.provider, model?.name, thinking, rating])
    const entry = groups.get(key) ?? { group: { model, thinking, rating }, samples: [] }
    entry.samples.push(run)
    groups.set(key, entry)
  }
  return { rows: [...groups.values()].map(({ group, samples }) => {
    const tokens: number[] = []
    let passed = 0, checked = 0, changedTokens = 0, lines = 0
    for (const { check, tokens: usage, changes } of samples) {
      if (check.result === 'pass' || check.result === 'fail') checked++
      if (check.result === 'pass') passed++
      if (usage.in === null || usage.out === null) continue
      const total = usage.in + usage.out
      tokens.push(total)
      const changedLines = changes ? changes.linesAdded + changes.linesRemoved : 0
      if (changedLines > 0) {
        changedTokens += total
        lines += changedLines
      }
    }
    tokens.sort((a, b) => a - b)
    return {
      ...group, runs: samples.length, runIds: samples.map(({ runId }) => runId), checked,
      passRate: checked ? passed / checked : null,
      medianWallSeconds: median(samples.map(({ wallSeconds }) => wallSeconds).sort((a, b) => a - b)),
      medianTokens: tokens.length ? median(tokens) : null,
      p90Tokens: tokens.length ? tokens[Math.ceil(0.9 * tokens.length) - 1]! : null,
      tokensPerChangedLine: lines ? changedTokens / lines : null,
      runsWithTokens: tokens.length, noTokens: samples.length - tokens.length,
    }
  }) }
}

function compact(n: number | null) {
  if (n === null) return '-'
  const rounded = String(Number(n.toPrecision(3)))
  return rounded.length <= 7 ? rounded : n.toExponential(0)
}

function shorten(text: string, width: number) {
  return text.length <= width ? text : `${text.slice(0, width - 3)}...`
}

export function formatReport({ rows }: BenchReport, _options?: { ids?: boolean }) {
  const lines: string[] = []
  for (const row of rows) {
    const stats = [row.rating, `${compact(row.runs)}/${compact(row.checked)}`, compact(row.passRate),
      compact(row.medianWallSeconds), compact(row.medianTokens), compact(row.p90Tokens), compact(row.tokensPerChangedLine)].join('  ')
    const width = 76 - stats.length
    const model = row.model ? `${row.model.provider}/${row.model.name}` : '-'
    const thinking = shorten(row.thinking ?? '-', Math.floor(width / 2))
    lines.push([shorten(model, width - thinking.length), thinking, stats].join('  '))
    let line = 'runs'
    for (const id of row.runIds) {
      if (line.length + id.length + 2 > 80 && line !== 'runs') {
        lines.push(line)
        line = 'runs'
      }
      line += `  ${id}`
    }
    lines.push(line)
  }
  return lines.join('\n')
}
