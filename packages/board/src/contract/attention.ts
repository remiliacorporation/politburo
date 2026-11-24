import { z } from 'zod'
import { Author, Ref, storable, TaskNote } from './schemas.ts'

/** A deployment's allowlist by exact channel, with `*` for all channels. It grants no channel access. */
export type AttentionResponders = Readonly<Record<string, readonly string[]>>

export const AttentionKind = z.enum(['needs_input', 'awaiting_approval'])
const Commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'commit is a full lowercase SHA-1 or SHA-256 object ID')
const OptionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'option ID must be 1–64 ASCII letters, digits, underscores or hyphens, starting with a letter or digit')
const Revision = z.number().int().positive()

/** One explicit question about the exact work and thread content the requester read. */
export const AttentionDraft = z.strictObject({
  kind: AttentionKind,
  question: TaskNote,
  context: z.string().max(4000).refine(storable, 'context has a NUL character or a lone surrogate'),
  options: z.array(z.strictObject({
    id: OptionId,
    label: TaskNote,
    consequence: TaskNote,
    next: z.enum(['resume', 'fail']),
  })).min(2).max(8).refine((options) => new Set(options.map(({ id }) => id)).size === options.length, 'option IDs must be distinct'),
  evidence: z.array(z.strictObject({ message: Ref.refine(storable), revision: Revision })).min(1).max(8),
  expiresAt: z.iso.datetime({ offset: true }),
  commit: Commit,
  revision: Revision,
})
export type AttentionDraft = z.infer<typeof AttentionDraft>

/** The CLI attaches its own claim proof; a file supplies only the draft and replacement ID. */
export const AttentionAskFile = AttentionDraft.extend({ replaces: Ref.refine(storable).optional() })

export const RequestAttentionBody = AttentionAskFile.extend({
  claim: z.strictObject({ epoch: z.number().int().positive(), token: z.string().min(1).max(128) }).optional(),
})
export type RequestAttentionBody = z.infer<typeof RequestAttentionBody>

export const AttentionAnswerBody = z.strictObject({ option: OptionId, commit: Commit })
export type AttentionAnswerBody = z.infer<typeof AttentionAnswerBody>

export const AttentionReceipt = z.strictObject({
  option: OptionId,
  by: Author,
  at: z.iso.datetime(),
  routedTo: z.enum(['ready', 'waiting', 'failed']),
})
export type AttentionReceipt = z.infer<typeof AttentionReceipt>

const ReadableAttention = AttentionDraft.extend({ id: Ref, by: Author })
export const AttentionView = z.discriminatedUnion('status', [
  ReadableAttention.extend({ status: z.enum(['pending', 'stale', 'canceled']) }),
  ReadableAttention.extend({ status: z.literal('answered'), receipt: AttentionReceipt }),
])
export type AttentionView = z.infer<typeof AttentionView>
