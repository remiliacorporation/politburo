import { WatchError, type ShadowAlert } from './alerts.ts'

export function diffAlerts(script: ShadowAlert[], service: ShadowAlert[], { toleranceMinutes = 10 } = {}) {
  const within = (a: ShadowAlert, b: ShadowAlert) => a.kind === b.kind && a.key === b.key
    && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= toleranceMinutes * 60_000
  const missing: ShadowAlert[] = [], matched: ShadowAlert[] = []
  for (const alert of script) (service.some((candidate) => within(alert, candidate)) ? matched : missing).push(alert)
  return { missing, extra: service.filter((alert) => !script.some((candidate) => within(alert, candidate))), matched }
}

function isAlert(alert: Partial<ShadowAlert> | null): alert is ShadowAlert {
  return typeof alert?.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(alert.at) && Number.isFinite(Date.parse(alert.at))
    && ['stall', 'slowdown', 'pr'].includes(alert.kind ?? '') && typeof alert.key === 'string' && !!alert.key
    && typeof alert.text === 'string'
}

function parseLines(text: string, name: string, decode: (line: string) => unknown): ShadowAlert[] {
  if (!text) return []
  return text.replace(/\r?\n$/, '').split(/\r?\n/).map((line, index) => {
    let alert: ShadowAlert | undefined
    try { alert = decode(line) as ShadowAlert } catch { /* report only the line number */ }
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
