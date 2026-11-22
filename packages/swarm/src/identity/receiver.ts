import type { Machine, machineAuthenticator } from './machine.ts'

type ReceiverOptions = {
  authenticate: ReturnType<typeof machineAuthenticator>
  // The sink must be idempotent and accept duplicates silently, with no sender-visible outcome difference.
  accept: (record: unknown, machine: Machine) => void | Promise<void>
  maxBytes?: number
  uploadMs?: number
  maxConcurrent?: number
}

async function readRecord({ body, signal }: Request, maxBytes: number, uploadMs: number): Promise<{ record: unknown } | Response> {
  if (!body) return new Response(null, { status: 400 })
  const reader = body.getReader()
  let stopped = false
  const stop = () => {
    stopped = true
    void reader.cancel().catch(() => {})
  }
  const deadline = performance.now() + uploadMs
  const timer = setTimeout(stop, uploadMs)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    let bytes = 0
    let text = ''
    const decoder = new TextDecoder('utf-8', { fatal: true })
    while (!stopped) {
      const { done, value } = await reader.read()
      if (performance.now() >= deadline) stop()
      if (done || stopped) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {})
        return new Response(null, { status: 413 })
      }
      text += decoder.decode(value, { stream: true })
    }
    if (stopped) return Response.json({ error: { code: 'upload_timeout' } }, { status: 408 })
    const record: unknown = JSON.parse(text + decoder.decode())
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return new Response(null, { status: 400 })
    }
    return { record }
  } catch {
    void reader.cancel().catch(() => {})
    return new Response(null, { status: 400 })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    reader.releaseLock()
  }
}

export function receiver({ authenticate, accept, maxBytes = 64 * 1024, uploadMs = 10_000, maxConcurrent = 16 }: ReceiverOptions) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('invalid_max_bytes')
  if (!Number.isSafeInteger(uploadMs) || uploadMs < 1 || uploadMs > 2 ** 31 - 1) throw new TypeError('invalid_upload_ms')
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('invalid_max_concurrent')
  let inFlight = 0

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    const machine = await authenticate(request.headers)
    if (machine instanceof Response) return machine
    if (machine === null) return new Response(null, { status: 401 })
    const mediaType = request.headers.get('content-type') ?? ''
    if (!/^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(mediaType)) {
      return new Response(null, { status: 415 })
    }
    if (inFlight >= maxConcurrent) {
      return Response.json({ error: { code: 'busy' } }, { status: 503, headers: { 'Retry-After': '1' } })
    }
    inFlight++
    try {
      const result = await readRecord(request, maxBytes, uploadMs)
      if (result instanceof Response) return result
      try {
        await accept(result.record, machine)
        return new Response(null, { status: 202 })
      } catch {
        return Response.json({ error: { code: 'accept_failed' } }, { status: 500 })
      }
    } finally {
      inFlight--
    }
  }
}
