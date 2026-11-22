export {
  MAIL_CLASSES, MAIL_LABELS, MAIL_SCHEMA, MAIL_STATES, MAIL_URGENCIES, MailError,
  labelsFor, mailMessageSchema, registerMailSchema, validateMessage, type MailMessage,
} from './message.ts'
export { sendMail } from './send.ts'
export { createInbox, type InboxOptions, type OpenMail } from './inbox.ts'
export { createRelay, type RelayOptions, type RelayReport } from './relay.ts'
