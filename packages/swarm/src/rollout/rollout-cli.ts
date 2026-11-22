import { parseArgs } from 'node:util'
import { openLedger } from './ledger.ts'

const usage = `usage: swarm rollout <add|notify|ack|stale|show> [--dir D] [--json]
  add --subject S --version V --audience a,b,c [--summary TEXT]
  notify|ack --subject S --version V --recipient R
  stale [--subject S] [--version V]
  show [--subject S]
  --dir defaults to SWARM_ROLLOUT_DIR; stale exits 0 even with stale recipients.
  writes use a lock directory beside the ledger on a local filesystem.
  a killed writer never leaves the ledger permanently locked.`

const options = {
  dir: { type: 'string' },
  json: { type: 'boolean' },
  subject: { type: 'string' },
  version: { type: 'string' },
  audience: { type: 'string' },
  summary: { type: 'string' },
  recipient: { type: 'string' },
} as const

const fields = {
  add: ['subject', 'version', 'audience', 'summary'],
  notify: ['subject', 'version', 'recipient'],
  ack: ['subject', 'version', 'recipient'],
  stale: ['subject', 'version'],
  show: ['subject'],
} satisfies Record<string, (keyof typeof options)[]>

function printFailure(message: string, code: 1 | 2, json: boolean): number {
  if (json) {
    console.error(JSON.stringify({ status: 'error', reason: code === 2 ? 'misuse' : 'rollout_failed', message }))
    return code
  }
  const safe = message.replace(/[\p{Cc}\u2028\u2029]/gu, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  console.error(`error: ${safe}`)
  if (code === 2) console.error(usage)
  return code
}

export function rolloutMain(args: string[]): number {
  const [action, ...flags] = args
  const fail = (message: string, code: 1 | 2) => printFailure(message, code, flags.includes('--json'))
  if (action === '--help' && !flags.length) {
    console.log(usage)
    return 0
  }
  if (action !== 'add' && action !== 'notify' && action !== 'ack' && action !== 'stale' && action !== 'show') {
    return fail(action === undefined ? 'missing rollout command' : `unknown rollout command ${action}`, 2)
  }
  let values
  try {
    ;({ values } = parseArgs({ args: flags, options, strict: true }))
  } catch (error) {
    return fail((error as Error).message.replace(/^./, (letter) => letter.toLowerCase()), 2)
  }
  const allowed: string[] = fields[action]
  for (const flag of Object.keys(values)) {
    if (flag !== 'dir' && flag !== 'json' && !allowed.includes(flag)) return fail(`unexpected --${flag}`, 2)
  }
  const dir = values.dir ?? process.env.SWARM_ROLLOUT_DIR
  if (!dir) return fail('missing --dir or SWARM_ROLLOUT_DIR', 2)

  const { subject, version, audience, summary, recipient, json } = values
  const ledger = openLedger(dir)
  const output = (data: object, text: () => void) => json ? console.log(JSON.stringify(data)) : text()
  try {
    if (action === 'stale') {
      const stale = ledger.stale({ subject, version })
      output({ stale }, () => {
        for (const row of stale) console.log(`${row.subject}  ${row.version}  ${row.recipient}  ${row.state}`)
      })
    } else if (action === 'show') {
      const entries = ledger.show({ subject })
      output({ entries }, () => {
        for (const [index, entry] of entries.entries()) {
          if (index) console.log('')
          console.log(`${entry.subject}  ${entry.version}`)
          for (const row of entry.recipients) console.log(`  ${row.recipient}  ${row.state}`)
        }
      })
    } else {
      if (subject === undefined) return fail('missing --subject', 2)
      if (version === undefined) return fail('missing --version', 2)
      if (action === 'add') {
        if (audience === undefined) return fail('missing --audience', 2)
        const { entry, added } = ledger.addEntryWithOutcome({ subject, version, audience: audience.split(','), summary })
        output({ entry, added }, () => console.log(`${added ? 'added' : 'exists'} ${subject} ${version}`))
      } else {
        if (recipient === undefined) return fail('missing --recipient', 2)
        const record = ledger[action]({ subject, version, recipient })
        const verb = action === 'notify' ? 'notified' : 'acked'
        output({ [record.type]: record }, () => console.log(`${verb} ${subject} ${version} ${recipient}`))
      }
    }
    return 0
  } catch (error) {
    return fail((error as Error).message, 1)
  }
}
