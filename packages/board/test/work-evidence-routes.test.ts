import { expect, it, vi } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { local } from '../src/backend-local/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { HttpError } from '../src/server/index.ts'
import { board, BOARD_URL, caller, personToken, testAuth, testBoard } from './harness.ts'

const commit = 'a'.repeat(40)
const mount = new URL(BOARD_URL).pathname
const reviewer = 'vercel:user:u_reviewer'
const policy = { attesters: { tests: [reviewer], review: [reviewer] }, resolvers: [reviewer], releaseDependencies: true }

const client = (host: Pick<ReturnType<typeof board>, 'fetch'>, user: string) => board({
  backend: http(BOARD_URL, {
    async fetch(input, init) {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== mount) request.headers.set('authorization', `Bearer ${await personToken(`u_${user}`)}`)
      return host.fetch(request)
    },
  }),
}).as(null)

it('does not follow a 307 from evidence completion to legacy completion', async () => {
  const legacy = testBoard()
  const advertised = testBoard({ workEvidence: policy })
  let legacyCompletions = 0
  const worker = client({
    async fetch(request) {
      const path = new URL(request.url).pathname.slice(mount.length)
      if (path === '') return advertised.fetch(request)
      if (/^\/work\/v1\/tasks\/[^/]+\/complete-with-evidence$/.test(path)) {
        const location = `${BOARD_URL}${path.replace('/work/v1', '').replace('complete-with-evidence', 'complete')}`
        const redirect = Response.redirect(location, 307)
        if (request.redirect === 'manual') return redirect
        request = new Request(location, { method: request.method, headers: request.headers, body: await request.text() })
      }
      if (/\/tasks\/[^/]+\/complete$/.test(new URL(request.url).pathname)) {
        legacyCompletions++
        // A legacy completion endpoint strips fields it does not know.
        const { commit: _ignored, ...body } = await request.json()
        request = new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body) })
      }
      return legacy.fetch(request)
    },
  }, 'worker')
  const { task } = await worker.tasks.create('work', 'Build the patch')
  const claim = await worker.tasks.claim(task.id)
  await expect.soft(claim.complete(undefined, { commit })).rejects.toMatchObject({
    status: 502, code: 'remote_error', origin: 'handle', message: expect.stringMatching(/redirected a completion with work evidence/i),
    hint: expect.stringContaining('final URL'),
  })
  expect.soft((await worker.thread(task.id)).message.task?.state).toBe('claimed')
  expect(legacyCompletions).toBe(0)
})

it.each(['HTTP', 'in-process'])('refuses evidence completion on a legacy backend via %s', async (transport) => {
  const base = local({ memory: true })
  const { workEvidence, submitWork, recordEvidence, overrideEvidence, resolveWorkEdge, ...backend } = base
  const completeTask = vi.fn<typeof backend.completeTask>((who, { commit: _ignored, ...input }, signal) => backend.completeTask(who, input, signal))
  const host = board({ backend: { ...backend, completeTask }, authenticate: oidcTokens(testAuth), url: BOARD_URL })
  try {
    const worker = transport === 'HTTP' ? client(host, 'worker') : host
    const { task } = await worker.tasks.create('work', 'Build the patch')
    const claim = await worker.tasks.claim(task.id)
    if (transport === 'HTTP') {
      const send = caller(host.fetch, await personToken('u_worker'))
      expect.soft(await send('POST', `/work/v1/tasks/${task.id}/complete-with-evidence`, { epoch: claim.epoch, token: claim.token, commit })).toMatchObject({
        status: 501, body: { error: { code: 'no_work_evidence' } },
      })
    } else {
      await expect.soft(claim.complete(undefined, { commit })).rejects.toMatchObject({ status: 501, code: 'no_work_evidence' })
    }
    expect.soft((await worker.thread(task.id)).message.task?.state).toBe('claimed')
    expect(completeTask).not.toHaveBeenCalled()
  } finally {
    await base.close()
  }
})

it.each(['passed', 'failed', 'skipped'])('reports gated release conformance as %s on a board with gates and explicit releases', async (status) => {
  const base = local({ memory: true, workEvidence: policy })
  const backend = status === 'failed' ? {
    ...base,
    async resolveWorkEdge() {
      throw new HttpError(501, 'no_work_evidence', 'explicit release is not implemented')
    },
  } : base
  const host = board({ backend, authenticate: oidcTokens(testAuth), url: BOARD_URL })
  try {
    const options = status === 'skipped' ? {} : { workEvidence: { second: client(host, 'reviewer') } }
    const report = await conformance(client(host, 'worker'), options)
    const check = { group: 'work-evidence', name: 'releases a dependency explicitly after gated completion', status }
    const target = report.checks.find(({ name }) => name === check.name)
    expect(target).toMatchObject(check)
    if (status === 'skipped') expect(target?.detail).toContain('workEvidence.second')
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual(status === 'failed' ? [expect.objectContaining({
      ...check, detail: expect.stringContaining('explicit release is not implemented'),
    })] : [])
    expect(report.ok).toBe(status !== 'failed')
  } finally {
    await base.close()
  }
}, 20_000)

it('fails gated release conformance when resolve claims ready without storing the release', async () => {
  const base = local({ memory: true, workEvidence: policy })
  const backend = {
    ...base,
    async resolveWorkEdge(who, { id }, signal) {
      const { message: task } = await base.message(who, { id }, signal)
      if (!task.task) throw new Error('expected a task')
      return { task: { ...task, task: { ...task.task, state: 'ready' } } }
    },
  } satisfies typeof base
  const host = board({ backend, authenticate: oidcTokens(testAuth), url: BOARD_URL })
  try {
    const report = await conformance(client(host, 'worker'), { workEvidence: { second: client(host, 'reviewer') } })
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([expect.objectContaining({
      group: 'work-evidence', name: 'releases a dependency explicitly after gated completion',
      // The missing release would also fail the check, so assert that the re-read caught it first.
      detail: expect.stringContaining('the dependent re-read after explicit release: expected "ready", got "waiting"'),
    })])
    expect(report.ok).toBe(false)
  } finally {
    await base.close()
  }
}, 20_000)
