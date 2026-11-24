import { z } from 'zod'
import { AgentGeneration, AgentHarness, AgentRole, AgentRun, CHANNEL_PATTERN_MAX, ChannelPath, IntentOutcome, IntentVerb, MessageText, Ref, TaskNote, TaskPriority, type AgentIntent, type Author } from '../contract/schemas.ts'
import { AttentionAnswerBody, RequestAttentionBody } from '../contract/attention.ts'
import type { BoardEvent } from '../contract/events.ts'
import { OperationalRecipient, OperationalStatus, OperationalTopic } from '../contract/operational-inbox.ts'
import { TaskPacket } from '../contract/task-authority.ts'
import type { GrantCan } from './routes.ts'

export const ListOpsAgentsQuery = z.strictObject({ channel: ChannelPath })
export const RegisterOpsAgentBody = z.strictObject({
  channel: ChannelPath,
  role: AgentRole,
  parent: Ref.nullable().optional(),
  harness: AgentHarness,
  ifGeneration: AgentGeneration.optional(),
})
export const OpsAgentGenerationBody = z.strictObject({ generation: AgentGeneration })

export type RegisterOpsAgentInput = z.input<typeof RegisterOpsAgentBody>
export type OpsAgentGenerationInput = z.input<typeof OpsAgentGenerationBody>
export type Agent = BoardEvent<'ops.agent_changed'>['payload']['agent']
export type AgentView = Agent

const IssueIntentFields = {
  verb: IntentVerb,
  run: AgentRun.optional(),
  generation: AgentGeneration,
  ttlSeconds: z.number().int().min(1).max(60),
  requestId: Ref,
}
const checkRunProbe = (input: { verb: IntentVerb; run?: AgentRun | undefined; ttlSeconds: number }, ctx: z.RefinementCtx) => {
  if (input.run === undefined) return
  if (input.verb !== 'status') ctx.addIssue({ code: 'custom', path: ['run'], message: 'only status intents can name a run' })
  if (input.ttlSeconds > 30) ctx.addIssue({ code: 'custom', path: ['ttlSeconds'], message: 'a run probe lasts at most 30 seconds' })
}
export const IssueOpsIntentBody = z.strictObject(IssueIntentFields).superRefine(checkRunProbe)
export const IssueOpsRoleIntentBody = z.strictObject({ ...IssueIntentFields, channel: ChannelPath, role: AgentRole }).superRefine(checkRunProbe)
export const ListOpsIntentsQuery = z.strictObject({ after: Ref.optional() })
export const ReportOpsIntentBody = z.strictObject({ generation: AgentGeneration, outcome: IntentOutcome })

export type IssueOpsIntentInput = z.input<typeof IssueOpsIntentBody>
export type IssueOpsRoleIntentInput = z.input<typeof IssueOpsRoleIntentBody>
export type ListOpsIntentsInput = z.input<typeof ListOpsIntentsQuery>
export type OpsIntentsIssued = { intents: AgentIntent[] }
export type OpsIntentsPage = { intents: AgentIntent[]; next: string | null }

/** Why a person is pausing or resuming the board. The authority supplies the audit author. */
export const ControlBody = z.strictObject({ reason: TaskNote })

/** A board's work admission and its pause fence. The epoch advances on each transition to paused. */
export const BoardStatus = z.object({ paused: z.boolean(), pauseEpoch: z.number().int().nonnegative() })
export type BoardStatus = z.infer<typeof BoardStatus>

export const controlRoutes = {
  /** The board's current work admission and pause epoch. */
  status: { method: 'GET', path: '/control' },
  /** Pauses work admission; requires a person with global manage. */
  pause: { method: 'POST', path: '/control/pause', body: ControlBody },
  /** Resumes work admission; requires a person with global manage. */
  resume: { method: 'POST', path: '/control/resume', body: ControlBody },
} as const

export const agentOpsRoutes = {
  listOpsAgents: { method: 'GET', path: '/ops/agents', query: ListOpsAgentsQuery },
  registerOpsAgent: { method: 'POST', path: '/ops/agents', body: RegisterOpsAgentBody },
  heartbeatOpsAgent: { method: 'POST', path: '/ops/agents/:agent/heartbeat', body: OpsAgentGenerationBody },
  retireOpsAgent: { method: 'POST', path: '/ops/agents/:agent/retire', body: OpsAgentGenerationBody },
  issueOpsIntent: { method: 'POST', path: '/ops/agents/:agent/intents', body: IssueOpsIntentBody },
  issueOpsRoleIntent: { method: 'POST', path: '/ops/intents', body: IssueOpsRoleIntentBody },
  listOpsIntents: { method: 'GET', path: '/ops/agents/:agent/intents', query: ListOpsIntentsQuery },
  takeOpsIntent: { method: 'POST', path: '/ops/intents/:id/take', body: OpsAgentGenerationBody },
  reportOpsIntent: { method: 'POST', path: '/ops/intents/:id/report', body: ReportOpsIntentBody },
  getOpsHealth: { method: 'GET', path: '/ops/health/:task' },
} as const

export const attentionRoutes = {
  requestTaskAttention: { method: 'POST', path: '/tasks/:id/attention', body: RequestAttentionBody },
  taskAttention: { method: 'GET', path: '/tasks/:id/attention' },
  answerTaskAttention: { method: 'POST', path: '/tasks/:id/attention/:requestId/answer', body: AttentionAnswerBody },
} as const

type ClaimFields = { epoch: z.ZodNumber; token: z.ZodString }

export function taskPriority(Claimed: ClaimFields) {
  /** The owner or manage sets priority; a live claim can only lower it. */
  const TaskPriorityBody = z.object({
    priority: TaskPriority,
    epoch: Claimed.epoch.optional(),
    token: Claimed.token.optional(),
  }).refine((body) => (body.epoch === undefined) === (body.token === undefined), { message: 'a claim is its `epoch` and its `token`: pass both, or neither' })
  const taskPriorityRoutes = {
    setTaskPriority: { method: 'POST', path: '/tasks/:id/priority', body: TaskPriorityBody },
  } as const
  return { TaskPriorityBody, taskPriorityRoutes }
}

export function taskAuthority(Claimed: ClaimFields) {
  const ParkTaskBody = z.strictObject({ reason: TaskNote })
  const HandoffTaskBody = TaskPacket.extend(Claimed)
  const taskAuthorityRoutes = {
    /** A verified person with manage parks or unparks a task. A park ends its claim. */
    parkTask: { method: 'POST', path: '/tasks/:id/park', body: ParkTaskBody },
    unparkTask: { method: 'POST', path: '/tasks/:id/unpark', body: ParkTaskBody },
    /** Records a packet reference and hash under a live claim; it verifies no external bytes. */
    handoffTask: { method: 'POST', path: '/tasks/:id/handoff', body: HandoffTaskBody },
  } as const
  return { ParkTaskBody, HandoffTaskBody, taskAuthorityRoutes }
}

export const INVITE_PERMISSIONS = ['read', 'post', 'react', 'label', 'sync'] as const
export const CreateInviteBody = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/, 'names start with a letter and use up to 32 letters, numbers, and hyphens'),
  can: z.record(z.string().min(1).max(CHANNEL_PATTERN_MAX), z.array(z.enum(INVITE_PERMISSIONS)).max(INVITE_PERMISSIONS.length)).optional(),
  expiresIn: z.number().int().min(1).max(604800).optional(),
})
export const RedeemInviteBody = z.strictObject({ secret: z.string().regex(/^vbi_[A-Za-z0-9_-]{43}$/) })

export type CreateInviteInput = { name: string; can?: GrantCan; expiresIn?: number }
export type InviteView = {
  id: string
  name: string
  can: Record<string, (typeof INVITE_PERMISSIONS)[number][]>
  expiresAt: string
  state: 'pending' | 'expired' | 'revoked' | 'redeemed'
}
export type CreatedInvite = { invite: InviteView; secret: string }
export type Joined = { principal: string; token: string }

export const inviteRoutes = {
  invites: { method: 'GET', path: '/invites' },
  createInvite: { method: 'POST', path: '/invites', body: CreateInviteBody },
  revokeInvite: { method: 'POST', path: '/invites/:id/revoke' },
  redeemInvite: { method: 'POST', path: '/invites/redeem', body: RedeemInviteBody },
} as const

export type { OperationalRecipient, OperationalStatus }

/** A private message and the calling principal's receipts for it. */
export type OperationalMessage = {
  id: string
  to: OperationalRecipient
  topic: string
  text: string
  by: Author
  sentAt: string
  expiresAt: string | null
  seenAt: string | null
  actedAt: string | null
  archivedAt: string | null
}

export function operationalInbox(Instant: z.ZodString) {
  const SendOperationalMessageBody = z.strictObject({
    to: OperationalRecipient,
    topic: OperationalTopic,
    text: MessageText,
    expiresAt: Instant.optional(),
  })
  const AckOperationalMessageBody = z.strictObject({ status: OperationalStatus })

  const operationalInboxRoutes = {
    /** Sends a private operational message. Requires board-wide post. */
    sendOperationalMessage: { method: 'POST', path: '/operational-inbox', body: SendOperationalMessageBody },
    /** The caller's latest active operational messages, newest first. Requires board-wide read. */
    readOperationalInbox: { method: 'GET', path: '/operational-inbox' },
    ackOperationalMessage: { method: 'POST', path: '/operational-inbox/:id/ack', body: AckOperationalMessageBody },
    archiveOperationalMessage: { method: 'POST', path: '/operational-inbox/:id/archive' },
  } as const
  return { SendOperationalMessageBody, AckOperationalMessageBody, operationalInboxRoutes }
}
