import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

export type Output = { stdout: string; stderr: string }

const CREDENTIAL = /vb[ij]_[\w-]{43}|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b|"(?:secret|token)"\s*:/
// Unprefixed base64url: local claims encode 16 bytes; the API accepts 43 characters for 32-byte claims.
// All-letter tokens are possible, so exclude path components by their preceding separator instead.
const BARE_CLAIM = /(?<![\w/\\-])(?:[\w-]{21}[AQgw]|[\w-]{43})(?![\w-])/g
const JSON_STRING = /"(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/g
const JSON_ESCAPE = /\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/g
const LOCAL_HANDLE = /^[a-z0-9][a-z0-9_-]{20}[gw]$/
const LOOPBACK_BOARD_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/board\b/

function hasBareClaim(text: string) {
  // Escapes inside JSON strings delimit tokens; backslashes in plain paths still separate components.
  const delimited = text.replace(JSON_STRING, (value) => value.replace(JSON_ESCAPE, ' '))
  for (const { 0: claim, index } of delimited.matchAll(BARE_CLAIM)) {
    if (!LOCAL_HANDLE.test(claim)) return true
    // 22-character local handles can have the same shape. Exclude only identity output.
    const before = delimited.slice(0, index)
    const after = delimited.slice(index + claim.length)
    const id = `local:user:${claim}`
    if (before.endsWith('local:user:') || after.startsWith(` (${id})`)) continue
    if (/"handle"\s*:\s*"$/.test(before) && /^(?:\/[a-z][a-z0-9-]{0,31})?"/.test(after)) continue
    if (/"name"\s*:\s*"$/.test(before) && after.startsWith('"') && (delimited.includes(`${id}"`) || delimited.includes(`${id}+`))) continue
    return true
  }
  return false
}

export function hasCredential({ stdout, stderr }: Output) {
  return [stdout, stderr].some((text) => CREDENTIAL.test(text) || hasBareClaim(text))
}

export function watchServe(child: ChildProcessByStdio<null, Readable, Readable>) {
  const output = { stdout: '', stderr: '' }
  // A failed spawn still emits close. Never include the raw error or subprocess output.
  child.once('error', () => {})
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output.stderr += chunk })
  const announced = new Promise<string>((resolve) => {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output.stdout += chunk
      const at = LOOPBACK_BOARD_URL.exec(output.stdout)?.[0]
      if (at) resolve(at)
    })
  })

  async function waitForUrl(timeoutMs: number) {
    const startup = new AbortController()
    const failure = (status: string) => new Error(
      `vb serve did not announce its URL (${status}; stdout length ${output.stdout.length}; stderr length ${output.stderr.length})`,
    )
    try {
      return await Promise.race([
        announced,
        closed.then((code) => { throw failure(`exit code ${code ?? 'unavailable'}`) }),
        delay(timeoutMs, undefined, { signal: startup.signal }).then(() => { throw failure('still running') }),
      ])
    } finally {
      startup.abort()
    }
  }

  return { child, closed, output, waitForUrl }
}
