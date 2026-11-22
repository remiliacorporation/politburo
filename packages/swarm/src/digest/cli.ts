import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { stringify } from 'yaml'
import { parseConfigText } from '../config/load.ts'
import { exceptionDigest, windowBound, type MessageHeader, type RolloutAck } from './digest.ts'
import { InputError, type MailPort } from './mail-port.ts'
import { isConfigObject, planNotices, policyId, policyNotices } from './notices.ts'

const options = {
  notices: {
    previous: { type: 'string' }, next: { type: 'string' }, version: { type: 'string' },
    mailboxes: { type: 'string' }, 'dry-run': { type: 'boolean' },
  },
  show: {
    headers: { type: 'string' }, repo: { type: 'string' }, from: { type: 'string' },
    to: { type: 'string' }, acks: { type: 'string' }, json: { type: 'boolean' },
  },
} as const

class Misuse extends Error {}

function isHeader(value: unknown): value is MessageHeader {
  if (!isConfigObject(value) || typeof value.id !== 'string') return false
  for (const key of ['createdAt', 'expires']) {
    if (typeof value[key] !== 'string' && !(key === 'expires' && value[key] === undefined)) {
      throw new InputError(`invalid ${key} for header ${JSON.stringify(value.id)}`)
    }
  }
  return ['p0', 'p1', 'p2', 'p3'].some((urgency) => urgency === value.urgency) &&
    typeof value.class === 'string' && typeof value.state === 'string' && typeof value.summary === 'string'
}

function isAck(value: unknown): value is RolloutAck {
  return isConfigObject(value) && typeof value.mailbox === 'string' &&
    (value.record === undefined || typeof value.record === 'string') &&
    Number.isSafeInteger(value.version) && typeof value.acked === 'boolean' && typeof value.noticeAt === 'string'
}

export async function run(argv: string[], {
  createMail, now = () => new Date(), read = (path) => readFile(path, 'utf8'),
  stdout = (text) => process.stdout.write(`${text}\n`), stderr = console.error,
}: {
  createMail?: () => MailPort | undefined | Promise<MailPort | undefined>
  now?: () => Date
  read?: (path: string) => Promise<string>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
} = {}): Promise<number> {
  const [action, ...args] = argv[0] === 'digest' ? argv.slice(1) : argv
  try {
    if (action !== 'notices' && action !== 'show') throw new Misuse('expected digest notices or show')
    let values: Record<string, unknown>
    try { ({ values } = parseArgs({ args, options: options[action] })) } catch {
      throw new Misuse('invalid digest options')
    }
    function required(key: string, allowEmpty = false): string {
      const value = values[key]
      if (typeof value !== 'string' || (!allowEmpty && !value)) throw new Misuse(`missing --${key}`)
      return value
    }
    async function load(path: string, label: string): Promise<unknown> {
      try { return parseConfigText(await read(path)) } catch { throw new InputError(`cannot read ${label} data`) }
    }

    if (action === 'notices') {
      const previousPath = required('previous'), nextPath = required('next'), mailboxesPath = required('mailboxes')
      const versionText = required('version'), version = Number(versionText)
      if (!/^\d+$/.test(versionText) || !Number.isSafeInteger(version) || version < 1) {
        throw new Misuse('version must be a positive integer')
      }
      const dryRun = values['dry-run'] === true
      const mail = dryRun ? undefined : await createMail?.()
      if (!dryRun && !mail) throw new Misuse('no mail transport configured')
      const previous = await load(previousPath, 'previous config')
      const next = await load(nextPath, 'next config')
      const mailboxes = await load(mailboxesPath, 'mailboxes')
      if (!isConfigObject(previous) || !isConfigObject(next)) throw new InputError('expected config objects')
      if (!isConfigObject(mailboxes)) throw new InputError('expected reader names mapped to mailbox ids')
      const { affected } = planNotices(previous, next, mailboxes)
      const result = mail && await policyNotices({ version, previous, next, mailboxes, mail })
      const sent = new Set(result?.sent)
      for (const box of affected) stdout(`${box}  ${!result ? 'would send' : sent.has(policyId(box, version)) ? 'sent' : 'already sent'}`)
    } else {
      const repo = required('repo'), from = required('from', true), to = required('to', true)
      if (!(windowBound(from, 'from') < windowBound(to, 'to'))) {
        throw new Misuse('expected a valid window with --from before --to')
      }
      const headers = await load(required('headers'), 'headers')
      const acks = typeof values.acks === 'string' ? await load(values.acks, 'ack ledger') : []
      if (!Array.isArray(headers) || !headers.every(isHeader)) throw new InputError('expected message headers')
      if (!Array.isArray(acks) || !acks.every(isAck)) throw new InputError('expected rollout ledger entries')
      const digest = exceptionDigest({ repo, window: { from, to }, headers, acks, now: now() })
      stdout(values.json ? JSON.stringify(digest) : stringify(digest).trimEnd())
    }
    return 0
  } catch (error) {
    const safe = error instanceof Misuse || error instanceof InputError
    stderr(`error: ${safe ? error.message : action === 'notices' ? 'cannot send policy notices' : 'cannot show digest'}`)
    return error instanceof Misuse ? 2 : 1
  }
}
