import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { fileClaims, memoryClaims } from '../src/cli/claims.ts'
import { vb } from '../src/cli/embedded.ts'
import { bearer, board, BOARD_URL, personToken, testAuth } from './harness.ts'

it.each(['a saved claim', 'no saved claim'])('keeps a claim saved during rejection with %s at the start', async (initial) => {
  const backend = local({ memory: true, workLifecycle: { scopers: ['vercel:user:u_julian'] } })
  try {
    const server = board({ backend, url: BOARD_URL, authenticate: oidcTokens(testAuth) })
    const fetch = bearer((input, init) => server.fetch(new Request(input, init)), await personToken('u_julian'))
    const handle = board({ backend: http(BOARD_URL, { fetch }) }).as(null)
    const claims = memoryClaims(handle, null)
    const { task: { id } } = await handle.tasks.create('work', 'add an export command')
    await handle.tasks.scope(id, 'ready to start')
    const first = await handle.tasks.claim(id)
    if (initial === 'a saved claim') await claims.put(id, { epoch: first.epoch, token: first.token, until: first.until })

    const reject = (on: typeof handle) => vb(on, ['tasks', 'stage', id, 'rejected', 'not needed yet'], { claims: () => claims })
    const rejected = { code: 0, stdout: `rejected ${id}\n`, stderr: '' }
    const racing = {
      ...handle,
      tasks: {
        ...handle.tasks,
        async stage(...args: Parameters<typeof handle.tasks.stage>) {
          const task = await handle.tasks.stage(...args)
          // Another process can reopen and claim after the rejection lands but before its response arrives.
          await handle.tasks.reopen(id, 'needed now')
          await handle.tasks.scope(id, 'ready again')
          const next = await handle.tasks.claim(id)
          await claims.put(id, { epoch: next.epoch, token: next.token, until: next.until })
          return task
        },
      },
    }
    expect(await reject(racing)).toEqual(rejected)
    expect((await claims.get(id))?.epoch).toBe(first.epoch + 1)

    // With nothing racing, rejection still removes the claim it ended.
    expect(await reject(handle)).toEqual(rejected)
    expect(await claims.get(id)).toBeNull()
  } finally {
    await backend.close()
  }
})

it('drops a claim file only when both its epoch and token match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-claims-'))
  vi.stubEnv('XDG_CONFIG_HOME', dir)
  try {
    const store = fileClaims(async () => BOARD_URL, null)
    const other = fileClaims(async () => BOARD_URL, null)
    const id = '812'
    const claim = { epoch: 2, token: 'test-claim', until: new Date(Date.now() + 60_000).toISOString() }
    const prior = { ...claim, epoch: 1 }
    await store.put(id, prior)
    const saved = (await store.get(id))!
    await other.put(id, claim)

    await store.drop(id, saved)
    expect((await other.get(id))?.epoch).toBe(claim.epoch)
    await store.drop(id, { epoch: claim.epoch, token: 'different-test-claim' })
    expect((await other.get(id))?.epoch).toBe(claim.epoch)
    await store.drop(id, claim)
    expect(await other.get(id)).toBeNull()
  } finally {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  }
})
