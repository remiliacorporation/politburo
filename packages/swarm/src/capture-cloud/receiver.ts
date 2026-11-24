import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Book } from './book.ts'
import { contentHash, toRecord, validateClaim } from './claim.ts'
import { recordCap, tokenBucket, tokenCap } from './limits.ts'
import type { LedgerSink } from './record.ts'

type Event = 'accepted' | 'duplicate' | 'conflict' | 'rejected'
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

  function respond(req: IncomingMessage, res: ServerResponse, code: number, message: string, event: Event) {
    if (!req.complete || code === 413) res.setHeader('Connection', 'close')
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(code < 300 ? { status: message } : { error: message }))
    try { onEvent?.(event) } catch { /* Counters do not affect delivery. */ }
  }

  async function receive(req: IncomingMessage, res: ServerResponse) {
    const send = (code: number, message: string, event: Event = 'rejected') =>
      respond(req, res, code, message, event)
    function tooLarge() {
      // Flush the 413 before destroying the request's socket.
      res.once('finish', () => req.destroy())
      send(413, 'body_too_large')
    }
    function replay(hash: string, first: string) {
      if (hash === first) send(200, 'duplicate', 'duplicate')
      else send(409, 'conflict', 'conflict')
    }
    const cap = req.method === 'POST' && /^\/v1\/claims\/([^/?#]+)$/.exec(req.url ?? '')?.[1]
    if (!cap) return send(404, 'not_found')
    const globalRetry = globalLimit('global')
    if (globalRetry) {
      res.setHeader('Retry-After', globalRetry)
      return send(429, 'rate_limited')
    }
    // Charge probes before lookup, without sharing a valid capability's allowance.
    const addressRetry = addressLimit(req.socket.remoteAddress ?? '')
    const live = book.byCapability(cap, now())
    const retry = live ? capabilityLimit(cap) : addressRetry
    if (retry) {
      res.setHeader('Retry-After', retry)
      return send(429, 'rate_limited')
    }
    if (!live) return send(404, 'unknown_envelope')
    if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return send(415, 'unsupported_media_type')
    }
    if (Number(req.headers['content-length']) > maxBodyBytes) return tooLarge()
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > maxBodyBytes) return tooLarge()
      chunks.push(chunk)
    }
    const received = now()
    const entry = book.byCapability(cap, received)
    if (!entry) return send(404, 'unknown_envelope')
    let claim: unknown
    try { claim = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, 'invalid') }
    if (!validateClaim(claim)) {
      if (validateClaim.errors?.every(error => error.keyword === 'maximum')) return send(422, 'count_cap')
      return send(400, 'invalid')
    }
    if (Object.values(claim.tokens).reduce<number>((sum, count) => sum + (count ?? 0), 0) > tokenCap) {
      return send(422, 'count_cap')
    }
    const record = toRecord(claim, entry, new Date(received).toISOString())
    const key = record.dedupe_key
    const hash = contentHash(claim)
    const first = hashes.get(key)
    if (first) return replay(hash, first)
    const active = pending.get(key)
    if (active) {
      if (await active.write === 'appended') return replay(hash, active.hash)
      return send(200, 'duplicate', 'duplicate')
    }
    const budget = entry.envelope.trace.execution_id
    const count = counts.get(budget) ?? 0
    if (count >= recordCap) return send(422, 'record_cap')
    counts.set(budget, count + 1)
    let appended = false
    try {
      const write = ledger.append(record)
      pending.set(key, { hash, write })
      appended = await write === 'appended'
      // After restart or eviction the ledger can dedupe, but cannot tell us which hash won.
      if (!appended) return send(200, 'duplicate', 'duplicate')
      hashes.set(key, hash)
      const oldest = hashes.keys().next().value
      if (hashes.size > 20_000 && oldest !== undefined) hashes.delete(oldest)
      send(202, 'accepted', 'accepted')
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
      respond(req, res, 503, 'unavailable', 'rejected')
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
