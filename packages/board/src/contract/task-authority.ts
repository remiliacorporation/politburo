import { z } from 'zod'
import { ActorId, Author, storable, TaskNote } from './schemas.ts'

const text = (max: number) => z.string().min(1).max(max).refine(
  (value) => value.trim() === value && storable(value) && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value),
  'use nonempty text without surrounding whitespace or control characters',
)

const identityId = ActorId.refine((value) => storable(value) && !/[\s\p{Cc}]/u.test(value), 'invalid identity ID')
const ActorKey = z.strictObject({ principal: identityId, actor: identityId })

const FullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'use a full lowercase 40- or 64-digit commit SHA')

/** A claimant's assignment metadata. No field grants authority. */
export const TaskBinding = z.strictObject({
  controller: ActorKey.refine(
    ({ principal, actor }) => actor === principal || (actor.startsWith(`${principal}+`) && /^[a-z][a-z0-9-]{0,31}$/.test(actor.slice(principal.length + 1))),
    'controller actor must be its principal or one of its profiles',
  ),
  owner: ActorKey,
  provider: text(256),
  model: text(256),
  session: text(256),
  branch: text(1024),
  worktree: text(2048),
  baseCommit: FullCommit,
})
export type TaskBinding = z.infer<typeof TaskBinding>

export const TaskPark = z.object({ reason: TaskNote, by: Author, previous: z.enum(['waiting', 'ready', 'claimed']) })
export type TaskPark = z.infer<typeof TaskPark>

/** A portable, lexical repo-relative path. Never resolve it or read it at the board. */
const PacketPath = text(1024).refine(
  (value) => !/[\\:%?#*"<>|]/.test(value) && value.split('/').every((part) => part !== '' && !/[. ]$/.test(part)),
  'use a repo-relative packet path without empty or dot segments, backslashes, or drive or URL syntax',
)

const HandoffId = z.string().min(1).max(128).refine(storable, 'invalid handoff ID')
/** A claimant's description of a packet, not verification of its bytes. */
export const TaskPacket = z.strictObject({
  commit: FullCommit,
  packetPath: PacketPath,
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'use a 64-digit lowercase SHA-256'),
  supersedes: HandoffId.optional(),
})

export const TaskHandoff = TaskPacket.extend({
  id: HandoffId,
  by: Author,
  at: z.string().datetime(),
  generation: z.number().int().positive(),
})
export type TaskHandoff = z.infer<typeof TaskHandoff>
