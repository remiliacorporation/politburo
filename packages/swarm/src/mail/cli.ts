import { parseArgs } from 'node:util'
import { board } from '@vercel/board'
import { createBridge, isSafeMailSegment } from './bridge.ts'
import { MailError } from './message.ts'

const usage = 'usage: swarm mail bridge <import|export>\n  --dir DIR --tag TAG --scope SCOPE --inbox CH [--outbox CH]'
const quote = (file: string) => JSON.stringify(file).replace(/[\x7f-\x9f\u2028\u2029]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

function fail(message: string, code: 1 | 2) {
  console.error(`error: ${message}`)
  if (code === 2) console.error(usage)
  return code
}

export async function runMail(args: string[]): Promise<number> {
  const [command, action, ...flags] = args
  if ((args.length === 1 && command === '--help') ||
      (args.length === 2 && command === 'bridge' && action === '--help')) {
    console.log(usage)
    return 0
  }
  if (command !== 'bridge' || (action !== 'import' && action !== 'export')) {
    return fail('expected mail bridge import or export', 2)
  }
  let values
  try {
    values = parseArgs({
      args: flags,
      options: {
        dir: { type: 'string' },
        tag: { type: 'string' },
        scope: { type: 'string' },
        inbox: { type: 'string' },
        outbox: { type: 'string' },
      },
    }).values
  } catch {
    return fail('invalid bridge flags', 2)
  }
  const { dir, tag, scope, inbox, outbox = 'outbox' } = values
  if (!dir || !tag || !scope?.trim() || !inbox || !outbox) {
    return fail('expected --dir, --tag, --scope and --inbox, with nonempty values', 2)
  }
  if (!isSafeMailSegment(tag)) return fail('invalid tag', 2)

  try {
    const bridge = createBridge({ board: board(), dir, tag, scope, inbox, outbox, now: () => new Date() })
    const report = action === 'import' ? await bridge.importOnce() : await bridge.exportOnce()
    if ('imported' in report) console.log(`imported  ${report.imported}`)
    else console.log(`exported  ${report.exported}`)
    console.log(`skipped   ${report.skipped}`)
    for (const { file, problems } of report.rejected) {
      console.error(`error: rejected ${quote(file)} (${problems.join(', ')})`)
    }
    const conflicts = 'conflicts' in report ? report.conflicts : []
    for (const file of conflicts) console.error(`error: conflict ${quote(file)}`)
    return report.rejected.length || conflicts.length ? 1 : 0
  } catch (error) {
    if (error instanceof MailError && error.reason === 'invalid_mail_directory') {
      return fail('mailbox path is not a real directory', 1)
    }
    if (error instanceof Error && 'code' in error && error.code === 'no_board' &&
        'status' in error && error.status === 0) return fail('no board configured', 2)
    // Board errors can carry URLs or other connection details. Do not echo them.
    return fail(`could not ${action} mail`, 1)
  }
}
