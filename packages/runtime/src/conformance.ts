import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { ReplayConflict, type Harness, type RunEvent, type RunRef, type Start } from './harness.ts'

export type ConformanceFixture = {
  interactive: boolean
  /** Every fixture emits `ready\n`. Successful interactive fixtures echo sends and exit on `finish\n`.
   * Successful noninteractive fixtures also emit `finished\n`. A hang fixture stays alive until stopped. */
  open(mode: 'success' | 'hang', wallMs: number): { harness: Harness; input: Start } | Promise<{ harness: Harness; input: Start }>
}

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  const end = performance.now() + 5_000
  do {
    const value = await check()
    if (value !== undefined) return value
    await sleep(10)
  } while (performance.now() < end)
  throw new Error('timed out waiting for harness')
}

const terminal = (harness: Harness, run: RunRef) => until(async () => {
  const result = await harness.collect(run)
  return result === 'not_terminal' ? undefined : result
})
const text = (events: readonly RunEvent[]) => events.map((event) => event.text).join('')

/** Register adapter-independent behavioral tests with Node's test runner. */
export function harnessConformance(name: string, { open, interactive }: ConformanceFixture) {
  test(`${name}: identical starts return one run; changed starts conflict`, async (t) => {
    const { harness, input } = await open('hang', 6_000)
    const first = await harness.start(input)
    t.after(() => harness.cancel(first))
    assert.equal(await harness.start(structuredClone(input)), first)
    await assert.rejects(harness.start({ ...input, work: { ...input.work, repo: 'acme/other' } }), ReplayConflict)
    assert.equal(await harness.start(input), first)
  })

  test(`${name}: sends replay, ordered cursor pages don't skip output, and terminal results stay fixed`, async (t) => {
    const { harness, input } = await open('success', 6_000)
    const run = await harness.start(input)
    t.after(() => harness.cancel(run))
    await until(async () => text((await harness.observe(run, { limit: 100 })).events).includes('ready\n') || undefined)
    const ping = { id: 'ping', text: 'ping\n' }
    const outcome = interactive ? 'accepted' : 'unsupported'
    assert.equal(await harness.send(run, ping), outcome)
    assert.equal(await harness.send(run, { ...ping }), outcome)
    await assert.rejects(harness.send(run, { ...ping, text: 'different\n' }), ReplayConflict)
    if (interactive) assert.equal(await harness.send(run, { id: 'finish', text: 'finish\n' }), 'accepted')
    const result = await terminal(harness, run)
    assert.equal(result.outcome, 'exited')
    assert.equal(result.exitCode, 0)
    const all = await harness.observe(run, { limit: 100 })
    assert.equal(all.state, 'exited')
    assert.equal(text(all.events), interactive ? 'ready\nping\n' : 'ready\nfinished\n')
    const pages: RunEvent[] = []
    let after: string | undefined
    for (let i = 0; i <= all.events.length; i++) {
      const page = await harness.observe(run, { after, limit: 1 })
      if (i < all.events.length) assert.equal(page.events.length, 1)
      else assert.deepEqual(page.events, [])
      pages.push(...page.events)
      after = page.cursor
    }
    assert.deepEqual(pages, all.events)
    assert.equal(after, all.cursor)
    assert.equal(await harness.send(run, { id: 'late', text: 'late\n' }), interactive ? 'not_running' : 'unsupported')
    assert.equal(await harness.send(run, ping), outcome)
    assert.equal(await harness.start(input), run)
    await harness.cancel(run)
    assert.deepEqual(await harness.collect(run), result)
    assert.deepEqual(await harness.observe(run, { limit: 100 }), all)
  })

  test(`${name}: collect is nonterminal before stop and canceled after confirmation`, async (t) => {
    const { harness, input } = await open('hang', 6_000)
    const run = await harness.start(input)
    t.after(() => harness.cancel(run))
    await until(async () => text((await harness.observe(run, { limit: 100 })).events).includes('ready\n') || undefined)
    assert.equal(await harness.collect(run), 'not_terminal')
    await harness.cancel(run)
    assert.deepEqual(await terminal(harness, run), { outcome: 'canceled', artifacts: [], usage: null })
    assert.equal((await harness.observe(run, { limit: 1 })).state, 'canceled')
    await harness.cancel(run)
    assert.equal((await terminal(harness, run)).outcome, 'canceled')
  })

  test(`${name}: the wall limit fails a hung run with timeout`, async (t) => {
    const { harness, input } = await open('hang', 350)
    const run = await harness.start(input)
    t.after(() => harness.cancel(run))
    assert.deepEqual(await terminal(harness, run), { outcome: 'failed', failure: 'timeout', artifacts: [], usage: null })
    assert.equal((await harness.observe(run, { limit: 1 })).state, 'failed')
  })
}
