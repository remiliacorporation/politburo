import { expect, it } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { caller, personToken, testBoard } from './harness.ts'

it('does not land a claim whose access was revoked during append transport', async () => {
  const store = memory()
  try {
    const board = testBoard({ store })
    const admin = caller(board.fetch, await personToken('u_admin'))
    const worker = caller(board.fetch, await personToken('u_worker'))
    const principals = [{ kind: 'user' as const, userId: 'u_worker' }]
    await board.createGrant({ principals, can: { work: ['read'] } })
    const { grant } = await board.createGrant({ principals, can: { work: ['label'] } })
    const { body } = await admin('POST', '/tasks', { channel: 'work', text: 'ready work' })
    const id = body.task.id as string
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const append = store.log.append.bind(store.log)
    store.log.append = async (session, events, options) => {
      if (events.some(({ type }) => type === 'task.claimed')) {
        reached.resolve()
        await release.promise
      }
      return append(session, events, options)
    }
    const pending = worker('POST', `/tasks/${id}/claim`, {})
    try {
      await Promise.race([reached.promise, pending.then(({ status }) => { throw new Error(`claim did not reach transport (${status})`) })])
      await board.revokeGrant(grant.id)
    } finally {
      release.resolve()
      // Settle before closing the store even if revocation threw.
      await pending
    }
    const { status, body: result } = await pending
    expect({ status, code: result.error?.code }).toEqual({ status: 409, code: 'access_changed' })
    expect((await admin('GET', `/messages/${id}`)).body.message.task.state).toBe('ready')
  } finally {
    await store.close()
  }
})
