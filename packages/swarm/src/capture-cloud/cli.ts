import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync,
  realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
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

const unsafeLedger = 'ledger path is not a safe regular file'

function usablePath(path: string, which: 'book' | 'ledger'): string {
  if (path.endsWith(sep)) throw new BookError(which === 'book' ? 'unsafe book file' : unsafeLedger)
  try {
    // Preserve the filesystem's traversal of symlinks followed by `..`.
    const dir = realpathSync.native(dirname(path))
    if (!statSync(dir).isDirectory()) throw new Error()
    accessSync(dir, constants.W_OK | constants.X_OK)
    return join(dir, basename(path))
  } catch {
    throw new BookError(`cannot use ${which} directory`)
  }
}

function deliverCapability(output: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // A failed write can also emit 'error' after invoking its callback.
    process.stdout.once('error', reject)
    process.stdout.write(`${output}\n`, error => {
      if (error) { reject(error); return }
      process.stdout.off('error', reject)
      resolve()
    })
  })
}

function openLedger(path: string): number {
  const { O_RDWR, O_CREAT, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = constants
  try {
    return openSync(path, O_RDWR | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK, 0o600)
  } catch (error) {
    if (['ELOOP', 'EISDIR', 'ENXIO'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new BookError(unsafeLedger)
    }
    throw error
  }
}

export async function captureCloud([action, ...args]: string[]): Promise<number> {
  let json = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length).includes('--json')
  const fail = (message: string, code = 1): number => {
    const safe = message.replace(/[\x00-\x1f\x7f-\x9f]/g, char =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    console.error(json ? JSON.stringify({ error: { message: safe } }) : `error: ${safe}`)
    return code
  }
  const allowed = action === 'serve' ? ['ledger', 'port', 'unsafe-bind-all']
    : action === 'issue' ? ['envelope', 'ttl-hours']
    : action === 'bind' ? ['session'] : undefined
  if (!allowed) return fail('expected capture-cloud serve, issue, or bind', 2)
  let values
  try { ({ values } = parseArgs({ args, options: flags })) } catch { return fail('invalid flags', 2) }
  json = values.json === true
  if (Object.keys(values).some(key => key !== 'book' && key !== 'json' && !allowed.includes(key))) {
    return fail('invalid flags', 2)
  }
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

  if (action === 'bind' && !/^[A-Za-z0-9_-]{8,128}$/.test(values.session!)) {
    return fail('invalid session id', 2)
  }
  if (action === 'bind' && process.stdin.isTTY) {
    return fail('capability must be piped on stdin', 2)
  }

  try {
    if (action === 'serve') {
      const bookPath = usablePath(values.book, 'book')
      const ledgerPath = usablePath(values.ledger!, 'ledger')
      const differentFiles = 'book and ledger must be different files'
      if (ledgerPath === bookPath || ledgerPath === `${bookPath}.lock`) return fail(differentFiles)
      const book = new Book({ file: bookPath })
      const fd = openLedger(ledgerPath)
      try {
        const ledgerStat = fstatSync(fd, { bigint: true })
        if (!ledgerStat.isFile() || ledgerStat.uid !== BigInt(process.getuid?.() ?? -1) ||
          (ledgerStat.mode & 0o077n)) return fail(unsafeLedger)
        const bookStat = statSync(bookPath, { bigint: true, throwIfNoEntry: false })
        if (bookStat && bookStat.dev === ledgerStat.dev && bookStat.ino === ledgerStat.ino) {
          return fail(differentFiles)
        }
        const all = values['unsafe-bind-all'] === true
        const server = await createReceiver({ book, ledger: jsonlLedger(ledgerPath, fd),
          host: all ? '0.0.0.0' : '127.0.0.1', unsafeBind: all }).listen(port)
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            process.off('SIGINT', stop)
            process.off('SIGTERM', stop)
            server.close().then(resolve, reject)
          }
          process.on('SIGINT', stop)
          process.on('SIGTERM', stop)
          const url = `http://127.0.0.1:${server.port}`
          console.log(json ? JSON.stringify({ listening: url }) : `listening  ${url}`)
        })
      } finally { closeSync(fd) }
      return 0
    }
    const book = new Book({ file: action === 'bind' ? usablePath(values.book, 'book') : values.book })
    if (action === 'issue') {
      let envelope: unknown
      try { envelope = JSON.parse(readFileSync(values.envelope!, 'utf8')) } catch { return fail('cannot read envelope json') }
      if (!validateEnvelope(envelope)) return fail('invalid envelope')
      const result = book.issue(envelope, { ttlMs })
      // Stdout is the dispatcher's capability handoff channel.
      const output = json ? JSON.stringify(result)
        : `capability  ${result.capability}\nexpires  ${result.expiresAt}`
      try { await deliverCapability(output) } catch { return fail('cannot deliver capability') }
    } else {
      let capability: string | undefined
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
      try { for await (const line of lines) { capability = line; break } } finally { lines.close() }
      if (!capability) return fail('missing capability on stdin', 2)
      book.bind(capability, values.session!)
      console.log(json ? JSON.stringify({ bound: true }) : 'bound')
    }
    return 0
  } catch (error) {
    return fail(error instanceof BookError ? error.message : `cannot ${action} capture-cloud`)
  }
}