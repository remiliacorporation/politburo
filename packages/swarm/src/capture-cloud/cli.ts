import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { Book, BookError } from './book.ts'
import { validateEnvelope } from './claim.ts'
import { jsonlLedger } from './record.ts'
import { createReceiver } from './receiver.ts'

const flags = {
  book: { type: 'string' }, ledger: { type: 'string' }, port: { type: 'string' },
  'unsafe-bind-all': { type: 'boolean' }, envelope: { type: 'string' },
  'ttl-hours': { type: 'string' }, json: { type: 'boolean' },
  session: { type: 'string' },
} as const

function fail(message: string, code = 1): number {
  console.error(`error: ${message}`)
  return code
}

function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return join(canonicalPath(dirname(path)), basename(path))
  }
}

function sameFile(book: string, ledger: string): boolean {
  const a = statSync(book, { bigint: true, throwIfNoEntry: false })
  const b = statSync(ledger, { bigint: true, throwIfNoEntry: false })
  return a && b ? a.dev === b.dev && a.ino === b.ino : canonicalPath(book) === canonicalPath(ledger)
}

export async function captureCloud([action, ...args]: string[]): Promise<number> {
  const allowed = action === 'serve' ? ['ledger', 'port', 'unsafe-bind-all']
    : action === 'issue' ? ['envelope', 'ttl-hours', 'json']
    : action === 'bind' ? ['session'] : undefined
  if (!allowed) return fail('expected capture-cloud serve, issue, or bind', 2)
  let values
  try { ({ values } = parseArgs({ args, options: flags })) } catch { return fail('invalid flags', 2) }
  if (Object.keys(values).some(key => key !== 'book' && !allowed.includes(key))) return fail('invalid flags', 2)
  if (!values.book) return fail('missing --book', 2)
  if (action === 'serve' && !values.ledger) return fail('missing --ledger', 2)
  if (action === 'issue' && !values.envelope) return fail('missing --envelope', 2)
  if (action === 'bind' && !values.session) return fail('missing --session', 2)
  const port = Number(values.port ?? '8721')
  if (action === 'serve' && (!/^\d+$/.test(values.port ?? '8721') || port > 65535)) return fail('invalid --port', 2)
  const ttlMs = Number(values['ttl-hours']) * 3_600_000
  if (action === 'issue' && (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000)) {
    return fail('invalid --ttl-hours', 2)
  }

  try {
    if (action === 'serve' && sameFile(values.book, values.ledger!)) {
      return fail('book and ledger must be different files')
    }
    let capability: string | undefined
    if (action === 'bind') {
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
      try { for await (const line of lines) { capability = line; break } } finally { lines.close() }
      if (!capability) return fail('missing capability on stdin', 2)
    }
    const book = new Book({ file: values.book })
    if (action === 'issue') {
      let envelope: unknown
      try { envelope = JSON.parse(readFileSync(values.envelope!, 'utf8')) } catch { return fail('cannot read envelope json') }
      if (!validateEnvelope(envelope)) return fail('invalid envelope')
      const result = book.issue(envelope, { ttlMs })
      // Stdout is the dispatcher's capability handoff channel.
      console.log(values.json ? JSON.stringify(result) : `capability  ${result.capability}\nexpires  ${result.expiresAt}`)
    } else if (action === 'bind') {
      book.bind(capability!, values.session!)
      console.log('bound')
    } else {
      const all = values['unsafe-bind-all'] === true
      const server = await createReceiver({ book, ledger: jsonlLedger(values.ledger!),
        host: all ? '0.0.0.0' : '127.0.0.1', unsafeBind: all }).listen(port)
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          process.off('SIGINT', stop)
          process.off('SIGTERM', stop)
          server.close().then(resolve, reject)
        }
        process.on('SIGINT', stop)
        process.on('SIGTERM', stop)
        console.log(`listening  http://127.0.0.1:${server.port}`)
      })
    }
    return 0
  } catch (error) {
    return fail(error instanceof BookError ? error.message : `cannot ${action} capture-cloud`)
  }
}
