import { WatchError, type ShadowAlert } from './alerts.ts'

export function diffAlerts(script: ShadowAlert[], service: ShadowAlert[], { toleranceMinutes = 10 } = {}) {
  type Row = { time: number; index: number }
  const groups = new Map<string, [Row[], Row[]]>()
  const group = (rows: ShadowAlert[], side: 0 | 1) => rows.forEach(({ kind, key, at }, index) => {
    const id = `${kind}:${key}`
    if (!groups.has(id)) groups.set(id, [[], []])
    groups.get(id)![side].push({ time: Date.parse(at), index })
  })
  group(script, 0)
  group(service, 1)
  const usedScript = new Set<number>(), usedService = new Set<number>()
  const tolerance = toleranceMinutes * 60_000
  for (const [left, right] of groups.values()) {
    for (const rows of [left, right]) rows.sort((a, b) => a.time - b.time)
    let i = 0, j = 0
    // Discard rows too early for any remaining partner; otherwise pair the earliest two.
    while (i < left.length && j < right.length) {
      const a = left[i]!, b = right[j]!, delta = a.time - b.time
      if (delta < -tolerance) i++
      else if (delta > tolerance) j++
      else { usedScript.add(a.index); usedService.add(b.index); i++; j++ }
    }
  }
  const ref = ({ at, kind }: ShadowAlert, index: number) => ({ at, kind, line: index + 1 })
  return {
    missing: script.map(ref).filter((_, i) => !usedScript.has(i)),
    extra: service.map(ref).filter((_, i) => !usedService.has(i)),
    matched: script.map(ref).filter((_, i) => usedScript.has(i)),
  }
}

function validTime(at: string) {
  if (!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)$/.test(at)
    || !Number.isFinite(Date.parse(at))) return false
  const date = at.slice(0, 10)
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}

function isAlert(alert: Partial<ShadowAlert> | null): alert is ShadowAlert {
  return typeof alert?.at === 'string' && validTime(alert.at)
    && ['stall', 'slowdown', 'pr'].includes(alert.kind ?? '') && typeof alert.key === 'string' && !!alert.key
    && typeof alert.text === 'string'
}

function parseLines(text: string, name: string, decode: (line: string) => unknown): ShadowAlert[] {
  if (!text) return []
  return text.replace(/\r?\n$/, '').split(/\r?\n/).map((line, index) => {
    let alert: ShadowAlert | undefined
    try { if (!line.includes('\r')) alert = decode(line) as ShadowAlert } catch { /* report only the line number */ }
    if (!alert || !isAlert(alert)) throw new WatchError(`invalid ${name} alert at line ${index + 1}`)
    const { at, kind, key, text } = alert
    return { at, kind, key, text }
  })
}

export function parseScriptLog(text: string): ShadowAlert[] {
  return parseLines(text, 'script', (line) => {
    const [at, kind, key, ...parts] = line.split('\t')
    return { at, kind, key, text: parts.length ? parts.join('\t') : undefined }
  })
}

export const parseShadowLog = (text: string): ShadowAlert[] => parseLines(text, 'shadow', JSON.parse)
