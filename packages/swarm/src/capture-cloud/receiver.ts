import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Book, BookEntry } from './book.ts'
import { contentHash, toRecord, validateClaim } from './claim.ts'
import { recordCap, tokenBucket, tokenCap } from './limits.ts'
import { acceptOtlp, otlpBodyBytes } from './otlp.ts'
import type { LedgerSink } from './record.ts'

type Event = 'accepted' | 'duplicate' | 'conflict' | 'rejected'
export type Outcome = [code: number, message: string, event?: Event, rejectedLogRecords?: number]
export interface ReceiverOptions {
  book: Book
  ledger: LedgerSink
  now?: () => number
  host?: string
  maxBodyBytes?: number
  unsafeBind?: boolean
  onEvent?: (kind: Event) => void
}

export function createReceiver({ book, ledger, now = Date.now, host = '127.0.0.1',
  maxBodyBytes = 8192, unsafeBind, onEvent }: ReceiverOptions) {
  if (host === 'localhost') host = '127.0.0.1'
  if (!unsafeBind && host !== '127.0.0.1' && host !== '::1') throw new Error('refusing non-loopback bind')
  const globalLimit = tokenBucket(50, 100, now)
  const addressLimit = tokenBucket(5, 20, now)
  const capabilityLimit = tokenBucket(5, 20, now)
  const hashes = new Map<string, string>()
  const pending = new Map<string, { hash: string; write: ReturnType<LedgerSink['append']> }>()
  // A flood brake, not accounting: starts at zero on restart, ledger dedupe still applies.
  const counts = new Map<string, number>()

  function respond(req: IncomingMessage, res: ServerResponse, [code, message, event, rejectedLogRecords]: Outcome, otlp = false) {
    if (!req.complete || code === 413) res.setHeader('Connection', 'close')
    res.writeHead(otlp && code < 300 ? 200 : code, { 'Content-Type': 'application/json' })
    const success = !otlp ? { status: message } : rejectedLogRecords
      ? { partialSuccess: { rejectedLogRecords, errorMessage: 'rejected' } } : {}
    res.end(JSON.stringify(code < 300 ? success : { error: message }))
    if (event || code >= 400) {
      try { onEvent?.(event ?? 'rejected') } catch { /* Counters do not affect delivery. */ }
    }
  }

  async function receive(req: IncomingMessage, res: ServerResponse) {
    const cap = req.method === 'POST' && /^\/v1\/claims\/([^/?#]+)$/.exec(req.url ?? '')?.[1]
    const otlp = req.method === 'POST' && req.url === '/v1/logs'
    const send = (code: number, message: string) => respond(req, res, [code, message], otlp)
    const address = req.socket.remoteAddress ?? ''
    function limited(retry: number): Outcome {
      res.setHeader('Retry-After', retry)
      return [429, 'rate_limited']
    }
    if (!cap && !otlp) return send(404, 'not_found')
    const globalRetry = globalLimit('global').retry
    if (globalRetry) return respond(req, res, limited(globalRetry))
    if (cap) {
      // Charge probes before lookup, without sharing a valid capability's allowance.
      const addressRetry = addressLimit(address).retry
      const live = book.byCapability(cap, now())
      const retry = live ? capabilityLimit(cap).retry : addressRetry
      if (retry) return respond(req, res, limited(retry))
      if (!live) return send(404, 'unknown_envelope')
    }
    if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return send(415, 'unsupported_media_type')
    }
    function tooLarge() {
      // Flush the 413 before destroying the request's socket.
      res.once('finish', () => req.destroy())
      send(413, 'body_too_large')
    }
    const bodyCap = otlp ? otlpBodyBytes : maxBodyBytes
    if (Number(req.headers['content-length']) > bodyCap) return tooLarge()
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > bodyCap) return tooLarge()
      chunks.push(chunk)
    }
    const received = now()
    const entry = cap ? book.byCapability(cap, received) : undefined
    if (cap && !entry) return send(404, 'unknown_envelope')
    const text = Buffer.concat(chunks).toString('utf8')
    if (entry) {
      let body: unknown
      try { body = JSON.parse(text) } catch { return send(400, 'invalid') }
      return respond(req, res, await accept(body, entry, received))
    }
    const addressRetry = addressLimit(address).retry
    if (addressRetry) return respond(req, res, limited(addressRetry), true)
    const result = await acceptOtlp(text, async (sessionId, claim) => {
      const match = book.bySession(sessionId, now())
      return match ? accept(claim, match, received, `session:${sessionId}`, limited) : [404, 'unknown_envelope']
    })
    respond(req, res, result, true)
  }

  async function accept(claim: unknown, entry: Pick<BookEntry, 'envelope'>, received: number,
    sessionKey?: string, limited?: (retry: number) => Outcome): Promise<Outcome> {
    const replay = (hash: string, first: string): Outcome => hash === first
      ? [200, 'duplicate', 'duplicate'] : [409, 'conflict', 'conflict']
    if (!validateClaim(claim)) {
      if (validateClaim.errors?.every(error => error.keyword === 'maximum')) return [422, 'count_cap']
      return [400, 'invalid']
    }
    if (Object.values(claim.tokens).reduce<number>((sum, count) => sum + (count ?? 0), 0) > tokenCap) {
      return [422, 'count_cap']
    }
    const record = toRecord(claim, entry, new Date(received).toISOString())
    const key = record.dedupe_key
    const hash = contentHash(claim)
    const first = hashes.get(key)
    if (first) return replay(hash, first)
    const active = pending.get(key)
    if (active) {
      if (await active.write === 'appended') return replay(hash, active.hash)
      return [200, 'duplicate', 'duplicate']
    }
    const budget = entry.envelope.trace.execution_id
    const count = counts.get(budget) ?? 0
    if (count >= recordCap) return [422, 'record_cap']
    let debit: number | undefined
    if (sessionKey && limited) {
      const charged = capabilityLimit(sessionKey)
      if (charged.retry) return limited(charged.retry)
      debit = charged.debit
    }
    counts.set(budget, count + 1)
    let appended = false
    try {
      const write = ledger.append(record)
      pending.set(key, { hash, write })
      appended = await write === 'appended'
      // After restart or eviction the ledger can dedupe, but cannot tell us which hash won.
      if (!appended) {
        if (sessionKey) capabilityLimit.refund(sessionKey, debit)
        return [200, 'duplicate', 'duplicate']
      }
      hashes.set(key, hash)
      const oldest = hashes.keys().next().value
      if (hashes.size > 20_000 && oldest !== undefined) hashes.delete(oldest)
      return [202, 'accepted', 'accepted']
    } finally {
      pending.delete(key)
      if (!appended) {
        const reserved = counts.get(budget) ?? 1
        if (reserved > 1) counts.set(budget, reserved - 1)
        else counts.delete(budget)
      }
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    void receive(req, res).catch(() => {
      if (res.headersSent || res.destroyed) return
      respond(req, res, [503, 'unavailable'])
    })
  }
  async function listen(port: number) {
    const server = createServer({ headersTimeout: 10_000, requestTimeout: 10_000,
      connectionsCheckingInterval: 1_000 }, handle)
    server.maxHeadersCount = 32
    server.maxConnections = 256
    server.maxRequestsPerSocket = 20
    server.keepAliveTimeout = 5000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing listening port')
    return { port: address.port, close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())) }
  }
  return { handle, listen }
}