import { existsSync } from 'node:fs'
import type { A2Scheduler } from 'experimental-a2/server'
import { expect, it } from 'vitest'
import { memoryBlob } from '../../src/server/blob.ts'
import { memory } from '../../src/store/memory.ts'
import { BOARD_URL, caller as requestAs, deploymentToken, personToken } from '../harness.ts'
import { checkAccess, recordAccess } from './access-history.ts'
import { withClock } from './clock.ts'
import { handle, hostBoard } from './fixture.ts'
import { checkSeeds, type Run } from './seeds.ts'
import { Sim } from './sim.ts'

const CALLER = 'vercel:project:prj_web:production'
// Accept timers but never deliver them. E2 tests requests, not scheduled sends or expiry.
const scheduler: A2Scheduler = { async schedule() {}, handler: () => async () => new Response(null, { status: 204 }) }

async function accessRace(seed: number): Promise<Run> {
  return withClock(async () => {
    const sim = new Sim(seed)
    const store = memory({ clock: { now: () => new Date() } })
    try {
      const blob = memoryBlob()
      const history = recordAccess(store, blob, sim, CALLER)
      const host = hostBoard({ store, blob, scheduler })
      const [adminToken, token] = await Promise.all([personToken('u_admin'), deploymentToken('web', 'prj_web')])
      const admin = handle(host, adminToken)
      const worker = handle(host, token)
      const request = requestAs(host.fetch, token)
      await admin.revokeGrant('g2') // Remove the default all-projects write grant.
      const principals = [{ kind: 'project' as const, project: 'prj_web', environments: ['production' as const] }]
      await admin.createGrant({ principals, can: { '*': ['read'] } }) // Keep readable targets after revocation.
      const { grant } = await admin.createGrant({ principals, can: { '*': 'all' } })
      const post = (text: string) => request('POST', '/messages', { channel: 'work', text })
      const message = async (text: string) => {
        const result = await post(text)
        expect(result.status).toBe(201)
        return result.body.message.id as string
      }
      const root = await message('Separate target for reply, reaction, label, and receipt')
      const edit = await message('Before editing')
      const del = await message('Before deleting')
      expect((await request('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
      const target = 'slack:C1'
      expect((await request('POST', '/sync/receipts', { kind: 'thread', message: root, target, targetKind: 'channel', cause: 'request' })).status).toBe(200)
      const { task } = await worker.tasks.create('work', 'Ready to claim')
      const lease = async (verb: string) => {
        const { task } = await worker.tasks.create('work', `Ready to ${verb}`)
        return worker.tasks.claim(task.id, { lease: 60 })
      }
      const held = async (verb: string, body = {}) => {
        const { task, epoch, token } = await lease(verb)
        return () => request('POST', `/tasks/${task.id}/${verb}`, { epoch, token, ...body })
      }
      const writes = [
        ['post', 'message.posted', () => post('New post')],
        ['reply', 'message.posted', () => request('POST', '/messages', { re: root, text: 'Reply' })],
        ['react', 'reaction.added', () => request('POST', `/messages/${root}/reactions`, { emoji: 'thumbsup' })],
        ['edit', 'message.edited', () => request('POST', `/messages/${edit}/edit`, { text: 'Edited' })],
        ['delete', 'message.deleted', () => request('POST', `/messages/${del}/delete`, {})],
        ['label', 'labels.changed', () => request('POST', `/messages/${root}/labels`, { set: { dst: 'checked' } })],
        ['channel create', 'channel.created', () => request('POST', '/channels', { path: 'new-channel' })],
        ['task create', 'task.created', () => request('POST', '/tasks', { channel: 'work', text: 'New task' })],
        ['claim', 'task.claimed', () => request('POST', `/tasks/${task.id}/claim`, {})],
        ['renew', 'task.renewed', await held('renew', { lease: 120 })],
        ['complete', 'task.completed', await held('complete')],
        ['release', 'task.released', await held('release')],
        ['fail', 'task.failed', await held('fail', { reason: 'Test failure' })],
        ['schedule create', 'schedule.created', () => request('POST', '/schedules', { channel: 'work', text: 'Later', in: '1h' })],
        ['attachment', 'attachment.metadata', async () => {
          const response = await host.fetch(new Request(`${BOARD_URL}/attachments`, {
            method: 'POST', body: 'A note',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-board-filename': 'note.txt' },
          }))
          return { status: response.status, body: await response.json() }
        }],
        ['sync receipt', 'message.synced', () => request('POST', '/sync/receipts', {
          kind: 'message', message: root, target, external: { thread: 'slack:C1:1', message: '1' },
        })],
      ] as const
      const outcomes: { op: number; name: string; status: number; event: string }[] = []
      await sim.run([
        ...writes.map(([name, event, run], op) => ({ name, run: async () => {
          const { status, body } = await run()
          const code: string | undefined = body?.error?.code
          if (!(status >= 200 && status < 300) && status !== 403 && status !== 409) throw new Error(`${name}: unexpected ${status} ${code}`)
          outcomes.push({ op, name, status, event })
          return `${status}${code ? ` ${code}` : ''}`
        } })),
        { name: 'revoke', run: async () => {
          expect(await admin.revokeGrant(grant.id)).toEqual({ revoked: true })
          return 'ok'
        } },
        { name: 'pause', run: async () => {
          const pause = () => admin.pause('Stop admitting work')
          const result = await pause().catch((error: unknown) => {
            // A concurrent access-log change can invalidate the operator's suspended turn too.
            if ((error as { code?: string }).code !== 'access_changed') throw error
            return pause()
          })
          expect(result).toMatchObject({ paused: true })
          return 'ok'
        } },
      ])
      return { violations: checkAccess(history, outcomes, grant.id, CALLER), trace: sim.trace }
    } finally {
      await store.close()
    }
  })
}

const enabled = process.env.DST_EXPECT === 'e2' || existsSync(new URL('../../src/store/single-writer.ts', import.meta.url))
it.skipIf(!enabled)('E2: revocation fences off every write (I3)', async () => { await checkSeeds(accessRace, 50) }, 120_000)
