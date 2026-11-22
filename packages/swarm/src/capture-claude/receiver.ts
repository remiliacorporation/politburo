import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIPv4 } from 'node:net'
import { createGunzip } from 'node:zlib'
import { parseOtlpLogs } from './otlp.ts'
import { reconcile } from './reconcile.ts'
import { buildRecord } from './record.ts'
import type { SessionRegistry } from './registry.ts'
import type { SpendWriter } from './writer.ts'

interface ReceiverOptions {
  registry: Pick<SessionRegistry, 'lookup'>
  ledger: SpendWriter
  quarantine: SpendWriter
  host?: string
  port?: number
  now?: () => Date
  maxBodyBytes?: number
  requestTimeoutMs?: number
  allowRemote?: boolean
}

const localHostHeader = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i

async function readBody(req: IncomingMessage, compressed: boolean, limit: number): Promise<Buffer | null> {
  if (!compressed && Number(req.headers['content-length']) > limit) return null
  const gzip = compressed ? createGunzip() : null
  if (gzip) {
    req.once('error', (error) => gzip.destroy(error))
    req.pipe(gzip)
  }
  const stream = gzip ?? req
  const chunks: Buffer[] = []
  let size = 0
  try {
    // Don't let an early iterator return destroy the HTTP socket before the 413.
    for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
      const bytes: Buffer = chunk
      size += bytes.length
      if (size > limit) return null
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  } finally {
    if (gzip) {
      req.unpipe(gzip)
      gzip.destroy()
    }
    req.pause()
  }
}

export function createReceiver({
  registry, ledger, quarantine, host = '127.0.0.1', port = 0, now = () => new Date(),
  maxBodyBytes = 1_048_576, requestTimeoutMs = 10_000, allowRemote = false,
}: ReceiverOptions) {
  const localhost = host.toLowerCase() === 'localhost'
  const loopback = localhost || host === '::1' || (isIPv4(host) && host.startsWith('127.'))
  if (!loopback && !allowRemote) throw new Error('receiver host must be loopback')
  const counters = { accepted: 0, attributed: 0, quarantined: 0, rejected: 0, malformed: 0 }

  async function receive(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: string) => {
      if (status === 400) counters.malformed++
      if (!req.readableEnded) res.setHeader('Connection', 'close')
      res.writeHead(status, { 'Content-Type': status === 200 ? 'application/json' : 'text/plain' })
      res.end(body)
    }
    if (req.headersDistinct.host?.length !== 1 || !localHostHeader.test(req.headers.host ?? '')) {
      return reply(403, 'forbidden host')
    }
    if (req.url !== '/v1/logs') return reply(404, 'not found')
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return reply(405, 'method not allowed')
    }
    const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (type === 'application/x-protobuf') return reply(415, 'set OTEL_EXPORTER_OTLP_PROTOCOL=http/json')
    if (type !== 'application/json') return reply(415, 'expected application/json')
    const encoding = req.headers['content-encoding']?.trim().toLowerCase() ?? 'identity'
    if (encoding !== 'identity' && encoding !== 'gzip') return reply(415, 'unsupported content encoding')

    let payload: unknown
    try {
      const body = await readBody(req, encoding === 'gzip', maxBodyBytes)
      if (body === null) return reply(413, 'body too large')
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    } catch {
      // The HTTP server sends its own 408 and closes timed-out uploads.
      if (!req.socket.destroyed) return reply(400, 'invalid body')
      return
    }

    try {
      const { facts, rejected } = parseOtlpLogs(payload)
      counters.rejected += rejected
      for (const fact of facts) {
        const envelope = registry.lookup(fact.nativeSession)
        const [resolved] = reconcile([fact], []).records
        const record = buildRecord(resolved!, envelope, now())
        // Keep the session reversible even when it contains a path separator.
        const session = fact.nativeSession.replace(/%/g, '%25').replace(/\//g, '%2F')
        record.evidence_ref = `claude/${session}/${fact.requestId ?? fact.responseId}`
        if (envelope === null) {
          quarantine.append(record)
          counters.quarantined++
        } else {
          ledger.append(record)
          counters.attributed++
        }
        // A deduped append is also a successful durable acceptance.
        counters.accepted++
      }
    } catch {
      return reply(500, 'ingress write failed')
    }
    reply(200, '{}')
  }

  const server = createServer({
    requestTimeout: requestTimeoutMs,
    headersTimeout: requestTimeoutMs,
    connectionsCheckingInterval: Math.min(requestTimeoutMs, 1_000),
  }, receive)
  return {
    listen: () => new Promise<{ host: string; port: number }>((resolve, reject) => {
      server.once('error', reject)
      // Pin localhost to a loopback address rather than relying on its resolver entry.
      server.listen(port, localhost ? '127.0.0.1' : host, () => {
        server.off('error', reject)
        const address = server.address()
        if (address && typeof address !== 'string') resolve({ host: address.address, port: address.port })
        else reject(new Error('receiver has no TCP address'))
      })
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
    counters,
  }
}
