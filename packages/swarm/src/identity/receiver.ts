import type { Machine, machineAuthenticator } from './machine.ts'

type ReceiverOptions = {
  authenticate: ReturnType<typeof machineAuthenticator>
  accept: (record: unknown, machine: Machine) => void | Promise<void>
  maxBytes?: number
}

async function readRecord(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ record: unknown } | Response> {
  if (!body) return new Response(null, { status: 400 })
  const reader = body.getReader()
  try {
    let bytes = 0
    let text = ''
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {})
        return new Response(null, { status: 413 })
      }
      text += decoder.decode(value, { stream: true })
    }
    const record: unknown = JSON.parse(text + decoder.decode())
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return new Response(null, { status: 400 })
    }
    return { record }
  } catch {
    void reader.cancel().catch(() => {})
    return new Response(null, { status: 400 })
  } finally {
    reader.releaseLock()
  }
}

export function receiver({ authenticate, accept, maxBytes = 64 * 1024 }: ReceiverOptions) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('invalid_max_bytes')

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    const machine = await authenticate(request.headers)
    if (machine instanceof Response) return machine
    if (machine === null) return new Response(null, { status: 401 })
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') return new Response(null, { status: 415 })
    const result = await readRecord(request.body, maxBytes)
    if (result instanceof Response) return result
    try {
      await accept(result.record, machine)
      return new Response(null, { status: 202 })
    } catch {
      return Response.json({ error: { code: 'accept_failed' } }, { status: 500 })
    }
  }
}
