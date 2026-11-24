import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { readRegistry, tagProblems } from '../tags.ts'
import { CutoverError, type Clock } from './ports.ts'
import { argvJson, commandFailure, isoDateTime, misuse, plain, urgencies, type Urgency } from './queries.ts'

const classes = ['sec.push', 'sec.retry', 'sec.retire', 'sec.log', 'spawner.dispatch', 'spawner.decide', 'core.escalate', 'policy'] as const
export interface MailMessage {
  id: string; class: typeof classes[number]; urgency: Urgency
  from: string; ref: string; summary: string; body: string; at: string; expires?: string
}
export interface MailPoster { post(tag: string, message: MailMessage): Promise<{ landed: boolean }> }

export function commandPoster([program, ...args]: [string, ...string[]]): MailPoster {
  return { post: (tag, message) => new Promise((resolve, reject) => {
    const child = spawn(program, [...args, tag], { env: {}, stdio: ['pipe', 'ignore', 'ignore'] })
    child.once('error', reject)
    child.stdin.on('error', reject)
    child.once('close', code => resolve({ landed: code === 0 && child.stdin.writableFinished }))
    child.stdin.end(JSON.stringify(message))
  }) }
}

async function destinations(to: string, file?: string): Promise<string[]> {
  const registry = await readRegistry(file).catch(() => misuse('tags', 'cannot read registry'))
  if (tagProblems(registry).length) misuse('tags', 'invalid tag registry')
  const tags = (registry as { tags: { tag: string }[] }).tags.map(entry => entry.tag)
  if (to === 'all') return tags
  if (!tags.includes(to)) misuse('to', 'tag is not in the registry')
  return [to]
}

export async function runMail(action: string | undefined, args: string[], clock: Clock = Date): Promise<number> {
  const string = { type: 'string' } as const
  try {
    if (action !== 'send') misuse('command', 'expected mail send')
    const { values: v } = parseArgs({ args, options: { to: string, class: string, urgency: string, ref: string,
      summary: string, body: string, 'body-file': string, from: string, id: string, expires: string,
      'post-cmd': string, tags: string, 'dry-run': { type: 'boolean' } } })
    const { to, ref, summary, expires } = v
    const from = v.from ?? 'core'
    const kind = v.class as MailMessage['class'], urgency = v.urgency as Urgency
    if (!to) misuse('to', 'expected a tag or all')
    if (!classes.includes(kind)) misuse('class', 'expected a swarm mail class')
    if (!urgencies.includes(urgency)) misuse('urgency', 'expected p0, p1, p2 or p3')
    if (!ref?.trim()) misuse('ref', 'expected a non-empty reference')
    if (!from.trim()) misuse('from', 'expected a non-empty sender')
    if (summary === undefined || [...summary].length > 120) misuse('summary', 'required, at most 120 characters')
    if ((v.body === undefined) === (v['body-file'] === undefined)) misuse('body', 'use exactly one of --body and --body-file')
    if (expires !== undefined) {
      if (urgency === 'p0' || urgency === 'p1') misuse('expires', 'only allowed for p2 and p3')
      if (!isoDateTime(expires)) misuse('expires', 'expected an ISO date-time')
    }
    const id = v.id ?? randomUUID()
    if (!id.trim() || [...id].length > 196) misuse('id', 'expected 1 to 196 characters before the tag suffix')
    const tags = await destinations(to, v.tags)
    if (v['post-cmd'] === undefined) throw new CutoverError('no_poster', 'no_poster: --post-cmd is required')
    const poster = commandPoster(argvJson(v['post-cmd'], 'post-cmd'))
    let body = v.body
    if (body === undefined) {
      const bytes = await readFile(v['body-file']!).catch(() => misuse('body-file', 'cannot read body'))
      try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { misuse('body-file', 'not valid UTF-8') }
    }
    const time = new Date(clock.now())
    if (!Number.isFinite(time.getTime())) misuse('at', 'clock did not provide a valid date-time')
    const at = time.toISOString()
    if (!isoDateTime(at)) misuse('at', 'clock did not provide a valid date-time')
    const message: Omit<MailMessage, 'id'> = { class: kind, urgency, from, ref, summary, body, at,
      ...(expires !== undefined && { expires }) }
    let failed = false
    for (const tag of tags) {
      const envelope = { id: `${id}.${tag}`, ...message }
      if (v['dry-run']) {
        console.log(`${tag}  dry run  ${urgency} ${kind} ${plain(envelope.id)}  ${plain(summary)}`)
        continue
      }
      const result = await poster.post(tag, envelope).then(({ landed }) => landed ? 'sent' : 'failed not posted',
        () => 'failed poster error')
      console.log(`${tag}  ${result}`)
      failed ||= result !== 'sent'
    }
    return failed ? 1 : 0
  } catch (error) { return commandFailure(error) }
}
