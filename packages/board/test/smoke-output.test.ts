import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { createLeakCheck, watchServe } from './smoke-output.ts'

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

const claim = 'fixture-claim-value'

it.each([
  ['before a JSON newline escape', `{"message":"claim: ${claim}\\nretry"}`],
  ['after a slash', `/tmp/${claim}/file`],
  ['after a backslash', `C:\\tmp\\${claim}\\file`],
  ['adjacent to hyphens', `x-${claim}-y`],
  ['adjacent to underscores', `x_${claim}_y`],
  ['inside a local principal', `local:user:${claim}`],
  ['inside a JSON handle', JSON.stringify({ handle: claim })],
  ['inside a JSON name', JSON.stringify({ name: claim })],
])('flags a tracked claim %s', (_label, text) => {
  const check = createLeakCheck()
  check.track(claim)
  expect(check.hasCredential(text)).toBe(true)
})

it('flags a JSON-escaped secret without requiring the raw string to appear', () => {
  const secret = 'fixture"\\\u0000value'
  const text = JSON.stringify({ message: secret })
  const check = createLeakCheck()
  check.track(secret)
  expect(text.includes(secret)).toBe(false)
  expect(check.hasCredential(text)).toBe(true)
})

const component = 'a'.repeat(43)
const handle = 'integrationtestbuildgw'
const principal = `local:user:${handle}`

it.each([
  ['a TMPDIR path', `/tmp/${component}/board-smoke-test/sam.invite`],
  ['a Windows path', `C:\\tmp\\${component}\\board-smoke-test\\sam.invite`],
  ['a JSON path with escaped slashes', `{"file":"\\/tmp\\/${component}\\/sam.invite"}`],
  ['a whoami JSON handle', JSON.stringify({ actor: principal, principal, handle, name: handle, source: 'vb serve' })],
  ['an untracked claim-shaped word', `message: ${component}`],
])('does not guess credentials in %s', (_label, text) => {
  const check = createLeakCheck()
  check.track(claim)
  expect(check.hasCredential(text)).toBe(false)
})

it('ignores empty and short secrets', () => {
  const check = createLeakCheck()
  check.track('')
  check.track('shorter')
  expect(check.hasCredential('a shorter message')).toBe(false)
})

it.each([
  ['an invite prefix', `vbi_${component}`],
  ['a join prefix', `vbj_${component}`],
  ['a JWT', 'eyJfixture.payload.signature'],
  ['a secret key', '{"secret":"fixture"}'],
  ['a token key', '{"token" : "fixture"}'],
])('still flags %s without a tracked secret', (_label, text) => {
  expect(createLeakCheck().hasCredential(text)).toBe(true)
})

it('checks previously captured output when it learns another secret', () => {
  const check = createLeakCheck()
  const text = `path  /${claim}/report`
  check.capture('CLI stdout', 'task claimed')
  check.capture('server stderr', text)
  expect(check.findLeak()).toBeUndefined()

  check.track(claim, 'claim file')
  check.track('another-fixture', 'invite file')
  expect(check.findLeak()).toBe(`server stderr (length ${text.length}) matched claim file (length ${claim.length})`)
})
