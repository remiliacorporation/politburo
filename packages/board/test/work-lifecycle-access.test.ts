import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { a2 } from '../src/server/a2.ts'
import type { Caller } from '../src/server/backend.ts'
import { createAccessFence } from '../src/store/fence.ts'
import { memory } from '../src/store/memory.ts'
import { sqlite } from '../src/store/sqlite.ts'
import type { BoardStore } from '../src/store/types.ts'
import { bearer, board, BOARD_URL, deploymentToken, personToken, testAuth, testLocal } from './harness.ts'

const ADMIN = 'vercel:user:u_admin'
const SCOPER = 'vercel:project:prj_web:production'
const FORBIDDEN = { status: 403, code: 'forbidden' }
const NO_FENCE = { status: 501, code: 'no_access_fence' }
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function openStore(kind: 'memory' | 'sqlite') {
  if (kind === 'memory') {
    const store = memory()
    closes.push(() => store.close())
    return store
  }
  const dir = await mkdtemp(join(tmpdir(), 'board-access-fence-'))
  closes.push(() => rm(dir, { recursive: true, force: true }))
  const store = sqlite({ path: join(dir, 'board.db') })
  closes.push(() => store.close())
  return store
}

async function setup(store: BoardStore, staged = true) {
  const server = a2({ store, ...(staged ? { workLifecycle: { scopers: [ADMIN, SCOPER, 'board:client'] } } : {}) })
  let afterAuth: (() => Promise<unknown>) | undefined
  let afterAccess: (() => Promise<unknown>) | undefined
  let accessReads = 0
  // board() reads request access itself, not through the binding. Pause the authenticated
  // call at the backend boundary, before the engine looks for itself.
  const authenticated = <I, T>(write: (caller: Caller, input: I, signal: AbortSignal) => Promise<T>) =>
    async (caller: Caller, input: I, signal: AbortSignal) => {
      if ('identity' in caller && caller.identity.principal.id === SCOPER && afterAuth) {
        const hook = afterAuth
        afterAuth = undefined
        await hook()
      }
      return write(caller, input, signal)
    }
  const team = board({
    backend: {
      ...server,
      scopeTask: authenticated(server.scopeTask),
      stageTask: authenticated(server.stageTask),
      reopenTask: authenticated(server.reopenTask),
      assignTask: authenticated(server.assignTask),
      setTaskNeeds: authenticated(server.setTaskNeeds),
      cancelTask: authenticated(server.cancelTask),
      bind(binding) {
        server.bind({
          ...binding,
          async accessNow(principal, grants) {
            const access = await binding.accessNow(principal, grants)
            if (principal.id === SCOPER) {
              accessReads++
              if (afterAccess) {
                const hook = afterAccess
                afterAccess = undefined
                await hook()
              }
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
  const admin = handle(adminToken)
  return {
    team, admin, scoper: handle(scoperToken),
    async grantManage() {
      const { grant } = await admin.createGrant({
        principals: [{ kind: 'project', project: 'prj_web', environments: ['production'] }],
        can: { work: ['read', 'manage'] },
      })
      return grant.id
    },
    afterAuthentication: (hook: () => Promise<unknown>) => { afterAuth = hook },
    afterDecisionAccess: (hook: () => Promise<unknown>) => { afterAccess = hook },
    decisionAccessReads: () => accessReads,
  }
}

/** Give any runnable promise continuations a turn without a timed race. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe.each(['memory', 'sqlite'] as const)('%s store', (kind) => {
  it.each(['scope', 'stage', 'reopen', 'assign', 'needs', 'cancel'] as const)('refuses %s if manage is revoked after request authentication', async (move) => {
    const ctx = await setup(await openStore(kind))
    const { admin, scoper } = ctx
    const grant = await ctx.grantManage()
    let { task: root } = await admin.tasks.create('work', 'Implement the change')
    if (move === 'reopen') root = await admin.tasks.stage(root.id, 'rejected', 'Change deferred')
    const { id, version: ifVersion } = root
    const prerequisite = move === 'needs' ? (await admin.tasks.create('work', 'Prepare the change')).task.id : ''
    const moves = {
      scope: () => scoper.tasks.scope(id, 'Scope accepted', { ifVersion }),
      stage: () => scoper.tasks.stage(id, 'rejected', 'Change deferred', { ifVersion }),
      reopen: () => scoper.tasks.reopen(id, 'Change accepted again', { ifVersion }),
      assign: () => scoper.tasks.assign(id, `${ADMIN}+worker`),
      needs: () => scoper.tasks.needs(id, [prerequisite]),
      cancel: () => scoper.tasks.cancel(id, 'Change canceled'),
    }
    ctx.afterAuthentication(async () => { expect(await admin.revokeGrant(grant)).toEqual({ revoked: true }) })
    await expect(moves[move]()).rejects.toMatchObject(FORBIDDEN)
    expect((await admin.thread(id)).message).toMatchObject({ version: ifVersion, task: root.task })
  })

  it('retries a scope when manage is revoked after the decision reads access', async () => {
    const ctx = await setup(await openStore(kind))
    const grant = await ctx.grantManage()
    const { task: root } = await ctx.admin.tasks.create('work', 'Implement the change')
    ctx.afterDecisionAccess(async () => { expect(await ctx.admin.revokeGrant(grant)).toEqual({ revoked: true }) })
    await expect(ctx.scoper.tasks.scope(root.id, 'Scope accepted', { ifVersion: root.version })).rejects.toMatchObject(FORBIDDEN)
    // The first look was still authorized. The access-head conflict must make it look once more.
    expect(ctx.decisionAccessReads()).toBe(2)
    expect((await ctx.admin.thread(root.id)).message).toMatchObject({ version: root.version, task: root.task })
  })

  it('does not let a revoke pass a staged append already inside the fence', async () => {
    const store = await openStore(kind)
    const fence = store.fence!
    const appending = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const revoking = Promise.withResolvers<void>()
    let racing = false
    const ctx = await setup({ ...store, fence: {
      access(write) {
        if (racing) revoking.resolve()
        return fence.access(write)
      },
      guarded(read, expected, write) {
        return fence.guarded(read, expected, async () => {
          appending.resolve()
          await release.promise
          return write()
        })
      },
    } })
    const grant = await ctx.grantManage()
    const { task: root } = await ctx.admin.tasks.create('work', 'Implement the change')
    const scope = ctx.scoper.tasks.scope(root.id, 'Scope accepted', { ifVersion: root.version })
    let revoke: ReturnType<typeof ctx.admin.revokeGrant> | undefined
    try {
      expect(await Promise.race([appending.promise.then(() => 'appending'), scope.then(() => 'answered')])).toBe('appending')
      racing = true
      revoke = ctx.admin.revokeGrant(grant)
      // Wait for the revoke to reach its append. If it skips the lock entirely, it answers instead.
      await Promise.race([revoking.promise, revoke])
      await nextTurn()
      expect((await ctx.admin.grants()).map(({ id }) => id)).toContain(grant)
    } finally {
      release.resolve()
      await Promise.allSettled([scope, revoke])
    }
    expect((await scope).task?.work?.stage).toBe('scoped')
    expect(await revoke).toEqual({ revoked: true })
    expect((await ctx.admin.thread(root.id)).message.task?.work?.stage).toBe('scoped')
  })

  it('refuses staged reopen without an access fence', async () => {
    const store = { ...await openStore(kind), fence: undefined }
    const { team, admin, scoper, grantManage } = await setup(store)
    await grantManage()
    const { task: root } = await admin.tasks.create('work', 'Staged task')
    // The board's fixed-access identity can make a rejected task without the fence.
    const rejected = await team.tasks.stage(root.id, 'rejected', 'Change deferred', { ifVersion: root.version })
    await expect(scoper.tasks.reopen(root.id, 'Change accepted again', { ifVersion: rejected.version })).rejects.toMatchObject(NO_FENCE)
    expect((await admin.thread(root.id)).message).toMatchObject({ version: rejected.version, task: { work: { stage: 'rejected' } } })
  })

  it('refuses scope and stage without a fence but still writes legacy tasks', async () => {
    const store = { ...await openStore(kind), fence: undefined }
    const legacy = await setup(store, false)
    const { task: old, claim } = await legacy.admin.tasks.create('work', { text: 'Legacy task', claim: true })
    await claim!.fail('Needs a retry')
    const { team, admin, scoper, grantManage } = await setup(store)
    await grantManage()
    const discovery = await scoper.discovery()
    expect(discovery.workLifecycle).toBe(1)
    expect(discovery).not.toHaveProperty('accessFence')

    const { task: root } = await admin.tasks.create('work', 'Staged task')
    const version = { ifVersion: root.version }
    await expect(scoper.tasks.scope(root.id, 'Scope accepted', version)).rejects.toMatchObject(NO_FENCE)
    await expect(scoper.tasks.stage(root.id, 'rejected', 'Change deferred', version)).rejects.toMatchObject(NO_FENCE)
    // The missing fence takes precedence even over a stale version.
    await expect(scoper.tasks.scope(root.id, 'Scope accepted', { ifVersion: 1 })).rejects.toMatchObject(NO_FENCE)
    expect((await admin.thread(root.id)).message).toMatchObject({ version: root.version, task: root.task })
    expect((await team.tasks.scope(root.id, 'Fixed access in-process', version)).task?.work?.stage).toBe('scoped')

    const reopened = await admin.tasks.reopen(old.id)
    expect(reopened.task?.work).toBeUndefined()
    expect(reopened.task?.state).toBe('ready')
    expect((await (await admin.tasks.claim(old.id)).complete()).task?.state).toBe('completed')
  })
})

describe('the access fence', () => {
  it('refuses a guarded append when the access position has moved', async () => {
    const fence = createAccessFence()
    const log: string[] = []
    await expect(fence.guarded(async () => 2, 1, async () => log.push('scoped'))).rejects.toMatchObject({ code: 'LAST_INDEX_MISMATCH' })
    expect(log).toEqual([])
  })

  it('lets a guarded append see an access append that already holds the lock', async () => {
    const fence = createAccessFence()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let position = 0
    const access = fence.access(async () => {
      started.resolve()
      await release.promise
      position++
    })
    await started.promise
    const log: string[] = []
    const guarded = Promise.allSettled([fence.guarded(async () => position, 0, async () => log.push('scoped'))])
    // Keep the access append in flight while the guarded append reaches the lock.
    await nextTurn()
    release.resolve()
    await access
    expect(await guarded).toMatchObject([{ status: 'rejected', reason: { code: 'LAST_INDEX_MISMATCH' } }])
    expect(log).toEqual([])
  })

  it('keeps serving writes after a holder throws', async () => {
    const fence = createAccessFence()
    await expect(fence.access(async () => { throw new Error('append failed') })).rejects.toThrow('append failed')
    await expect(fence.guarded(async () => 1, 1, async () => 'landed')).resolves.toBe('landed')
  })
})
