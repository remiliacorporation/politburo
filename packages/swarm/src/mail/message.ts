import { block, type Board } from '@vercel/board'

export const MAIL_SCHEMA = 'swarm-message@1'
export const MAIL_CLASSES = [
  'sec.push', 'sec.retry', 'sec.retire', 'sec.log', 'spawner.dispatch',
  'spawner.decide', 'core.escalate', 'policy',
] as const
export const MAIL_URGENCIES = ['p0', 'p1', 'p2', 'p3'] as const
export const MAIL_LABELS = { class: 'swarm.class', urgency: 'swarm.urgency', state: 'swarm.state' } as const
export const MAIL_STATES = {
  open: 'open', handled: 'handled', forwarded: 'forwarded', expired: 'expired', rejected: 'rejected',
} as const

export type MailMessage = {
  id: string
  class: typeof MAIL_CLASSES[number]
  urgency: typeof MAIL_URGENCIES[number]
  from: string
  ref: string
  summary: string
  body: string
  at: string
  expires?: string
  to?: string
  dispatch?: string
}

const text = { type: 'string' }
const nonempty = { ...text, minLength: 1 }
const timestamp = { ...text, format: 'date-time' }
const required = ['id', 'class', 'urgency', 'from', 'ref', 'summary', 'body', 'at']
const properties = {
  id: { ...nonempty, maxLength: 200 },
  class: { ...text, enum: [...MAIL_CLASSES] },
  urgency: { ...text, enum: [...MAIL_URGENCIES] },
  from: nonempty,
  ref: nonempty,
  summary: { ...text, maxLength: 120 },
  body: text,
  at: timestamp,
  expires: timestamp,
  to: nonempty,
  dispatch: nonempty,
}
export const mailMessageSchema = { type: 'object', additionalProperties: false, required, properties }

export async function registerMailSchema(board: Pick<Board, 'createSchema'>) {
  await board.createSchema({
    name: 'swarm-message', version: 1, description: 'Mail for a swarm inbox.', schema: mailMessageSchema,
  })
}

const iso = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i
const destination = /^[^/\s]+\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/
const encoder = new TextEncoder()

function isInstant(value: string) {
  const match = iso.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= (days[month - 1] ?? 0)
}

export function validateMessage(value: unknown, _options: { now: Date }): string[] {
  if (!value || typeof value !== 'object') return ['invalid_message']
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return ['invalid_message']
  const fields = Object.getOwnPropertyDescriptors(value)
  const data: Record<string, string> = Object.create(null)
  const problems: string[] = []
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(properties, key)) {
      problems.push('unknown_field')
    } else {
      const field = fields[key]!
      if (!field.enumerable || typeof field.value !== 'string') problems.push(`invalid_${key}`)
      else data[key] = field.value
    }
  }
  for (const key of required) if (!Object.hasOwn(fields, key)) problems.push(`missing_${key}`)
  for (const [key, spec] of Object.entries(properties)) {
    const field = data[key]
    if (field === undefined) continue
    if (('minLength' in spec && field.length < spec.minLength) ||
        ('maxLength' in spec && [...field].length > spec.maxLength) ||
        ('enum' in spec && !(spec.enum as string[]).includes(field)) ||
        ('format' in spec && !isInstant(field))) problems.push(`invalid_${key}`)
  }
  if (data.expires !== undefined && (data.urgency === 'p0' || data.urgency === 'p1')) {
    problems.push('expiry_not_allowed')
  }
  if (data.to !== undefined && (!destination.test(data.to) || data.to.trim() !== data.to)) {
    if (!problems.includes('invalid_to')) problems.push('invalid_to')
  }
  if (encoder.encode(block(MAIL_SCHEMA, data)).byteLength > 64 * 1024) problems.push('too_large')
  return problems
}

export function labelsFor(message: MailMessage) {
  return {
    [MAIL_LABELS.class]: message.class,
    [MAIL_LABELS.urgency]: message.urgency,
    [MAIL_LABELS.state]: MAIL_STATES.open,
  }
}

export class MailError extends Error {
  readonly reason: string

  constructor(reason: string, message = reason) {
    super(message)
    this.name = 'MailError'
    this.reason = reason
  }
}
