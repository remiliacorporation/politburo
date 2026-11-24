import { formatOperationalInbox, lineText } from './format.ts'
import { cli, client, flags, out, result, usage } from './main.ts'

export function portFlag(): number | undefined {
  const port = flags.port === undefined ? undefined : Number(flags.port)
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
    throw usage(flags['team-tokens'] === undefined ? `${flags.port} isn't a port.` : '--port needs an integer from 0 to 65535.', { reason: 'invalid_port' })
  return port
}

export async function boardStatus(command: 'status' | 'pause' | 'resume', args: string[]): Promise<number> {
  if (args.length > 0) throw usage(`${command} takes no positional arguments.`)
  const reason = flags.reason
  if (command !== 'status' && !reason?.trim()) {
    throw usage(`Missing why to ${command} the board: pass --reason <reason>.`, {
      reason: 'missing_arguments',
      next: [{ instruction: 'Give a reason', argv: [...cli(), command, '--reason', '<REASON>'] }],
    })
  }
  const board = client()
  const status = command === 'status' ? await board.status() : await board[command](reason!)
  if (flags.json) result(status)
  else out(`board  ${status.paused ? 'paused' : 'running'}`)
  return 0
}

export async function inbox(args: string[]): Promise<number> {
  const [verb, id, status, extra] = args
  if (verb === 'read' || verb === 'ack' || verb === 'archive') {
    if (flags.limit !== undefined) throw usage('--limit is for raw sync inboxes.', { reason: 'unknown_option' })
    if (verb === 'read') {
      if (args.length > 1) throw usage('inbox read takes no arguments.', { next: [{ instruction: 'For a sync key named read, use raw', argv: [...cli(), 'inbox', 'raw', 'read'] }] })
      const read = await client().operationalInbox.read()
      if (flags.json) return result(read), 0
      return out(formatOperationalInbox(read.messages)), 0
    }
    if (!id) throw usage('Missing the message ID from inbox read.', { reason: 'missing_arguments' })
    if (verb === 'archive') {
      if (status !== undefined) throw usage('inbox archive takes one message ID.')
      const archived = await client().operationalInbox.archive(id)
      if (flags.json) return result(archived), 0
      return out(`${lineText(archived.message.id)}  archived`), 0
    }
    if (status === undefined) throw usage('Missing the receipt: seen or acted.', { reason: 'missing_arguments' })
    if (status !== 'seen' && status !== 'acted') throw usage('The receipt must be seen or acted.')
    if (extra !== undefined) throw usage('inbox ack takes a message ID and a receipt.')
    const acked = await client().operationalInbox.ack(id, status)
    if (flags.json) return result(acked), 0
    return out(`${lineText(acked.message.id)}  ${status}`), 0
  }
  const [key, channel] = verb === 'raw' ? args.slice(1) : args
  if (!key) throw usage(verb === 'raw' ? 'Missing the sync entry whose inbox to read, such as slack.' : 'Missing what to read: use inbox read or name a sync entry.', { reason: 'missing_arguments' })
  const events = await client().inbox(key, {
    ...(channel ? { channel } : {}),
    ...(flags.limit ? { limit: Number(flags.limit) } : {}),
  })
  if (flags.json) return result({ events }), 0
  if (events.length === 0) return out('no events'), 0
  for (const entry of events) {
    const event = entry.event as { kind: string; thread: string; text?: string; type?: string; emoji?: string; author?: { handle: string } }
    const detail = event.text ?? event.type ?? event.emoji ?? ''
    out(`${entry.createdAt}  ${entry.channel}  ${event.kind}  ${event.author?.handle ?? ''}  ${detail.split('\n')[0]}`)
  }
  return 0
}

export function doingInbox(a: string | undefined, b: string | undefined): string {
  if (a === 'read') return 'read your operational inbox'
  if (a === 'ack') return `acknowledge inbox message ${b}`
  if (a === 'archive') return `archive inbox message ${b}`
  return `read ${a === 'raw' ? b : a}'s inbox`
}
