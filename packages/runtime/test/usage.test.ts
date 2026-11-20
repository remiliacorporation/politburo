import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { localUsage, usageGuard } from '../src/index.ts'

const fiveHours = 5 * 60 * 60 * 1_000

test('the guard blocks at 95% until reset, then checks the next window', async () => {
  const resetAt = Date.UTC(2026, 0, 1, 5)
  let now = resetAt - 1
  let window = { usedFraction: 0.9499, resetAt }
  const guard = usageGuard({ read: () => window }, { now: () => now })
  assert.deepEqual(await guard.check(), { allowed: true })
  window = { ...window, usedFraction: 0.95 }
  assert.deepEqual(await guard.check(), { allowed: false, resetAt })
  window = { ...window, usedFraction: 1 }
  assert.deepEqual(await guard.check(), { allowed: false, resetAt })
  now = resetAt
  assert.deepEqual(await guard.check(), { allowed: true })
  window = { usedFraction: 0.98, resetAt: resetAt + fiveHours }
  assert.deepEqual(await guard.check(), { allowed: false, resetAt: window.resetAt })
})

test('the file source reads updates and rejects malformed usage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-usage-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const file = join(dir, 'usage.json')
  const source = localUsage({ file })
  const window = { usedFraction: 0.42, resetAt: Date.UTC(2026, 0, 1, 5) }
  await writeFile(file, JSON.stringify(window))
  assert.deepEqual(await source.read(), window)
  const next = { usedFraction: 0.96, resetAt: window.resetAt + fiveHours }
  await writeFile(file, JSON.stringify(next))
  assert.deepEqual(await source.read(), next)
  for (const invalid of ['{', '{}', JSON.stringify({ ...window, usedFraction: '0.42' }),
    JSON.stringify({ ...window, resetAt: -1 })]) {
    await writeFile(file, invalid)
    await assert.rejects(async () => source.read(), TypeError)
  }
})

test('the command source reads stdout JSON only on a successful exit', async () => {
  const window = { usedFraction: 0.70, resetAt: Date.UTC(2026, 0, 1, 5) }
  for (const code of [0, 1]) {
    const source = localUsage({
      command: process.execPath,
      args: ['-e', 'console.log(process.argv[1]); process.exitCode = Number(process.argv[2])', JSON.stringify(window), String(code)],
    })
    if (code === 0) assert.deepEqual(await source.read(), window)
    else await assert.rejects(async () => source.read())
  }
})
