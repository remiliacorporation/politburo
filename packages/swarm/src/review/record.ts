import { BoardError, type Board } from '@vercel/board'

export const reviewChannel = 'plb/work'

export type ReviewVerdict = 'pass' | 'blocked'
export type FindingClass = 'BLOCKING' | 'FOLLOW-UP'

const findingClassPattern = /^(BLOCKING|FOLLOW-UP)(?::\s*|\s+|$)/

export function findingClass(text: string): FindingClass | null {
  const match = findingClassPattern.exec(text)
  return match === null ? null : match[1] as FindingClass
}

export function attestation(verdict: ReviewVerdict, head: string, findings: readonly string[]): string {
  return [`review ${verdict}`, `head ${head}`, ...findings].join('\n')
}

export function followUpText(finding: string, source: string): string {
  return `${finding}\nsource ${source}`
}

export type RecordedReview = {
  verdict: ReviewVerdict
  head: string
  replyId: string
  followUps: { id: string; class: FindingClass; text: string }[]
}

/** Posts the attestation, sets `review.verdict` and `review.head`, then opens follow-up tasks that wait for nothing. */
export async function recordReview(team: Board, input: {
  taskId: string
  verdict: ReviewVerdict
  head: string
  findings: readonly string[]
  followUp: boolean
}): Promise<RecordedReview> {
  const { message } = await team.thread(input.taskId, { limit: 1 })
  if (message.id !== input.taskId || message.deleted || !message.task) {
    throw new BoardError('not_a_task', 'not a live task', 409)
  }
  const reply = await team.reply(input.taskId, attestation(input.verdict, input.head, input.findings))
  await team.label(input.taskId, {
    set: { 'review.verdict': input.verdict, 'review.head': input.head },
  })
  const followUps: RecordedReview['followUps'] = []
  if (input.followUp) {
    for (const text of input.findings) {
      const kind = findingClass(text)
      if (kind === null) continue
      const { task } = await team.tasks.create(reviewChannel, {
        text: followUpText(text, input.taskId),
        needs: [],
        labels: { 'review.source': input.taskId },
      })
      followUps.push({ id: task.id, class: kind, text })
    }
  }
  return { verdict: input.verdict, head: input.head, replyId: reply.id, followUps }
}
