import { afterEach, expect, it } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { a2 } from '../src/server/a2.ts'
import { memory } from '../src/store/memory.ts'
import { bearer, board, BOARD_URL, deploymentToken, personToken, testAuth, testLocal } from './harness.ts'

const SCOPER = 'vercel:project:prj_web:production'
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function setup() {
  const store = memory()
  closes.push(() => store.close())
  const server = a2({ store, workLifecycle: { scopers: [SCOPER] } })
  let afterAccess: (() => Promise<unknown>) | undefined
  const team = board({
    backend: {
      ...server,
      bind(binding) {
        server.bind({
          ...binding,
          async accessNow(principal, grants) {
            const access = await binding.accessNow(principal, grants)
            if (principal.id === SCOPER && afterAccess) {
              const revoke = afterAccess
              afterAccess = undefined
              await revoke()
            }
            return access
          },
        })
      },
    },
    url: BOARD_URL,
    authenticate: oidcTokens({ ...testAuth, local: testLocal }),
  })
  const handle = (token: string) => board({
    backend: http(BOARD_URL, { fetch: bearer((input, init) => team.fetch(new Request(input, init)), token) }),
  }).as(null)
  const [adminToken, scoperToken] = await Promise.all([personToken('u_admin'), deploymentToken('web', 'prj_web')])
  return {
    admin: handle(adminToken), scoper: handle(scoperToken),
    afterScoperAccess: (revoke: () => Promise<unknown>) => { afterAccess = revoke },
  }
}

it('refuses to scope work when manage is revoked during the append decision', async () => {
  const { admin, scoper, afterScoperAccess } = await setup()
  const { grant } = await admin.createGrant({
    principals: [{ kind: 'project', project: 'prj_web', environments: ['production'] }],
    can: { work: ['read', 'manage'] },
  })
  const { task: root } = await admin.tasks.create('work', 'Implement the change')
  // Revoke after the authenticated write has read access, before it can act on that read.
  afterScoperAccess(() => admin.revokeGrant(grant.id))
  await expect(scoper.tasks.scope(root.id, 'Scope accepted', { ifVersion: root.version })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  expect((await admin.thread(root.id)).message.task?.work).toEqual({ stage: 'proposed', scopedRevision: null })
})
