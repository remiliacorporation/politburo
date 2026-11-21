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

it('ignores 43-letter temp path components but flags bare claim tokens at the end of output', () => {
  const component = 'a'.repeat(43)
  const stdout = `file  /tmp/${component}/board-smoke-test/sam.invite\n`
  const stderr = `file  C:\\tmp\\${component}\\board-smoke-test\\sam.invite\n`
  expect(hasCredential({ stdout, stderr }), 'invite paths are not credentials').toBe(false)

  for (const bytes of [16, 32]) {
    const token = Buffer.alloc(bytes, 0xff).toString('base64url')
    expect(hasCredential({ stdout: stdout + token, stderr }), 'bare claim on stdout').toBe(true)
    expect(hasCredential({ stdout, stderr: stderr + token }), 'bare claim on stderr').toBe(true)
  }
})
