import type { Reason, ScanResult } from './types.ts'

function escape(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function explain(reason: Reason): string {
  switch (reason.kind) {
    case 'closed': return reason.detail ? `closed: ${escape(reason.detail)}` : 'closed'
    case 'in_progress': return reason.assignee ? `in progress, assigned ${escape(reason.assignee)}` : 'in progress'
    case 'hooked': return 'hooked'
    case 'pinned': return 'pinned'
    case 'deferred': return reason.until ? `deferred until ${escape(reason.until)}` : 'deferred'
    case 'status_blocked': return 'status is blocked'
    case 'blocked_by': return `blocked by ${reason.via === 'parent' ? 'parent ' : ''}${reason.ids.map(escape).join(', ')}`
    case 'unknown_status': return `unknown status ${escape(reason.status)}`
    case 'unexplained': return 'not in bd ready'
  }
}

function shorten(title: string, width: number): string {
  const safe = escape(title)
  if (safe.length <= width) return safe
  if (width < 3) return ''
  let clipped = ''
  for (const char of title) {
    const part = escape(char)
    if (clipped.length + part.length > width - 3) break
    clipped += part
  }
  return clipped + '...'
}

export function renderQueue({ epic, store, items, disagreements }: ScanResult): string {
  const ready = items.filter(({ runnable }) => runnable.runnable).length
  const lines = [`epic  ${escape(epic)}  store ${escape(store)}`, `runnable  ${ready} of ${items.length}`, '']
  const idWidth = Math.max(9, ...items.map(({ id }) => escape(id).length),
    ...disagreements.map(({ id }) => escape(id).length))
  const typeWidth = Math.max(4, ...items.map(({ type }) => escape(type ?? '-').length))
  const reasons = (entries: Reason[]) => lines.push(...entries.map((reason) => `  ${explain(reason)}`))
  for (const item of items) {
    const { id, runnable, priority, type, title } = item
    const state = (runnable.runnable ? 'runnable' : 'not runnable').padEnd(12)
    const rank = (priority === undefined ? '-' : `P${priority}`).padEnd(2)
    const prefix = `${escape(id).padEnd(idWidth)}  ${state}  ${rank}  ${escape(type ?? '-').padEnd(typeWidth)}  `
    lines.push((prefix + shorten(title, 79 - prefix.length)).trimEnd())
    if (!runnable.runnable) reasons(runnable.reasons)
  }
  if (disagreements.length) {
    if (items.length) lines.push('')
    lines.push(`disagreements  ${disagreements.length}`)
    for (const { id, kind, reasons: entries } of disagreements) {
      lines.push(`${escape(id).padEnd(idWidth)}  ${kind.replace('_', ' ')}`)
      reasons(entries)
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}
