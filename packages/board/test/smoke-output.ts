import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

export type Output = { stdout: string; stderr: string }

const CREDENTIAL = /vb[ij]_[\w-]{43}|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b|"(?:secret|token)"\s*:/
// Local claims encode 16 bytes (ending in A, Q, g, or w); supplied and Vercel claims use 43 characters.
// A base64url string next to a slash or backslash is a path component, not a bare token.
const BARE_CLAIM = /(?<![\w/\\-])(?:[\w-]{21}[AQgw]|[\w-]{43})(?![\w/\\-])/
const LOOPBACK_BOARD_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/board\b/

export function hasCredential({ stdout, stderr }: Output) {
  return [stdout, stderr].some((text) => CREDENTIAL.test(text) || BARE_CLAIM.test(text))
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
