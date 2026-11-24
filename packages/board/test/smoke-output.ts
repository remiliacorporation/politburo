import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

export type Output = { stdout: string; stderr: string }

const CREDENTIAL = /vb[ij]_[\w-]{43}|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b|"(?:secret|token)"\s*:/
const LOOPBACK_BOARD_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/board\b/

export function createLeakCheck() {
  const tracked = new Map<string, { escaped: string; source: string }>()
  const history: { source: string; text: string }[] = []

  function credentialIn(text: string) {
    for (const [secret, { escaped, source }] of tracked) {
      if (text.includes(secret) || text.includes(escaped)) return { source, length: secret.length }
    }
    const match = CREDENTIAL.exec(text)
    if (match) return { source: 'credential pattern', length: match[0].length }
  }

  return {
    track(secret: string, source = 'tracked secret') {
      if (secret.length < 8) return false
      if (!tracked.has(secret)) tracked.set(secret, { escaped: JSON.stringify(secret).slice(1, -1), source })
      return true
    },
    hasCredential(text: string) {
      return credentialIn(text) !== undefined
    },
    capture(source: string, text: string) {
      history.push({ source, text })
    },
    findLeak() {
      // A credential can be learned after the command that printed it has exited.
      for (const { source, text } of history) {
        const match = credentialIn(text)
        if (match) return `${source} (length ${text.length}) matched ${match.source} (length ${match.length})`
      }
    },
  }
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
