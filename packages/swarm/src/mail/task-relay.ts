import { parseArgs } from 'node:util'
import { board, BoardError, type Board, type BoardEventView, type MessageView } from '@vercel/board'
import { parseWorkId } from '../work/ids.ts'

const usage = 'usage: swarm mail relay --board URL [--once]'
const segment = /^[a-z0-9][a-z0-9_-]*$/

function misuse(message: string): number {
  console.error(`error: ${message}`)
  console.error(usage)
  return 2
}

function unavailable(error: BoardError): number {
  console.error(error.status === 501 ? 'error: this board does not stream events' : 'error: board unavailable')
  return 1
}

function openBoard(url: string): Board {
  const previous = process.env.BOARD_URL
  process.env.BOARD_URL = url.replace(/\/+$/, '')
  try {
    return board()
  } finally {
    if (previous === undefined) delete process.env.BOARD_URL
    else process.env.BOARD_URL = previous
  }
}

function mailbox(handle: string): string | null {
  const name = segment.test(handle) ? handle : handle.toLowerCase()
  return segment.test(name) ? `mail/${name}` : null
}

function letterText(input: { from: string; task: string; session: string | null; reply: string; text: string }): string {
  const lines = [`from  ${input.from}`, `task  ${input.task}`]
  if (input.session) lines.push(`session  ${input.session}`)
  lines.push(`reply  ${input.reply}`, '', input.text)
  return lines.join('\n')
}

async function claimedTasks(team: Board): Promise<MessageView[]> {
  const tasks: MessageView[] = []
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = await team.tasks.list({
      state: 'claimed', label: ['work.id'], limit: 100, ...(after ? { after } : {}),
    })
    for (const row of page.tasks) tasks.push(row.message)
    if (page.tasks.length < 100 || !page.cursor || seen.has(page.cursor)) break
    seen.add(page.cursor)
    after = page.cursor
  }
  return tasks
}

async function repliesOf(team: Board, rootId: string): Promise<MessageView[]> {
  const replies: MessageView[] = []
  let after = rootId
  for (;;) {
    const page = await team.thread(rootId, { after, limit: 500 })
    replies.push(...page.replies)
    if (page.replies.length < 500) break
    const last = page.replies[page.replies.length - 1]
    if (!last || last.id === after) break
    after = last.id
  }
  return replies
}

async function findLetter(team: Board, channel: string, replyId: string): Promise<MessageView | null> {
  try {
    const mine = await team.posted(`mail-${replyId}`)
    if (mine.labels['mail.reply'] === replyId) return mine
  } catch (error) {
    if (!(error instanceof BoardError) || error.status !== 404) throw error
  }
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = await team.threads({
      channel, label: [`mail.reply=${replyId}`], limit: 50, ...(after ? { after } : {}),
    })
    for (const row of page.threads) {
      if (row.message.labels['mail.reply'] === replyId) return row.message
    }
    if (page.threads.length < 50 || !page.cursor || seen.has(page.cursor)) break
    seen.add(page.cursor)
    after = page.cursor
  }
  return null
}

async function deliveredLetters(team: Board, channel: string, taskId: string): Promise<MessageView[]> {
  const found: MessageView[] = []
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = await team.threads({
      channel,
      label: ['mail.state=delivered', `mail.task=${taskId}`],
      limit: 100,
      ...(after ? { after } : {}),
    })
    for (const row of page.threads) {
      const labels = row.message.labels
      if (labels['mail.state'] === 'delivered' && labels['mail.task'] === taskId && labels['mail.reply']) found.push(row.message)
    }
    if (page.threads.length < 100 || !page.cursor || seen.has(page.cursor)) break
    seen.add(page.cursor)
    after = page.cursor
  }
  return found
}

/** One pass: pending letters for new person replies, then a delivery line for each delivered letter. */
export async function relayPass(team: Board, now: () => string = () => new Date().toISOString()): Promise<string[]> {
  const me = await team.me()
  const lines: string[] = []
  const handles = new Map<string, string | null>()
  const handleOf = async (actor: string): Promise<string | null> => {
    if (handles.has(actor)) return handles.get(actor) ?? null
    const [found] = await team.actors({ id: [actor] })
    const handle = found?.handle ?? null
    handles.set(actor, handle)
    return handle
  }
  for (const listed of await claimedTasks(team)) {
    const thread = await team.thread(listed.id)
    const root = thread.message
    const claim = root.task?.state === 'claimed' ? root.task.claim : null
    if (!claim || parseWorkId(root.labels['work.id'] ?? '')?.tag !== 'plb') continue
    const handle = await handleOf(claim.actor)
    const channel = handle ? mailbox(handle) : null
    if (!handle || !channel) continue
    const replies = await repliesOf(team, root.id)
    const session = claim.binding?.session ?? null
    for (const reply of replies) {
      const author = reply.author
      if (!author || author.kind !== 'person' || reply.labels['mail.notice']) continue
      if (reply.by.actor === claim.actor || author.handle === handle) continue
      if (reply.by.principal === me.principal) continue
      if (await findLetter(team, channel, reply.id)) continue
      try {
        await team.post(channel, {
          id: `mail-${reply.id}`,
          text: letterText({ from: author.handle, task: root.id, session, reply: reply.id, text: reply.text }),
          labels: {
            'mail.from': author.handle,
            'mail.task': root.id,
            'mail.reply': reply.id,
            'mail.state': 'pending',
          },
        })
      } catch (error) {
        if (error instanceof BoardError && error.status === 409) continue
        throw error
      }
      lines.push(`letter  ${reply.id}  ${channel}  pending`)
    }
    for (const letter of await deliveredLetters(team, channel, root.id)) {
      const replyId = letter.labels['mail.reply']
      if (!replyId) continue
      if (!letter.labels['mail.delivered']) {
        try {
          await team.label(letter.id, { set: { 'mail.delivered': now() }, if: { 'mail.delivered': null } })
        } catch (error) {
          if (!(error instanceof BoardError) || error.status !== 409) throw error
        }
      }
      const text = `delivered to ${handle}`
      const current = await repliesOf(team, root.id)
      if (current.some((reply) => reply.text === text && reply.labels['mail.reply'] === replyId)) continue
      try {
        const mine = await team.posted(`delivered-${replyId}`)
        if (mine.labels['mail.reply'] === replyId) continue
      } catch (error) {
        if (!(error instanceof BoardError) || error.status !== 404) throw error
      }
      try {
        await team.reply(root.id, {
          id: `delivered-${replyId}`,
          text,
          labels: { 'mail.reply': replyId, 'mail.notice': 'delivered' },
        })
      } catch (error) {
        if (error instanceof BoardError && error.status === 409) continue
        throw error
      }
      lines.push(`delivered  ${replyId}  ${handle}`)
    }
  }
  return lines
}

function relevant(event: BoardEventView): boolean {
  return event.type === 'message.posted' || event.type === 'labels.changed' || event.type.startsWith('task.')
}

export async function relayCommand(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || (argv[0] === 'relay' && argv[1] === '--help')) {
    console.log(usage)
    return 0
  }
  if (argv[0] !== 'relay') return misuse('expected mail relay')
  let boardUrl: string | undefined
  let once = false
  try {
    const parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: false,
      options: { board: { type: 'string' }, once: { type: 'boolean' } },
    })
    boardUrl = parsed.values.board
    once = parsed.values.once === true
  } catch {
    return misuse('invalid mail relay arguments')
  }
  const url = boardUrl?.trim()
  if (!url || !/^https?:\/\/[^/\s]+/i.test(url)) return misuse('expected --board URL')
  let team: Board
  try {
    team = openBoard(url)
  } catch {
    return misuse('expected --board URL')
  }
  const stop = new AbortController()
  const onSigint = () => stop.abort()
  if (!once) process.once('SIGINT', onSigint)
  try {
    for (const line of await relayPass(team)) console.log(line)
    if (once || stop.signal.aborted) return stop.signal.aborted ? 130 : 0
    for await (const event of team.events({ all: true }, { signal: stop.signal })) {
      if (stop.signal.aborted) return 130
      if (!relevant(event)) continue
      for (const line of await relayPass(team)) console.log(line)
      if (stop.signal.aborted) return 130
    }
    return stop.signal.aborted ? 130 : 0
  } catch (error) {
    if (stop.signal.aborted) return 130
    if (error instanceof BoardError) return unavailable(error)
    throw error
  } finally {
    process.off('SIGINT', onSigint)
  }
}
