import type { Board } from '@vercel/board'

const DRAFT_LIMIT = 15

export type RefillDraft = Readonly<{
  title: string
  body: string
  kind: 'research' | 'critique' | 'write-up'
}>

export type RefillContext = Readonly<{
  channel: string
  ready: number
  threshold: number
  max: number
}>

export type RefillOptions = {
  channel: string
  agent(context: RefillContext): Promise<readonly RefillDraft[]>
  threshold?: number
  max?: number
}

/** Propose work for a low queue. Only an owner or manager should unblock it after review. */
export async function refill(
  board: Board,
  { agent, channel, threshold = 5, max = DRAFT_LIMIT }: RefillOptions,
): Promise<{ drafted: number; skipped: boolean }> {
  if (!Number.isSafeInteger(threshold) || threshold < 0) throw new RangeError('invalid threshold')
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('invalid max')
  const cap = Math.min(max, DRAFT_LIMIT)
  if (cap === 0 || threshold === 0) return { drafted: 0, skipped: true }

  let ready = 0
  let after: string | undefined
  while (ready < threshold) {
    const limit = Math.min(threshold - ready, 500)
    const page = await board.tasks.list({ channel, state: 'ready', limit, after })
    ready += page.tasks.length
    if (page.tasks.length < limit) break
    after = page.cursor
  }
  if (ready >= threshold) return { drafted: 0, skipped: true }

  const drafts = (await agent({ channel, ready, threshold, max: cap })).slice(0, cap)
  if (drafts.length === 0) return { drafted: 0, skipped: false }

  // Board cannot create a task blocked. Start the proposals waiting on a
  // temporary held prerequisite so there is no ready window before the hold.
  const { task: gate, claim } = await board.tasks.create(channel, {
    text: 'Temporary prerequisite for publishing refill proposals.', claim: true, noSync: true,
  })
  try {
    if (!claim) throw new Error('refill could not claim its temporary prerequisite')
    await claim.block('Refill proposals are being published.')
    const tasks = await board.tasks.createMany(channel, drafts.map(({ title, body, kind }) => ({
      text: `${title}\n\n${body}`,
      labels: { kind },
      needs: [gate.id],
    })))
    for (const task of tasks) {
      await board.tasks.block(task.id, 'Proposed task. Unblock only after human approval.', { kind: 'awaiting_approval' })
      await board.tasks.needs(task.id, [])
    }
    return { drafted: tasks.length, skipped: false }
  } finally {
    // Deleting cancels the gate, so a draft still waiting after a failure stays waiting.
    await board.delete(gate.id)
  }
}
