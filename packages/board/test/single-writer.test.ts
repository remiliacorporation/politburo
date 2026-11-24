import { readFileSync } from 'node:fs'
import { contract } from 'experimental-a2'
import { consumer, createServer } from 'experimental-a2/server'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { memory } from '../src/store/memory.ts'
import { singleWriter, writerFor } from '../src/store/single-writer.ts'
import { caller, personToken, testBoard } from './harness.ts'

it('runs writers in FIFO order even when the first fails', async () => {
  const writer = singleWriter()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: string[] = []
  const first = writer.run(async () => {
    order.push('first')
    entered.resolve()
    await release.promise
    order.push('failed')
    throw new Error('failed')
  })
  const refused = expect(first).rejects.toThrow('failed')
  await entered.promise
  const rest = ['second', 'third'].map((name) => writer.run(async () => { order.push(name) }))
  release.resolve()
  await refused
  await Promise.all(rest)
  expect(order).toEqual(['first', 'failed', 'second', 'third'])
})

it('lets an awaited consumer post to the board during a write turn', async () => {
  const store = memory()
  const board = testBoard({ store })
  const result = Promise.withResolvers<string>()
  const events = contract({ name: 'nested-test', events: { trigger: z.object({}) } })
  const server = createServer({ contract: events, store: store.log, consumers: [
    consumer({ contract: events, name: 'write', types: ['trigger'], lane: 'one' }).run(async () => {
      result.resolve((await board.post('work', 'from the consumer')).id)
    }),
  ] })
  try {
    await writerFor(store.log).run(async () => {
      await server.session('test').append({ type: 'trigger', payload: {} })
      const id = await result.promise
      const read = caller(board.fetch, await personToken())
      expect((await read('GET', `/messages/${id}`)).body.message.text).toBe('from the consumer')
    })
  } finally {
    await store.close()
  }
}, 2_000)

it('refuses a post revoked after authentication while middleware was pending', async () => {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const board = testBoard({ middleware: [async ({ write, next }) => {
    if (write.text === 'pending post') {
      reached.resolve()
      await release.promise
    }
    return next()
  }] })
  const principals = [{ kind: 'user' as const, userId: 'u_worker' }]
  await board.createGrant({ principals, can: { work: ['read'] } })
  const { grant } = await board.createGrant({ principals, can: { work: ['post'] } })
  const worker = caller(board.fetch, await personToken('u_worker'))
  const pending = worker('POST', '/messages', { channel: 'work', text: 'pending post' })
  try {
    await Promise.race([reached.promise, pending.then(({ status }) => { throw new Error(`post did not reach middleware (${status})`) })])
    await board.revokeGrant(grant.id)
  } finally {
    release.resolve()
  }
  expect((await pending).status).toBe(403)
  const admin = caller(board.fetch, await personToken('u_admin'))
  expect((await admin('GET', '/messages?channel=work')).body.messages).toEqual([])
})

it('keeps direct wall-clock reads out of task decisions', () => {
  const source = readFileSync(new URL('../src/server/tasks.ts', import.meta.url), 'utf8')
  expect(source.match(/\bDate\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)/g)).toBeNull()
})
