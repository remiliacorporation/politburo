import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { parseOtlpLogs } from './otlp.ts'
import { reconcile } from './reconcile.ts'
import { buildGap, buildRecord, conflictSuccessor } from './record.ts'
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
}

const localHostHeader = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i

async function readLimited(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  // Don't let an early iterator return destroy the HTTP socket before the 413.
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    const bytes: Buffer = chunk
    size += bytes.length
    if (size > limit) return null
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

async function readBody(req: IncomingMessage, compressed: boolean, limit: number): Promise<Buffer | null> {
  if (Number(req.headers['content-length']) > limit) return null
  let body: Buffer | null
  try {
    body = await readLimited(req, limit)
  } finally {
    req.pause()
  }
  // Verify the wire size before inflating, and enforce the same limit on the output.
  if (body === null || !compressed) return body
  const gzip = createGunzip()
  try {
    gzip.end(body)
    return await readLimited(gzip, limit)
  } finally {
    gzip.destroy()
  }
}

export function createReceiver({
  registry, ledger, quarantine, host = '127.0.0.1', port = 0, now = () => new Date(),
  maxBodyBytes = 1_048_576, requestTimeoutMs = 10_000,
}: ReceiverOptions) {
  const localhost = host.toLowerCase() === 'localhost'
  if (!localhost && host !== '::1' && host !== '127.0.0.1') throw new Error('receiver host must be loopback')
  const counters = { accepted: 0, attributed: 0, quarantined: 0, rejected: 0, malformed: 0, conflicts: 0 }

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
      const { facts, gaps, rejected } = parseOtlpLogs(payload)
      counters.rejected += rejected
      for (const gap of gaps) {
        const envelope = registry.lookup(gap.nativeSession)
        const writer = envelope === null ? quarantine : ledger
        writer.append(buildGap(gap, envelope, now(), 'otlp'))
        if (envelope === null) counters.quarantined++
        else counters.attributed++
        counters.accepted++
      }
      for (const fact of facts) {
        const envelope = registry.lookup(fact.nativeSession)
        const [resolved] = reconcile([fact], []).records
        const record = buildRecord(resolved!, envelope, now())
        const writer = envelope === null ? quarantine : ledger
        if (writer.append(record) === 'differs') {
          const original = writer.existing(record.dedupe_key)
          if (!original) throw new Error('conflicting record has no original')
          const parent = writer.head(original.record_id)
          const result = writer.append(conflictSuccessor(parent, record, 'capture-claude receiver'))
          if (result === 'differs') throw new Error('conflict successor differs')
          if (result === 'written') counters.conflicts++
        }
        if (envelope === null) counters.quarantined++
        else counters.attributed++
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
