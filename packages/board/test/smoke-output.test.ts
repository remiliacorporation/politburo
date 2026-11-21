import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { hasCredential, watchServe } from './smoke-output.ts'

it.each(['exit code 7', 'still running'])('redacts partial bearer output on startup failure (%s)', async (status) => {
  const stdout = 'starting\n'
  const fragment = 'eyJfixture-fragment'
  const stderr = `Authorization: Bearer ${fragment}\n`
  const stalls = status === 'still running'
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write(${JSON.stringify(stdout)})
    process.stderr.write(${JSON.stringify(stderr)})
    ${stalls ? 'setInterval(() => {}, 1_000)' : 'process.exitCode = 7'}
  `], { env: {}, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL' })
  const server = watchServe(child)
  try {
    // Start the short deadline only once the stalled process has written its output.
    if (stalls) await Promise.race([server.closed, Promise.all([once(child.stdout, 'data'), once(child.stderr, 'data')])])
    const message = await server.waitForUrl(stalls ? 1 : 5_000).then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error.message : undefined,
    )
    // Compare predicates so a failing test can't log the bearer fragment either.
    expect(message?.includes(fragment), 'startup diagnostics must not echo the bearer fragment').toBe(false)
    const safe = `vb serve did not announce its URL (${status}; stdout length ${stdout.length}; stderr length ${stderr.length})`
    expect(message === safe, 'expected only startup status and stdout/stderr lengths').toBe(true)
  } finally {
    child.kill('SIGKILL')
    await server.closed
  }
}, 15_000)

it('ignores 43-letter temp path components but flags the same strings outside paths', () => {
  for (const component of ['a'.repeat(43), 'aB'.repeat(21) + 'A']) {
    const stdout = `file  /tmp/${component}/board-smoke-test/sam.invite\n`
    const stderr = `file  C:\\tmp\\${component}\\board-smoke-test\\sam.invite\n`
    expect(hasCredential({ stdout, stderr }), 'invite paths are not credentials').toBe(false)
    expect(hasCredential({ stdout: `claim=${component}/`, stderr }), 'a slash after a claim does not make it a path').toBe(true)
  }
})

it('flags bare claim tokens at the start, end, and next to punctuation', () => {
  for (const bytes of [16, 32]) {
    const token = Buffer.alloc(bytes, 0xff).toString('base64url')
    expect(hasCredential({ stdout: `claim  ${token}`, stderr: '' }), 'bare claim at the end of stdout').toBe(true)
    expect(hasCredential({ stdout: '', stderr: `claim  ${token}` }), 'bare claim at the end of stderr').toBe(true)
    for (const stdout of [`${token} leaked`, `(${token}),`, `"${token}"`, `claim:${token}.`, `claim=${token};`]) {
      expect(hasCredential({ stdout, stderr: '' }), 'bare claim next to a delimiter').toBe(true)
    }
  }
})

it.each(['\\n', '\\r', '\\t', '\\"', '\\\\', '\\/', '\\u2028'])('flags claims next to the JSON escape %s', (escape) => {
  const token = Buffer.alloc(32, 0xff).toString('base64url')
  const stdout = `{"message":"claim: ${token}${escape}retry"}`
  const stderr = `{"message":"claim: ${escape}${token}"}`
  expect(hasCredential({ stdout, stderr: '' }), 'claim before the escape').toBe(true)
  expect(hasCredential({ stdout: '', stderr }), 'claim after the escape').toBe(true)
})

it('ignores a 22-character OS user handle in whoami output, but not a bare claim of the same shape', () => {
  const handle = 'integrationtestbuildgw'
  const principal = `local:user:${handle}`
  const minimal = JSON.stringify({ handle })
  const whoami = JSON.stringify({ actor: principal, principal, handle, name: handle, source: 'vb serve' })
  expect(hasCredential({ stdout: minimal, stderr: '' }), 'JSON handle is not a credential').toBe(false)
  expect(hasCredential({ stdout: whoami, stderr: '' }), 'JSON identity is not a credential').toBe(false)
  expect(hasCredential({ stdout: `${handle} (${principal})\n`, stderr: '' }), 'text identity is not a credential').toBe(false)
  expect(hasCredential({ stdout: JSON.stringify({ handle, message: `claim: ${handle}` }), stderr: '' }), 'same shape in a message is a possible claim').toBe(true)
})
