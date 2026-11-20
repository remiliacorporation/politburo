import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { capacity } from '../src/index.ts'

const limits = { worker: 2, build: 1, qa: 1, review: 1 }

test('each kind has its own limit, and releasing one reservation makes one place', async () => {
  const pool = capacity({ limits })
  for (const kind of ['worker', 'build', 'qa', 'review'] as const) {
    const requests = await Promise.all(Array.from({ length: limits[kind] + 1 }, () => pool.tryReserve({ kind })))
    const held = requests.filter((reservation) => reservation !== null)
    assert.equal(held.length, limits[kind], kind)
    const [first] = held
    await first!.release()
    assert.ok(await pool.tryReserve({ kind }), kind)
    await first!.release()
    assert.equal(await pool.tryReserve({ kind }), null, kind)
    // Leave each kind full while testing that the next kind can still run.
  }
})

test('heavy work shares machine slots across kinds and processes without blocking light work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-slots-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const options = { limits, heavy: { slots: 2, directory } }
  const pool = capacity(options)
  const build = await pool.tryReserve({ kind: 'build', heavy: true })
  const qa = await pool.tryReserve({ kind: 'qa', heavy: true })
  assert.ok(build && qa)
  assert.equal(await pool.tryReserve({ kind: 'review', heavy: true }), null)
  const light = await pool.tryReserve({ kind: 'review' })
  assert.ok(light)
  await light.release()

  async function otherProcess() {
    const entry = new URL('../src/index.ts', import.meta.url).href
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { capacity } from ${JSON.stringify(entry)}
      const pool = capacity(${JSON.stringify(options)})
      const reservation = await pool.tryReserve({ kind: 'review', heavy: true })
      if (reservation) await reservation.release()
      console.log(reservation ? 'reserved' : 'unavailable')
    `], { timeout: 5_000 })
    return stdout.trim()
  }
  assert.equal(await otherProcess(), 'unavailable')
  await build.release()
  assert.equal(await otherProcess(), 'reserved')
  await qa.release()
})
