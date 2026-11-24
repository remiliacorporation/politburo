export class InputError extends Error {}

export function checkMailbox(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new InputError('invalid mailbox id: expected 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit')
  }
}

export type Urgency = 'p0' | 'p1' | 'p2' | 'p3'

export type MailMessage = {
  id: string
  mailbox: string
  class: string
  urgency: Urgency
  text: string
  block?: { schema: string; data: unknown }
}

export interface MailPort {
  /** A retry with the same id returns existing without creating a second message. */
  post(msg: MailMessage): Promise<{ landed: 'new' | 'existing' }>
}

// STUB until WP-201 lands
export function memoryMail(): MailPort & { messages: readonly MailMessage[] } {
  const messages = new Map<string, MailMessage>()
  return {
    get messages() { return [...messages.values()].map((msg) => structuredClone(msg)) },
    async post(msg) {
      if (messages.has(msg.id)) return { landed: 'existing' }
      messages.set(msg.id, structuredClone(msg))
      return { landed: 'new' }
    },
  }
}
