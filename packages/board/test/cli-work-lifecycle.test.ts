import { afterAll, beforeAll, expect, it } from 'vitest'
import { local } from '../src/backend-local/index.ts'
import { oidcTokens } from '../src/access/index.ts'
import { a2 } from '../src/server/a2.ts'
import { memory } from '../src/store/memory.ts'
import { tmp, vb } from './cli-harness.ts'
import { failure, start, until } from './cli-tasks-harness.ts'
import { board, personToken, testAuth } from './harness.ts'
import { serve } from './http.ts'

const staged = local({ memory: true, workLifecycle: { scopers: ['vercel:user:u_julian'] } })
const legacy = local({ memory: true })
const fixture = (backend: typeof staged) => board({ backend, authenticate: oidcTokens(testAuth) })
const stagedBoard = fixture(staged)
const legacyBoard = fixture(legacy)
let server: Awaited<ReturnType<typeof serve>>
let scoper: NodeJS.ProcessEnv
let worker: NodeJS.ProcessEnv
let old: NodeJS.ProcessEnv
let afterRootRead: { id: string; run: () => Promise<void> } | undefined

beforeAll(async () => {
  server = await serve(async (request) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/legacy')) return legacyBoard.fetch(request)
    const response = await stagedBoard.fetch(request)
    if (request.method === 'GET' && afterRootRead && pathname === `/api/board/messages/${afterRootRead.id}`) {
      const { run } = afterRootRead
      afterRootRead = undefined
      await run()
    }
    return response
  })
  const setup = async (path: string, user: string): Promise<NodeJS.ProcessEnv> => {
    const url = server.origin + path
    return {
      BOARD_URL: url,
      BOARD_TOKEN: await personToken(user, url),
      HOME: await tmp('board-home-'),
      XDG_CONFIG_HOME: await tmp('board-config-'),
      PATH: process.env.PATH,
    }
  }
  scoper = await setup('/api/board', 'u_julian')
  worker = await setup('/api/board', 'u_bo')
  old = await setup('/legacy', 'u_julian')
})

afterAll(async () => {
  await server.close()
  await staged.close()
  await legacy.close()
})

async function ok(args: string[], who = scoper) {
  const ran = await vb(args, who)
  expect(ran, `vb ${args.join(' ')}\n${ran.stderr}`).toMatchObject({ code: 0, stderr: '' })
  return ran.stdout.trim()
}

async function refused(args: string[], status: number, reason: string, who = scoper, exit = 1) {
  const ran = await vb([...args, '--json'], who)
  expect(ran).toMatchObject({ code: exit, stdout: '' })
  const error = failure(ran)
  expect(error).toMatchObject({ status: 'error', reason, data: { error: { status } } })
  return error
}

it('scopes and hands off work, reports its stage, and reopens it with a reason', async () => {
  const id = await ok(['tasks', 'create', 'work', 'add an export command'], worker)
  expect(await ok(['tasks', 'work'])).toMatch(/waiting\s+add an export command\s+stage proposed/)
  await refused(['tasks', 'scope', id, 'ready to start'], 403, 'permission_denied', worker)
  expect(await ok(['tasks', 'scope', id, 'ready to start'])).toBe(`scoped ${id}`)
  const bad = await refused(['tasks', 'stage', id, 'done', 'skip review'], 409, 'invalid_task_stage')
  expect(bad.next?.[0]?.argv).toEqual(['vb', 'read', id])

  await ok(['tasks', 'claim', id], worker)
  expect(await ok(['tasks', 'complete', id, 'patch is ready'], worker)).toBe(`handoff ${id}`)
  expect(await ok(['read', id])).toContain('task  handoff · waiting')
  expect(JSON.parse(await ok(['tasks', 'stage', id, 'review', 'start review', '--json']))).toMatchObject({
    outcome: 'review',
    task: { task: { work: { stage: 'review' } } },
  })

  const tail = start(['tail', 'work', '--last', '30'], scoper)
  try {
    await until(() => tail.printed.stdout.includes(`#${id}  work  task handoff to review`), 'tail to show the review move')
    expect(tail.printed.stdout).toMatch(/task handoff to review by [^\n]+ · start review/)
  } finally {
    tail.child.kill('SIGINT')
    await tail.exited
  }

  await ok(['tasks', 'stage', id, 'approved', 'review passed'])
  await ok(['tasks', 'stage', id, 'done', 'accepted'])
  await refused(['tasks', 'reopen', id], 400, 'invalid_arguments', scoper, 2)
  expect(JSON.parse(await ok(['tasks', 'reopen', id, 'add a test case', '--json']))).toMatchObject({
    outcome: 'reopened',
    task: { task: { work: { stage: 'proposed', scopedRevision: null } } },
  })
}, 40_000)

it('asks the caller to read again if staged work changes during reopen', async () => {
  const id = await ok(['tasks', 'create', 'work', 'add a print command'])
  await ok(['tasks', 'stage', id, 'rejected', 'not needed yet'])

  let edited: Awaited<ReturnType<typeof vb>> | undefined
  afterRootRead = { id, run: async () => { edited = await vb(['edit', id, 'add a print preview command'], scoper) } }
  try {
    const stale = await refused(['tasks', 'reopen', id, 'needed now'], 409, 'task_version_conflict')
    expect(edited).toMatchObject({ code: 0 })
    expect(stale.next).toMatchObject([{ when: 'Read it again before deciding whether to retry', argv: ['vb', 'read', id] }])
    const current = await ok(['read', id])
    expect(current).toContain('add a print preview command')
    expect(current).toContain('task  rejected · failed')
  } finally {
    afterRootRead = undefined
  }
})

it('releases staged work when a run fails without turning it into a rejection', async () => {
  const id = await ok(['tasks', 'create', 'run', 'try the job'])
  await ok(['tasks', 'scope', id, 'ready to start'])
  const failed = await vb(['tasks', 'run', id, '--json', '--', process.execPath, '-e', 'process.exit(7)'], scoper)
  expect(failed).toMatchObject({ code: 7, stderr: '' })
  expect(JSON.parse(failed.stdout)).toMatchObject({ outcome: 'released', code: 7, task: { task: { state: 'ready', work: { stage: 'scoped' } } } })
  expect(await ok(['tasks', 'run', id, '--', process.execPath, '-e', 'process.exit(0)'])).toBe(`handoff ${id}`)
})

it('reports that staging is unsupported on a legacy board', async () => {
  const id = await ok(['tasks', 'create', 'work', 'legacy task'], old)
  await refused(['tasks', 'scope', id, 'ready to start'], 501, 'no_work_lifecycle', old)
  expect(await ok(['tasks', 'work'], old)).toMatch(/ready\s+legacy task$/)
})

it('explains why the board refuses a staged move without an access fence', async ({ onTestFinished }) => {
  const store = { ...memory(), fence: undefined }
  onTestFinished(() => store.close())
  const backend = a2({ store, workLifecycle: { scopers: ['vercel:user:u_julian'] } })
  const team = board({ backend, authenticate: oidcTokens(testAuth) })
  const server = await serve(team.fetch)
  onTestFinished(() => server.close())
  const url = `${server.origin}/api/board`
  const who = { ...scoper, BOARD_URL: url, BOARD_TOKEN: await personToken('u_julian', url) }
  const id = await ok(['tasks', 'create', 'work', 'prepare a release'], who)
  const refused = await vb(['tasks', 'scope', id, 'ready to start'], who)
  expect(refused).toMatchObject({ code: 1, stdout: '' })
  expect(refused.stderr.split('\n')[0]).toBe(`error: Can't scope task #${id}. This board can't guard against grant changes.`)
})
