import { z } from 'zod'
import { ActorId, Author, MessageText, storable } from './schemas.ts'

const address = ActorId.refine((value) => value.trim() !== '' && storable(value), 'expected a non-blank inbox address')
export const OperationalRecipient = z.union([z.strictObject({ agent: address }), z.strictObject({ role: address })])
export const OperationalTopic = z.string().min(1).max(256).refine((value) => value.trim() !== '' && storable(value), 'expected a non-blank topic')
export const OperationalStatus = z.enum(['seen', 'acted'])
const OperationalId = z.uuid()

export type OperationalRecipient = z.output<typeof OperationalRecipient>
export type OperationalStatus = z.output<typeof OperationalStatus>

export const operationalEvents = {
  'operational.sent': z.object({
    message: OperationalId,
    to: OperationalRecipient,
    topic: OperationalTopic,
    text: MessageText,
    by: Author,
    sentAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  }),
  'operational.acked': z.object({ message: OperationalId, status: OperationalStatus, by: Author, at: z.iso.datetime() }),
  'operational.archived': z.object({ message: OperationalId, by: Author, at: z.iso.datetime() }),
}
